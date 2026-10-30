import { launch } from '@xmcl/core';
import type { ChildProcess } from 'child_process';
import type { CrashInfo, DownloadProgress, GameOutput, LaunchConfig } from '@shared/types';
import { getLocalSkinForLaunch, resolveLaunchUser } from '../auth';
import { getSettings } from '../settings/store';
import { getMinecraftVersionOf, getRequiredJavaMajor, getVersionGameDir, getVersionResourceRoot, repairVersion } from '../versions';
import { detectJava, pickBestJava, readJavaInfo } from '../java/detector';
import { authlibInjectorArgs, ensureAuthlibInjector } from './authlibInjector';
import { startLocalSkinServer, type LocalSkinServer } from './skinServer';
import { ensureGameOptions } from './gameOptions';
import { beginSession, clearSession, endSession, recordOutput, recordSpawnError } from './crash';

let currentProcess: ChildProcess | null = null;
/** Set when the user asked to stop the game, so the exit is not reported as a crash. */
let killRequested = false;
/**
 * Loopback Yggdrasil server serving the offline account's skin. Lives only as long
 * as the game does.
 */
let skinServer: LocalSkinServer | null = null;
/** Exit code reported when the process could not be spawned at all. */
const SPAWN_FAILED_CODE = -1;

/** Stop the loopback skin server, if one is running. */
function stopSkinServer(): void {
  if (!skinServer) return;
  try {
    skinServer.close();
  } catch {
    /* already closed */
  }
  skinServer = null;
}

export function isRunning(): boolean {
  return currentProcess !== null && !currentProcess.killed;
}

/**
 * Resolve the Java executable to launch with.
 * `mode`/`manualPath` come from the per-version override when present, otherwise
 * from the global launcher settings.
 */
async function resolveLaunchJavaPath(
  required: number,
  mode: 'auto' | 'manual',
  manualPath: string,
): Promise<string> {
  if (mode === 'manual') {
    if (!manualPath) {
      throw new Error(
        '已设为手动选择 Java,但未指定 Java 路径。\n请在「游戏设置 → Java 运行时」中选择,或在「版本管理 → 启动设置」中为该版本单独指定。',
      );
    }
    return manualPath;
  }
  // auto: pick the best matching installed Java for this Minecraft version.
  const list = await detectJava();
  if (list.length === 0) {
    throw new Error('未检测到任何 Java。请在「游戏设置 → Java 运行时」中安装,或使用一键安装。');
  }
  const best = pickBestJava(list, required);
  if (!best) throw new Error('未检测到合适的 Java 版本');
  return best.path;
}

const MAX_MEMORY_LIMIT = 65536;

export async function startGame(
  config: LaunchConfig,
  onOutput: (o: GameOutput) => void,
  onProgress?: (p: DownloadProgress) => void,
  onCrash?: (info: CrashInfo) => void,
): Promise<void> {
  if (isRunning()) throw new Error('游戏已在运行中');

  const settings = getSettings();
  // The version may live in any of the scanned game folders — launch against its own root.
  const resourcePath = getVersionResourceRoot(config.version);
  // Game directory is determined by the version's isolation flag.
  const gamePath = getVersionGameDir(config.version);

  // Per-version overrides (版本管理 → 启动设置) win over the global settings.
  const override = settings.versionOverrides?.[config.version];
  const javaMode: 'auto' | 'manual' = override?.javaMode === 'manual' ? 'manual' : settings.javaSelection;
  const manualJavaPath =
    override?.javaMode === 'manual' ? override.javaPath : config.javaPath || settings.javaPath;
  const rawMaxMemory = override?.memoryMode === 'custom' ? override.maxMemory : config.maxMemory;
  const maxMemory = Math.min(Math.max(Math.round(rawMaxMemory) || 4096, 512), MAX_MEMORY_LIMIT);
  const minMemory = Math.min(config.minMemory, maxMemory);

  // Ensure missing/corrupt natives + libraries are present before launching, so
  // imports from other launchers (e.g. PCL) that lack native jars still work.
  await repairVersion(config.version, onProgress ?? (() => {}));

  // A fresh isolated game dir would otherwise show Minecraft's accessibility
  // onboarding screen, which starts narrating ("Press Enter to enable the narrator").
  ensureGameOptions(gamePath);

  // Resolve the Java runtime (auto-match or manual), then validate compatibility.
  // The required major comes from the version JSON's `javaVersion.majorVersion`
  // (authoritative), so newer versions needing Java 25 are handled correctly.
  const mcVersion = getMinecraftVersionOf(config.version);
  const required = getRequiredJavaMajor(config.version);
  const javaPath = await resolveLaunchJavaPath(required, javaMode, manualJavaPath);

  const javaInfo = await readJavaInfo(javaPath);
  if (javaInfo && javaInfo.major > 0) {
    if (required <= 8 && javaInfo.major !== 8) {
      throw new Error(
        `版本 ${config.version}(MC ${mcVersion})需要 Java 8 才能运行,但当前使用的是 Java ${javaInfo.major}。\n` +
          `请在「游戏设置 → Java 运行时」中安装 Java 8,或在「版本管理 → 启动设置」中为它单独指定 Java 8。`,
      );
    }
    if (required >= 17 && javaInfo.major < required) {
      throw new Error(
        `版本 ${config.version}(MC ${mcVersion})需要 Java ${required} 或更高版本才能运行,但当前使用的是 Java ${javaInfo.major}。\n` +
          `请在「游戏设置 → Java 运行时」中安装 Java ${required},或在「版本管理 → 启动设置」中为它单独指定 Java。`,
      );
    }
  }

  const launchUser = await resolveLaunchUser(config.accountId);
  const accountType = settings.accounts.find((a) => a.id === config.accountId)?.type;
  const extraJVMArgs = config.jvmArgs ? config.jvmArgs.split(/\s+/).filter(Boolean) : [];

  // Skins come from one of two places:
  //
  //   - LittleSkin accounts: authlib-injector pointed at LittleSkin's Yggdrasil, so
  //     the client resolves skins from that server.
  //   - Offline accounts: no session server exists at all, so the client would show
  //     Steve. We run a loopback Yggdrasil server that answers the profile lookup
  //     with the skin the user picked, and point authlib-injector at it.
  //
  // Microsoft accounts need neither: their skin is on Mojang's servers already.
  if (launchUser.authlibInjector) {
    try {
      const jar = await ensureAuthlibInjector();
      extraJVMArgs.push(...authlibInjectorArgs(jar, launchUser.authlibInjector.apiRoot));
    } catch (e) {
      // Don't block single-player: warn and continue without the skin agent.
      const reason = e instanceof Error ? e.message : String(e);
      onOutput({ type: 'error', text: `[SLCL] 警告:${reason}。本次将以无 LittleSkin 皮肤的模式启动。` });
    }
  } else if (accountType === 'offline') {
    // Offline accounts only. A Microsoft account's skin is already on Mojang's
    // servers, and worse, injecting authlib-injector there would redirect its
    // session-server calls too — breaking online-mode multiplayer logins. A
    // leftover local skin file (from a failed upload) must not trigger that.
    const localSkin = getLocalSkinForLaunch(config.accountId);
    if (localSkin) {
      try {
        skinServer = await startLocalSkinServer({
          uuid: launchUser.uuid,
          name: launchUser.name,
          png: localSkin.png,
          variant: localSkin.variant,
        });
        const jar = await ensureAuthlibInjector();
        extraJVMArgs.push(
          `-Dauthlibinjector.yggdrasil.prefetched=${skinServer.prefetchedMetadata}`,
        );
        extraJVMArgs.push(...authlibInjectorArgs(jar, skinServer.apiRoot));
      } catch (e) {
        // A missing skin must never stop the game from starting.
        stopSkinServer();
        const reason = e instanceof Error ? e.message : String(e);
        onOutput({ type: 'error', text: `[SLCL] 警告:${reason}。本次将以默认皮肤启动。` });
      }
    }
  }

  let proc: ChildProcess;
  try {
    proc = await launch({
      gamePath,
      resourcePath,
      javaPath,
      version: config.version,
      gameProfile: { id: launchUser.uuid, name: launchUser.name },
      accessToken: launchUser.accessToken,
      ...(launchUser.userType === 'legacy' ? { userType: 'legacy' as const } : {}),
      maxMemory,
      minMemory,
      resolution: {
        width: config.resolution.width,
        height: config.resolution.height,
        fullscreen: config.fullscreen,
      },
      extraJVMArgs,
      launcherName: 'SLCL',
      launcherBrand: 'SLATT Client',
    });
  } catch (e) {
    // `launch()` can throw before any process exists (bad classpath, missing jar).
    // Without this the skin server would stay bound to its port forever.
    stopSkinServer();
    throw e;
  }

  // Start recording *after* the process exists, but before any output arrives.
  // The crash detector needs the launch wall-clock time to find the matching
  // crash report / log, so the session must begin as early as possible.
  beginSession(config.version, gamePath, resourcePath);

  currentProcess = proc;
  const emit = (o: GameOutput): void => {
    recordOutput(o);
    onOutput(o);
  };

  /**
   * Run the crash detector once per session and forward the result.
   * `endSession` clears the session, so a second call (e.g. 'error' followed by
   * 'exit') returns null and never produces a duplicate dialog.
   */
  const diagnose = (code: number | null): void => {
    try {
      const info = endSession(code);
      if (info && onCrash) onCrash(info);
    } catch {
      // Never let diagnostics break the launch lifecycle.
      clearSession();
    }
  };

  proc.stdout?.on('data', (d: Buffer) => emit({ type: 'stdout', text: d.toString() }));
  proc.stderr?.on('data', (d: Buffer) => emit({ type: 'stderr', text: d.toString() }));
  proc.on('error', (e: Error) => {
    // A process that never spawned only emits 'error' — Node does NOT emit 'exit'
    // for ENOENT/EACCES. Diagnose here too, otherwise a dead Java path would leave
    // the UI stuck on "游戏运行中…" with no crash dialog.
    recordSpawnError(e.message);
    emit({ type: 'error', text: e.message });
    currentProcess = null;
    stopSkinServer();
    if (killRequested) {
      killRequested = false;
      clearSession();
      return;
    }
    // Negative code tells the UI this was a launch failure, not a normal quit.
    emit({ type: 'exit', code: SPAWN_FAILED_CODE });
    diagnose(null);
  });
  proc.on('exit', (code) => {
    currentProcess = null;
    // The game is gone, so nothing can query the loopback server any more.
    stopSkinServer();
    emit({ type: 'exit', code: code ?? 0 });
    // A user-initiated stop is not a crash, whatever exit code Windows reports.
    if (killRequested) {
      killRequested = false;
      clearSession();
      return;
    }
    diagnose(code ?? 0);
  });
}

export function killGame(): void {
  if (currentProcess) {
    killRequested = true;
    try {
      currentProcess.kill();
    } catch {
      /* ignore */
    }
    currentProcess = null;
    stopSkinServer();
    clearSession();
  }
}

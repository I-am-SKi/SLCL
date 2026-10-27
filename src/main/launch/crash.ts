/**
 * Game crash detection and diagnosis.
 *
 * Why this exists: when Minecraft fails to start, users get a wall of Java stack
 * traces. The launcher can do much better than "游戏已退出, code=1" — it can read
 * the log it already captured plus the crash report Minecraft writes to disk, then
 * name the likely cause (missing dependency, wrong mod version, mod conflict,
 * wrong Java, out of memory, broken graphics driver…) and offer the log and a
 * shareable report.
 *
 * Detection is deliberately conservative: a normal quit must never raise the
 * crash dialog. Minecraft logs `Stopping!` on a clean shutdown and exits 0, so
 * both signals are checked before a session counts as crashed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import type { CrashDiagnosis, CrashFinding, CrashInfo, GameOutput } from '@shared/types';

/** How many output lines to keep per session (enough for any startup failure). */
const MAX_LINES = 4000;

/** Markers that mean "the game shut down the normal way". */
const CLEAN_EXIT_MARKERS = ['[Render thread/INFO]: Stopping!', 'Stopping!'];

/**
 * Lines that indicate a fatal failure even when the process exited with code 0.
 * Minecraft sometimes reports a crash and still exits 0.
 */
const FATAL_MARKERS = [
  'UnsupportedClassVersionError',
  'OutOfMemoryError',
  'Mixin apply failed',
  'MixinTransformerError',
  'Failed to create window',
  'Pixel format not accelerated',
  'GLFW error',
  'java.lang.NoSuchMethodError',
  'java.lang.NoClassDefFoundError',
  'java.lang.NoSuchFieldError',
  'Invalid or corrupt jarfile',
  'Could not find or load main class',
  'Missing or unsupported mandatory dependencies',
  'Duplicate mods found',
  'Incompatible mod set detected',
  'A fatal error has been detected by the Java Runtime Environment',
];

interface Session {
  versionId: string;
  gamePath: string;
  resourcePath: string;
  startedAt: number;
  lines: string[];
  /** Set when the main process could not even spawn the game. */
  spawnError?: string;
}

let session: Session | null = null;
/** The most recent failure, kept so the dialog's export button has something to write. */
let lastCrash: CrashInfo | null = null;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function beginSession(versionId: string, gamePath: string, resourcePath: string): void {
  session = { versionId, gamePath, resourcePath, startedAt: Date.now(), lines: [] };
}

export function recordOutput(o: GameOutput): void {
  if (!session) return;
  if (o.type === 'exit') return;
  if (!o.text) return;
  // Split so each physical line is one entry; the console shows them individually.
  for (const line of o.text.split(/\r?\n/)) {
    if (!line) continue;
    session.lines.push(line);
  }
  if (session.lines.length > MAX_LINES) {
    session.lines.splice(0, session.lines.length - MAX_LINES);
  }
}

export function recordSpawnError(message: string): void {
  if (session) session.spawnError = message;
}

export function getLastCrash(): CrashInfo | null {
  return lastCrash;
}

export function clearSession(): void {
  session = null;
}

// ---------------------------------------------------------------------------
// Reading files Minecraft wrote
// ---------------------------------------------------------------------------

/**
 * Minecraft puts `logs/` and `crash-reports/` either at the game root (shared
 * install) or inside `versions/<name>/` (version-isolated install). SLCL forces
 * isolation, so both layouts must be checked.
 */
function logDirs(gamePath: string, versionId: string): string[] {
  return [join(gamePath, 'versions', versionId), gamePath].filter(
    (d, i, arr) => arr.indexOf(d) === i && existsSync(d),
  );
}

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Newest `crash-reports/crash-*.txt` that appeared during this session. */
function findCrashReport(gamePath: string, versionId: string, since: number): string | null {
  let newest: { file: string; mtime: number } | null = null;
  for (const dir of logDirs(gamePath, versionId)) {
    const crashDir = join(dir, 'crash-reports');
    if (!existsSync(crashDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(crashDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^crash-.*\.txt$/i.test(name)) continue;
      const file = join(crashDir, name);
      let mtime: number;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      // Allow a 5s grace window: the clock granularity and file flush can lag.
      if (mtime < since - 5000) continue;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
  }
  return newest?.file ?? null;
}

/** `logs/latest.log` belonging to this session (newest across both layouts). */
function findLatestLog(gamePath: string, versionId: string, since: number): string | null {
  let newest: { file: string; mtime: number } | null = null;
  for (const dir of logDirs(gamePath, versionId)) {
    const file = join(dir, 'logs', 'latest.log');
    if (!existsSync(file)) continue;
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < since - 5000) continue;
    if (!newest || mtime > newest.mtime) newest = { file, mtime };
  }
  return newest?.file ?? null;
}

// ---------------------------------------------------------------------------
// Diagnosis rules
// ---------------------------------------------------------------------------

/** class-file major version -> required Java version. */
const CLASS_FILE_JAVA: Record<number, number> = {
  52: 8,
  53: 9,
  54: 10,
  55: 11,
  56: 12,
  57: 13,
  58: 14,
  59: 15,
  60: 16,
  61: 17,
  62: 18,
  63: 19,
  64: 20,
  65: 21,
  66: 22,
  67: 23,
  68: 24,
  69: 25,
};

/** Packages that belong to the platform, not to a mod. Used to spot the culprit. */
const PLATFORM_PACKAGE_PREFIXES = [
  'java.',
  'javax.',
  'jdk.',
  'sun.',
  'net.minecraft.',
  'net.minecraftforge.',
  'net.neoforged.',
  'net.fabricmc.',
  'cpw.mods.',
  'com.mojang.',
  'org.spongepowered.',
  'org.apache.',
  'io.netty.',
  'com.google.',
  'org.lwjgl.',
  'it.unimi.',
  'org.objectweb.',
];

/** Pull the first `Caused by:` chain and the top of the primary stack. */
function extractException(text: string): { first: string; lines: string[] } {
  const lines = text.split(/\r?\n/);
  const first =
    lines.find((l) => /^(java|javax|net|org|com|io|kotlin|scala)\.[\w.$]+(Exception|Error)\b/.test(l.trim())) ??
    lines.find((l) => /\bException|\bError\b/.test(l) && !l.includes('at ')) ??
    '';
  return { first: first.trim(), lines };
}

/** Package prefixes from stack frames that do not belong to the platform. */
function suspectPackages(text: string, limit = 5): string[] {
  const out: string[] = [];
  const re = /at\s+(?:knot\/\/)?([a-z][\w$]*(?:\.[\w$]+)+)\.[\w$<>]+\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const fq = m[1];
    if (PLATFORM_PACKAGE_PREFIXES.some((p) => fq.startsWith(p))) continue;
    // Trim to the first three segments: enough to name the mod, not a whole class.
    const pkg = fq.split('.').slice(0, 3).join('.');
    if (!out.includes(pkg)) out.push(pkg);
    if (out.length >= limit) break;
  }
  return out;
}

/** Mod ids named in a Forge/NeoForge "missing dependencies" block. */
function missingDeps(text: string): Array<{ mod: string; wantedBy: string }> {
  const out: Array<{ mod: string; wantedBy: string }> = [];
  const re = /Mod ID:\s*'([^']+)',\s*Requested by:\s*'([^']+)'/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ mod: m[1], wantedBy: m[2] });
    if (out.length >= 12) break;
  }
  return out;
}

/** Fabric style: `Mod 'x' requires version y of mod z` / `requires any version of`. */
function fabricMissingDeps(text: string): Array<{ mod: string; wantedBy: string }> {
  const out: Array<{ mod: string; wantedBy: string }> = [];
  const patterns = [
    // Handles "version 0.5.0 or later of mod 'fabric-api'" as well as plain "version ^1.0 of".
    /Mod\s+'([^']+)'\s+requires\s+(?:version\s+[^'\n]*?\s+of|any\s+version\s+of)\s+(?:mod\s+)?'?([^'\s,]+)'?/gi,
    /mod\s+'?([^'\s,]+)'?\s+requires\s+(?:version\s+[^'\n]*?\s+of|any\s+version\s+of)\s+(?:mod\s+)?'?([^'\s,]+)'?/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Guard against the second pattern double-reporting the first pattern's hit.
      if (!out.some((d) => d.mod === m![2] && d.wantedBy === m![1])) {
        out.push({ mod: m[2], wantedBy: m[1] });
      }
      if (out.length >= 12) break;
    }
  }
  return out;
}

function classFileJava(text: string): number | null {
  const m = /class file version (\d+)/i.exec(text);
  if (!m) return null;
  const major = Number(m[1]);
  return CLASS_FILE_JAVA[major] ?? null;
}

/** Read the count of loaded mods from a crash report's mod list, if present. */
function loadedModCount(text: string): number | null {
  const fabric = /Fabric Mods:\s*\n([\s\S]*?)(?:\n\t[A-Z]|\n-- |$)/i.exec(text);
  if (fabric) {
    const n = fabric[1].split(/\r?\n/).filter((l) => /^\t\t[\w-]+:/.test(l)).length;
    if (n > 0) return n;
  }
  const forge = /FML:\s*\n([\s\S]*?)(?:\n-- |$)/i.exec(text);
  if (forge) {
    const n = forge[1].split(/\r?\n/).filter((l) => /^\t\t[\w-]+:/.test(l)).length;
    if (n > 0) return n;
  }
  return null;
}

/**
 * Turn raw log text into a human diagnosis.
 *
 * Rules are ordered from most specific to most generic; the first hit wins, and
 * lower-confidence observations are still appended as extra findings so the
 * dialog can show everything relevant.
 */
export function diagnose(input: {
  logText: string;
  crashReport: string | null;
  exitCode: number | null;
  versionId: string;
  javaMajor?: number | null;
}): CrashDiagnosis {
  // The crash report is the authoritative document; the log fills the gaps.
  const primary = input.crashReport ?? input.logText;
  const combined = `${input.crashReport ?? ''}\n${input.logText}`;
  const findings: CrashFinding[] = [];
  const { first } = extractException(primary);

  const push = (f: CrashFinding): void => {
    if (!findings.some((x) => x.id === f.id)) findings.push(f);
  };

  // ---- 1. Java version too old -------------------------------------------
  const cfJava = classFileJava(combined);
  if (cfJava !== null || /UnsupportedClassVersionError/i.test(combined)) {
    const needs = cfJava ?? null;
    push({
      id: 'java-too-old',
      severity: 'error',
      title: needs ? `Java 版本过低（需要 Java ${needs} 或更高）` : 'Java 版本过低',
      detail: needs
        ? `某个模组或游戏本体是用 Java ${needs} 编译的，但当前启动使用的 Java 版本更旧，无法加载它的 class 文件。`
        : '游戏或模组需要的 Java 版本高于本次启动所用的版本。',
      action: needs
        ? `在「游戏设置 → Java 运行时」安装 Java ${needs}，再为这个版本指定正确的 Java。`
        : '在「游戏设置 → Java 运行时」安装更高的 Java 版本，或检查版本是否被单独指定了错误的 Java。',
    });
  }

  // ---- 2. Out of memory ---------------------------------------------------
  if (/OutOfMemoryError/i.test(combined)) {
    const heap = /OutOfMemoryError:\s*Java heap space/i.test(combined);
    const metaspace = /OutOfMemoryError:\s*Metaspace/i.test(combined);
    push({
      id: 'out-of-memory',
      severity: 'error',
      title: heap ? '内存不足（Java 堆溢出）' : metaspace ? '元空间不足（模组过多）' : '内存不足',
      detail: heap
        ? '分配给游戏的堆内存用完了，通常是整合包较大或分配的内存量偏小。'
        : metaspace
          ? '加载的模组太多，类元数据区被占满。'
          : '游戏运行时内存耗尽。',
      action: heap
        ? '在「游戏设置 → 启动参数」中调大最大内存（整合包建议 4096–8192 MB），并关闭占用内存的其他程序。'
        : '调大内存，或减少同时安装的模组数量。',
    });
  }

  // ---- 3. Missing dependencies (Forge / NeoForge) -------------------------
  const forgeMissing = missingDeps(combined);
  if (forgeMissing.length > 0) {
    const list = forgeMissing.map((d) => `· ${d.mod}（被 ${d.wantedBy} 需要）`).join('\n');
    push({
      id: 'missing-dependency-forge',
      severity: 'error',
      title: `缺少前置模组（${forgeMissing.length} 个）`,
      detail: `Forge 在加载时发现下列依赖没有安装：\n${list}`,
      action: '到「资源下载 → 模组」搜索并安装这些前置模组，注意要选择与本游戏版本、加载器匹配的文件。',
    });
  }

  // ---- 4. Missing dependencies (Fabric / Quilt) --------------------------
  const fabricMissing = fabricMissingDeps(combined);
  if (fabricMissing.length > 0) {
    const list = fabricMissing.map((d) => `· ${d.mod}（被 ${d.wantedBy} 需要）`).join('\n');
    push({
      id: 'missing-dependency-fabric',
      severity: 'error',
      title: `缺少前置模组（${fabricMissing.length} 个）`,
      detail: `Fabric 检测到以下模组缺失或不满足版本要求：\n${list}`,
      action: '安装缺失的前置模组；若提示的是版本要求，则是已有前置版本太旧，需要升级。',
    });
  }

  // ---- 5. Duplicate / conflicting mods -----------------------------------
  if (/Duplicate mods found|is already defined|DuplicateModsFoundException/i.test(combined)) {
    push({
      id: 'duplicate-mod',
      severity: 'error',
      title: '存在重复安装的模组',
      detail: '同一个模组装了不止一份（常见于新旧版本同时放在 mods 里，或整合包与手动安装重复）。',
      action: '在「版本管理 → 模组」中检查重名模组，只保留一个与本游戏版本匹配的版本。',
    });
  }

  // ---- 6. Mixin failure ---------------------------------------------------
  if (/Mixin apply failed|MixinTransformerError|MixinException|mixin.*apply.*failed/i.test(combined)) {
    push({
      id: 'mixin-failed',
      severity: 'error',
      title: '模组注入失败（Mixin 冲突）',
      detail: '有模组试图修改游戏代码但失败了，通常是与另一个模组改动了同一处，或该模组版本与游戏版本不匹配。',
      action: '逐步禁用最近安装的模组定位冲突源；确认所有模组都支持当前游戏版本与加载器版本。',
    });
  }

  // ---- 7. Graphics / window creation -------------------------------------
  if (/GLFW error|Pixel format not accelerated|Failed to create window|OpenGL.*not supported|WGL.*failed/i.test(combined)) {
    push({
      id: 'graphics',
      severity: 'error',
      title: '显卡驱动 / 图形初始化失败',
      detail: '游戏无法创建渲染窗口，通常是显卡驱动过旧、驱动异常，或远程桌面 / 虚拟显示器环境导致。',
      action: '更新显卡驱动后重试；若使用远程桌面或虚拟机，请在本机直接运行。',
    });
  }

  // ---- 8. Broken jar / missing main class --------------------------------
  if (/Invalid or corrupt jarfile|Could not find or load main class|zip END header not found|invalid LOC header/i.test(combined)) {
    push({
      id: 'corrupt-jar',
      severity: 'error',
      title: '游戏文件或模组文件损坏',
      detail: '某个 jar 文件不完整（下载中断或被其他程序改动），导致无法加载。',
      action: '在「版本管理」用修复功能校验并补全文件；若提示涉及某个模组，重新下载该模组。',
    });
  }

  // ---- 9. Network failure during startup ---------------------------------
  if (/Unable to access|Failed to download|Connection refused|UnknownHostException|SSLHandshakeException/i.test(combined) &&
      /(libraries|assets|versions)/i.test(combined)) {
    push({
      id: 'download-failed',
      severity: 'warning',
      title: '启动前资源下载失败',
      detail: '游戏库或资源文件没能下载完成，常见于网络波动或被安全软件拦截。',
      action: '检查网络后重试启动；多次失败可在「游戏设置」中确认是否启用了镜像下载。',
    });
  }

  // ---- 10. Mod version mismatch (NoSuchMethod / NoClassDefFound) ---------
  // Deliberately after missing-dep rules: a resolution failure often surfaces as
  // NoClassDefFoundError, and the dependency message is far more actionable.
  if (/NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|AbstractMethodError|ClassNotFoundException/i.test(combined) &&
      findings.length === 0) {
    const missingClass = /(?:ClassNotFoundException|NoClassDefFoundError):\s*([\w.$/]+)/i.exec(combined)?.[1];
    push({
      id: 'mod-version-mismatch',
      severity: 'error',
      title: '模组版本不匹配',
      detail: missingClass
        ? `找不到类 ${missingClass.replace(/\//g, '.')}，说明某个模组调用了其他模组（或游戏本体）中不存在的代码。`
        : '某个模组调用了当前版本中不存在的代码，通常是模组版本与游戏版本 / 加载器版本不匹配。',
      action: '核对该模组支持的游戏版本与加载器版本，下载对应版本；升级游戏后需同步升级模组。',
    });
  }

  // ---- 11. Auth / session problems (not fatal, but noisy) ----------------
  if (/InvalidCredentialsException|Failed to fetch user properties|Couldn't connect to realms/i.test(combined)) {
    push({
      id: 'auth',
      severity: 'info',
      title: '账户验证失败（通常不影响单人游戏）',
      detail: '游戏无法用当前账户向 Mojang 验证身份，常见于离线账户、令牌过期或网络问题。',
      action: '单人游戏可忽略；要联机请重新登录账户。',
    });
  }

  // ---- 12. Fallback: attribute the top stack frames ----------------------
  const suspects = suspectPackages(primary, 4);
  if (findings.length === 0) {
    push({
      id: 'unknown',
      severity: 'error',
      title: first ? `游戏异常退出：${first.split('\n')[0].slice(0, 120)}` : '游戏异常退出',
      detail: suspects.length
        ? `没能匹配到已知的常见原因。崩溃栈中最可疑的代码来自：\n${suspects.map((s) => `· ${s}`).join('\n')}\n这通常对应同名模组的包名。`
        : '没能匹配到已知的常见原因，日志中也没有明显的异常栈。',
      action: '点击「导出错误报告」把完整日志发给开发者，或逐个禁用最近安装的模组排查。',
    });
  } else if (suspects.length > 0) {
    // Attach the suspects as context to whatever we did find.
    findings[0].detail += `\n\n崩溃栈中涉及的包：${suspects.join('、')}`;
  }

  const modCount = loadedModCount(primary);
  const summary = findings[0]?.title ?? '游戏异常退出';
  return {
    summary,
    findings,
    suspects,
    modCount,
    exitCode: input.exitCode,
    versionId: input.versionId,
  };
}

// ---------------------------------------------------------------------------
// Entry point used by the launcher
// ---------------------------------------------------------------------------

/**
 * Decide whether the finished session was a crash, and if so diagnose it.
 * Returns null for a clean shutdown so the UI stays quiet.
 */
export function endSession(exitCode: number | null): CrashInfo | null {
  const s = session;
  session = null;
  if (!s) return null;

  const logText = s.lines.join('\n');
  const crashReportPath = findCrashReport(s.gamePath, s.versionId, s.startedAt);
  const latestLogPath = findLatestLog(s.gamePath, s.versionId, s.startedAt);
  const crashReport = crashReportPath ? readIfPresent(crashReportPath) : null;

  // Prefer the file Minecraft wrote (it outlives our buffer), falling back to
  // what we captured on stdout.
  const fileLog = latestLogPath ? readIfPresent(latestLogPath) : null;
  const fullLog = fileLog ?? logText;

  const cleanStop = CLEAN_EXIT_MARKERS.some((m) => fullLog.includes(m) || logText.includes(m));
  const fatalSignal = FATAL_MARKERS.some((m) => fullLog.includes(m) || logText.includes(m));
  const nonZero = typeof exitCode === 'number' && exitCode !== 0;
  const spawnFailed = Boolean(s.spawnError);

  // A crash report on disk is conclusive regardless of exit code.
  const crashed = spawnFailed || Boolean(crashReport) || nonZero || fatalSignal;
  // …unless the game also logged a clean stop and had no fatal marker.
  if (!crashed || (cleanStop && !fatalSignal && !crashReport && !spawnFailed)) return null;

  const diagnosis = diagnose({
    logText: fullLog,
    crashReport,
    exitCode,
    versionId: s.versionId,
  });

  if (spawnFailed && s.spawnError) {
    // Reuse the launch-time classifier: a spawn failure is the same class of
    // problem (dead Java path, blocked executable) as a startGame() throw.
    const specific = classifyStartupMessage(s.spawnError);
    if (specific) {
      diagnosis.findings = [specific, ...diagnosis.findings.filter((f) => f.id !== 'unknown')];
      diagnosis.summary = specific.title;
    } else {
      diagnosis.findings.unshift({
        id: 'spawn-failed',
        severity: 'error',
        title: '游戏进程没能启动',
        detail: s.spawnError,
        action: '检查 Java 路径是否有效、游戏文件是否完整，然后重试。',
      });
      diagnosis.summary = '游戏进程没能启动';
    }
  }

  const info: CrashInfo = {
    versionId: s.versionId,
    exitCode,
    at: new Date().toISOString(),
    summary: diagnosis.summary,
    findings: diagnosis.findings,
    suspects: diagnosis.suspects,
    modCount: diagnosis.modCount,
    logPath: latestLogPath,
    crashReportPath,
  };
  lastCrash = info;
  return info;
}

// ---------------------------------------------------------------------------
// Entry point: failure before the process existed
// ---------------------------------------------------------------------------

/**
 * Common launch-time throws, mapped to an actionable explanation.
 *
 * These never reach a log — `startGame` rejects before spawning — so the message
 * is the only evidence. They are also the failures users hit most often (expired
 * login, missing Java, half-installed version), so each gets a precise fix.
 */
function classifyStartupMessage(message: string): CrashFinding | null {
  const loginExpired = /登录已过期|请重新登录|InvalidCredentials|令牌已失效|token.*expired/i.test(message);
  if (loginExpired) {
    return {
      id: 'startup-login-expired',
      severity: 'error',
      title: '账户登录已过期',
      detail: message,
      action: '回到主页，在账户区域重新登录该账户后再启动。',
    };
  }

  const javaMissing = /未检测到任何 Java|未检测到合适的 Java|未指定 Java 路径|Java 路径/i.test(message);
  if (javaMissing) {
    return {
      id: 'startup-java-missing',
      severity: 'error',
      title: '没有可用的 Java 运行时',
      detail: message,
      action: '到「游戏设置 → Java 运行时」一键安装对应版本，或在「版本管理 → 启动设置」中为该版本指定 Java。',
    };
  }

  const javaMismatch = /需要 Java (\d+)[\s\S]*?当前使用的是 Java (\d+)/i.exec(message);  if (javaMismatch) {
    return {
      id: 'startup-java-mismatch',
      severity: 'error',
      title: `Java 版本不匹配（需要 Java ${javaMismatch[1]}）`,
      detail: message,
      action: `安装 Java ${javaMismatch[1]}，并在「版本管理 → 启动设置」中为该版本指定它。`,
    };
  }

  if (/游戏已在运行中/i.test(message)) {
    return {
      id: 'startup-already-running',
      severity: 'warning',
      title: '游戏已经在运行',
      detail: message,
      action: '先关闭正在运行的游戏窗口，或点击主页的「结束游戏」后再启动。',
    };
  }

  // The process never spawned: Windows reports ENOENT when the configured Java
  // executable is missing, EACCES when it is blocked (antivirus / permissions).
  const unlaunchable = /ENOENT|EACCES|spawn\s|not recognized|拒绝访问|Access is denied|no such file/i.test(message);
  if (unlaunchable) {
    return {
      id: 'startup-java-unlaunchable',
      severity: 'error',
      title: '无法启动 Java 进程',
      detail: `系统没法运行这个 Java 可执行文件：\n${message}`,
      action:
        '指定的 Java 路径可能已经失效（被移动或删除）。到「游戏设置 → Java 运行时」重新选择 Java，或把启动方式改回「自动选择」。',
    };
  }

  const versionBroken = /找不到|不存在|版本文件|version\.json|缺少|不完整|corrupt|损坏/i.test(message);
  if (versionBroken) {
    return {
      id: 'startup-version-broken',
      severity: 'error',
      title: '游戏版本文件不完整',
      detail: message,
      action: '到「版本管理」对该版本执行修复，或重新安装该版本。',
    };
  }

  const modpack = /整合包|manifest\.json|mrpack/i.test(message);
  if (modpack) {
    return {
      id: 'startup-modpack',
      severity: 'error',
      title: '整合包安装失败',
      detail: message,
      action: '重新下载整合包再试；若反复失败，可导出错误报告排查。',
    };
  }

  return null;
}

/**
 * Build a CrashInfo for a launch that never produced a process — missing Java,
 * incomplete version files, a corrupt jar. The message is the only evidence, so
 * it is fed through the same rule engine as a real log.
 */
export function diagnoseStartupFailure(versionId: string, message: string): CrashInfo {
  const specific = classifyStartupMessage(message);
  let findings: CrashFinding[];

  if (specific) {
    findings = [specific];
  } else {
    // No dedicated rule: keep whatever the generic rules found, but drop the
    // catch-all "unknown" — the raw message below is more informative.
    const generic = diagnose({
      logText: message,
      crashReport: null,
      exitCode: null,
      versionId,
    });
    findings = generic.findings.filter((f) => f.id !== 'unknown');
    findings.unshift({
      id: 'launch-failed',
      severity: 'error',
      title: '游戏未启动成功',
      detail: message,
      action: '按上面的建议处理后重试；若仍失败，可导出错误报告用于排查。',
    });
  }

  const info: CrashInfo = {
    versionId,
    exitCode: null,
    at: new Date().toISOString(),
    summary: specific?.title ?? '游戏未启动成功',
    findings,
    suspects: [],
    modCount: null,
    logPath: null,
    crashReportPath: null,
  };
  lastCrash = info;
  return info;
}

// ---------------------------------------------------------------------------
// Report generation (used by the export button)
// ---------------------------------------------------------------------------

/** Build a self-contained text report: diagnosis first, raw logs after. */
export function buildReport(info: CrashInfo): string {
  const stamp = new Date(info.at);
  const line = '='.repeat(72);
  const parts: string[] = [];

  parts.push(line);
  parts.push('SLCL 启动器 - 游戏错误报告');
  parts.push(line);
  parts.push(`生成时间：${stamp.toLocaleString('zh-CN')}`);
  parts.push(`游戏版本：${info.versionId}`);
  parts.push(`退出码：${info.exitCode ?? '未知'}`);
  if (info.modCount !== null) parts.push(`已加载模组数：${info.modCount}`);
  parts.push('');

  parts.push('---- 诊断结论 ----');
  parts.push(`结论：${info.summary}`);
  if (info.suspects.length > 0) parts.push(`可疑包：${info.suspects.join('、')}`);
  parts.push('');

  info.findings.forEach((f, i) => {
    parts.push(`[${i + 1}] ${f.title}`);
    parts.push(`    原因：${f.detail.replace(/\n/g, '\n          ')}`);
    parts.push(`    建议：${f.action}`);
    parts.push('');
  });

  parts.push('---- 运行环境 ----');
  parts.push(`操作系统：${process.platform} ${process.arch}`);
  parts.push(`Electron：${process.versions.electron ?? '-'}`);
  parts.push(`Node：${process.versions.node}`);
  parts.push('');

  if (info.crashReportPath) {
    parts.push('---- Minecraft 崩溃报告 ----');
    parts.push(`文件：${info.crashReportPath}`);
    const raw = readIfPresent(info.crashReportPath);
    parts.push(raw ?? '(文件已不存在)');
    parts.push('');
  }

  parts.push('---- 游戏日志 ----');
  if (info.logPath) parts.push(`文件：${info.logPath}`);
  const log = info.logPath ? readIfPresent(info.logPath) : null;
  parts.push(log ?? '(日志文件已不存在或未生成)');

  return parts.join('\n');
}

/** Suggested file name for the exported report. */
export function reportFileName(info: CrashInfo): string {
  const d = new Date(info.at);
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const safeVersion = info.versionId.replace(/[\\/:*?"<>|]/g, '_');
  return `SLCL-错误报告-${safeVersion}-${stamp}.txt`;
}

/** Log file the dialog's "查看输出" button should open, if any. */
export function preferredLogFile(info: CrashInfo): string | null {
  if (info.logPath && existsSync(info.logPath)) return info.logPath;
  if (info.crashReportPath && existsSync(info.crashReportPath)) return info.crashReportPath;
  return null;
}

/** Human-readable label for the log file shown in the dialog. */
export function logFileLabel(info: CrashInfo): string {
  const file = preferredLogFile(info);
  return file ? basename(file) : '';
}

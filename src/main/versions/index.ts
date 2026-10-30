import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { clipboard, ClipboardItem, shell } from 'electron';
import { gunzipSync } from 'zlib';
import { pipeline } from 'stream/promises';
import { MinecraftFolder, Version } from '@xmcl/core';
import { open as openZip, openEntryReadStream, readEntry, walkEntriesGenerator } from '@xmcl/unzip';
import type { DownloadProgress, GameDirInfo, JavaRequirement, LocalMinecraftVersion, ModLoader, RemoteMinecraftVersion, ScreenshotInfo, VersionContentItem, VersionContents, VersionFolderKind, VersionInstallOptions, VersionPaths } from '@shared/types';
import { getSettings, updateSettings } from '../settings/store';
import { installFabricApi } from './fabricApi';
import { detectJava } from '../java/detector';
import { downloadToFile, listLoaderVersions as listLoaderVersionChoices, resolveLoaderPlan, runJava } from './loaders';
import { fetchMirrored, mirrorCandidates } from '../download/bmcl';
import { downloadWithStall } from '../download/stream';

const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
const CANCEL_MSG = '已取消';

interface VersionManifestEntry {
  id: string;
  type: string;
  url: string;
  time: string;
  releaseTime: string;
}

interface DownloadItem {
  url: string;
  dest: string;
  size?: number;
  sha1?: string;
}

// ---- global install state ----
let busy = false;
let activeAbort: AbortController | null = null;
let createdFiles = new Set<string>();
let createdVersionDirs = new Set<string>();

/** The active game root: new installs and shared assets go here. */
function resourcePath(): string {
  return getSettings().resourcePath;
}

/** All game roots that are scanned for installed versions. */
export function listGameRoots(): string[] {
  const s = getSettings();
  const list = Array.isArray(s.gameDirs) ? s.gameDirs.filter((d) => typeof d === 'string' && d.trim() !== '') : [];
  if (s.resourcePath && !list.includes(s.resourcePath)) list.unshift(s.resourcePath);
  return list;
}

/**
 * Roots ordered with the active one last, so that when the same version id exists
 * in several folders the active copy wins (used with a `seen` set).
 */
function rootsActiveLast(): string[] {
  const active = resourcePath();
  const roots = listGameRoots();
  return [...roots.filter((r) => r !== active), ...roots.filter((r) => r === active)];
}

/** The game root that owns an installed version, or null when it isn't installed. */
export function findVersionRoot(versionId: string): string | null {
  for (const root of rootsActiveLast().reverse()) {
    if (existsSync(join(root, 'versions', versionId, `${versionId}.json`))) return root;
  }
  return null;
}

/** Root for an existing version, falling back to the active root. */
function resourcePathFor(versionId: string): string {
  return findVersionRoot(versionId) ?? resourcePath();
}

/** Snapshot of every scanned game folder, for the 版本管理 folder picker. */
export function listGameDirInfos(): GameDirInfo[] {
  const active = resourcePath();
  return listGameRoots().map((dir) => {
    const versionsDir = join(dir, 'versions');
    const hasVersionsDir = existsSync(versionsDir);
    let versionCount = 0;
    if (hasVersionsDir) {
      try {
        versionCount = readdirSync(versionsDir).filter((entry) =>
          existsSync(join(versionsDir, entry, `${entry}.json`)),
        ).length;
      } catch {
        /* unreadable directory */
      }
    }
    return { path: dir, exists: existsSync(dir), hasVersionsDir, versionCount, active: dir === active };
  });
}

/** Add a game root to the scanned list (idempotent). */
export function addGameDir(dir: string): GameDirInfo[] {
  const target = dir.trim();
  if (!target) throw new Error('文件夹路径不能为空');
  if (!existsSync(target)) throw new Error('该文件夹不存在');
  const dirs = listGameRoots();
  if (!dirs.includes(target)) dirs.push(target);
  updateSettings({ gameDirs: dirs });
  return listGameDirInfos();
}

/** Stop scanning a game root. Files on disk are never touched. */
export function removeGameDir(dir: string): GameDirInfo[] {
  const dirs = listGameRoots().filter((d) => d !== dir);
  if (dirs.length === 0) throw new Error('至少需要保留一个游戏文件夹');
  // If the active root is removed, fall back to the first remaining one.
  const active = getSettings().resourcePath;
  updateSettings(active === dir ? { gameDirs: dirs, resourcePath: dirs[0] } : { gameDirs: dirs });
  return listGameDirInfos();
}

/** Make a scanned root the active one (new installs land here). */
export function setActiveGameDir(dir: string): GameDirInfo[] {
  if (!listGameRoots().includes(dir)) throw new Error('该文件夹不在列表中');
  updateSettings({ resourcePath: dir });
  return listGameDirInfos();
}

function trackVersionDir(id: string): void {
  createdVersionDirs.add(join(resourcePath(), 'versions', id));
}

function cleanupCreated(): void {
  for (const f of createdFiles) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
  for (const d of createdVersionDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function cancelDownload(): void {
  activeAbort?.abort();
}

async function fetchVersionManifest(signal?: AbortSignal): Promise<{ versions: VersionManifestEntry[] }> {
  // launchermeta.mojang.com is frequently unreachable in some regions (ECONNRESET),
  // so try the BMCLAPI mirror first and fall back to the official host.
  const candidates = mirrorCandidates(VERSION_MANIFEST_URL);
  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        lastError = new Error(`获取版本列表失败 (${res.status})`);
        continue;
      }
      return (await res.json()) as { versions: VersionManifestEntry[] };
    } catch (e) {
      lastError = e;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`获取版本列表失败:${reason}(请检查网络连接)`);
}

async function sha1OfFile(p: string): Promise<string> {
  const hash = createHash('sha1');
  const stream = createReadStream(p);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function fileMatches(item: DownloadItem, checkSha1 = true): Promise<boolean> {
  const { dest, size, sha1 } = item;
  if (!existsSync(dest)) return false;
  try {
    if (size !== undefined && size >= 0 && statSync(dest).size !== size) return false;
    if (checkSha1 && sha1) {
      const actual = await sha1OfFile(dest);
      if (actual.toLowerCase() !== sha1.toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(
  item: DownloadItem,
  onBytes?: (delta: number, reset?: boolean) => void,
): Promise<number> {
  const { url, dest, size } = item;
  if (await fileMatches(item)) return size ?? 0;
  mkdirSync(dirname(dest), { recursive: true });
  createdFiles.add(dest); // record BEFORE writing so partial files are cleaned on cancel
  // Try BMCLAPI first, then the official host. Each source gets two attempts so a
  // transient stall doesn't leave the install stuck, and sha1 is re-verified after
  // every attempt so a corrupt mirror file (seen with some NeoForge artifacts) retries.
  let lastError: Error | null = null;
  for (const candidate of mirrorCandidates(url)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (activeAbort?.signal.aborted) throw new Error(CANCEL_MSG);
      try {
        onBytes?.(0, true);
        await downloadWithStall(candidate, dest, {
          signal: activeAbort?.signal,
          // Stream bytes through so the manager page can show live speed and a
          // moving bar instead of only ticking when a file completes.
          onBytes: (delta) => onBytes?.(delta),
        });
        if (item.sha1) {
          const actual = await sha1OfFile(dest);
          if (actual.toLowerCase() !== item.sha1.toLowerCase()) {
            lastError = new Error(`文件校验失败 (sha1 不匹配): ${candidate}`);
            continue;
          }
        }
        return size ?? 0;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  throw lastError ?? new Error(`下载失败: ${url}`);
}

interface PoolTick {
  completed: number;
  total: number;
  completedBytes: number;
  inFlightBytes: number;
  file: string;
}

async function downloadPool(
  items: DownloadItem[],
  concurrency: number,
  onTick: (t: PoolTick) => void,
): Promise<void> {
  let completed = 0;
  let completedBytes = 0;
  const total = items.length;
  const totalBytes = items.reduce((sum, i) => sum + (i.size && i.size > 0 ? i.size : 0), 0);
  let idx = 0;
  const errors: Error[] = [];
  // In-flight byte counters, so the UI keeps moving during one large file instead
  // of sitting at "N-1/N" for minutes.
  const inFlight = new Map<number, number>();
  const sumInFlight = (): number => {
    let s = 0;
    for (const v of inFlight.values()) s += v;
    return s;
  };
  let lastFile = '';

  /**
   * Progress ticks are throttled to ~5/s.
   *
   * Streaming bytes (see downloadWithStall) means onTick fires per network chunk.
   * With 24 concurrent downloads that is hundreds of IPC messages per second, and
   * the renderer's re-render cost becomes the bottleneck — the download itself gets
   * measurably slower. Throttling keeps the UI readable and the transfer fast.
   */
  let lastEmit = 0;
  let pendingTick: PoolTick | null = null;
  const emit = (force = false): void => {
    const now = Date.now();
    const tick: PoolTick = {
      completed,
      total,
      completedBytes,
      inFlightBytes: sumInFlight(),
      file: lastFile,
    };
    if (!force && now - lastEmit < 200) {
      pendingTick = tick;
      return;
    }
    lastEmit = now;
    pendingTick = null;
    onTick(tick);
  };

  // Flush a throttled tick so the final state is never lost.
  const flushTimer = setInterval(() => {
    if (pendingTick) {
      pendingTick = null;
      lastEmit = Date.now();
      onTick({ completed, total, completedBytes, inFlightBytes: sumInFlight(), file: lastFile });
    }
  }, 200);

  async function worker(): Promise<void> {
    // `errors.length > 0` stops the remaining workers from picking up new items
    // once a download has definitively failed — otherwise they keep hammering the
    // network in the background after the pool has already rejected.
    while (idx < items.length && errors.length === 0) {
      if (activeAbort?.signal.aborted) return;
      const i = idx++;
      const item = items[i];
      lastFile = basename(item.dest);
      inFlight.set(i, 0);
      try {
        const bytes = await downloadFile(item, (delta, reset) => {
          inFlight.set(i, reset ? 0 : (inFlight.get(i) ?? 0) + delta);
          lastFile = basename(item.dest);
          emit();
        });
        inFlight.delete(i);
        completed += 1;
        completedBytes += bytes > 0 ? bytes : item.size && item.size > 0 ? item.size : 0;
      } catch (e) {
        inFlight.delete(i);
        errors.push(e as Error);
        return;
      }
      emit();
    }
  }

  try {
    const workers = Array.from({ length: Math.min(concurrency, total || 1) }, () => worker());
    await Promise.all(workers);
  } finally {
    clearInterval(flushTimer);
  }
  if (activeAbort?.signal.aborted) throw new Error(CANCEL_MSG);
  if (errors.length > 0) throw errors[0];
  void totalBytes;
}

async function resolveVersion(
  versionId: string,
  root = resourcePath(),
): Promise<Awaited<ReturnType<typeof Version.parse>>> {
  return Version.parse(root, versionId);
}

/** Collect the client jar + libraries + log config + asset index (NOT asset objects). */
function collectCoreDownloads(resolved: Awaited<ReturnType<typeof Version.parse>>, root = resourcePath()): DownloadItem[] {
  const folder = MinecraftFolder.from(root);
  const items: DownloadItem[] = [];

  const clientDownload = resolved.downloads.client;
  if (clientDownload) {
    items.push({
      url: clientDownload.url,
      dest: folder.getVersionJar(resolved.minecraftVersion),
      size: clientDownload.size,
      sha1: clientDownload.sha1,
    });
  }

  for (const lib of resolved.libraries) {
    if (!lib.download?.url) continue;
    items.push({
      url: lib.download.url,
      dest: folder.getLibraryByPath(lib.path),
      size: lib.download.size,
      sha1: lib.download.sha1 || undefined,
    });
  }

  const logFile = resolved.logging?.client?.file;
  if (logFile) {
    items.push({ url: logFile.url, dest: folder.getPath('assets', 'log_configs', logFile.id), size: logFile.size, sha1: logFile.sha1 });
  }

  const assetIndex = resolved.assetIndex;
  if (assetIndex) {
    items.push({ url: assetIndex.url, dest: folder.getAssetsIndex(assetIndex.id), size: assetIndex.size, sha1: assetIndex.sha1 });
  }

  return items;
}

async function collectAssetObjects(
  resolved: Awaited<ReturnType<typeof Version.parse>>,
  folder: MinecraftFolder,
): Promise<DownloadItem[]> {
  const assetIndex = resolved.assetIndex;
  if (!assetIndex) return [];
  const indexRes = await fetchMirrored(assetIndex.url, { signal: activeAbort?.signal ?? undefined });
  if (!indexRes.ok) return [];
  const index = (await indexRes.json()) as { objects?: Record<string, { hash: string; size: number }> };
  const items: DownloadItem[] = [];
  for (const obj of Object.values(index.objects ?? {})) {
    const hash = obj.hash;
    items.push({
      url: `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
      dest: folder.getAsset(hash),
      size: obj.size,
      sha1: hash,
    });
  }
  return items;
}

async function downloadCoreFiles(
  resolved: Awaited<ReturnType<typeof Version.parse>>,
  onProgress: (p: DownloadProgress) => void,
  label: string,
  root = resourcePath(),
): Promise<void> {
  const items = [...collectCoreDownloads(resolved, root)].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  const totalBytes = items.reduce((sum, i) => sum + (i.size && i.size >= 0 ? i.size : 0), 0);
  onProgress({ progress: 0, totalBytes, downloadedBytes: 0, task: `下载 ${label} 库文件` });
  await downloadPool(items, 12, (t) => {
    const doneBytes = t.completedBytes + t.inFlightBytes;
    onProgress({
      progress:
        totalBytes > 0 ? Math.min(0.999, doneBytes / totalBytes) : t.total === 0 ? 1 : Math.min(0.999, t.completed / t.total),
      totalBytes,
      downloadedBytes: doneBytes,
      task: `下载 ${label} 库文件 (${t.completed}/${t.total})`,
      totalFiles: t.total,
      completedFiles: t.completed,
    });
  });
}

/**
 * Read a version JSON tolerantly: some launchers (and hand-edited files) write a
 * UTF-8 BOM, which `JSON.parse` rejects. Stripping it keeps such versions detectable.
 */
function readVersionJson(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text) as Record<string, unknown>;
}

/** Derive the real (vanilla) Minecraft version a version JSON is based on. */
function deriveMinecraftVersion(raw: Record<string, unknown>, id: string): string {
  const from = raw.mcVersion ?? raw._minecraftVersion ?? raw.inheritsFrom ?? raw.clientVersion;
  if (typeof from === 'string' && from.trim() !== '') return from;
  return id;
}

/** Recommend a Java major version for a Minecraft version (e.g. "1.12.2" -> 8). */
/**
 * Recommended Java major for a Minecraft version, derived from the version string.
 * NOTE: prefer `getRequiredJavaMajor()` — modern version JSONs carry an exact
 * `javaVersion.majorVersion`, which is authoritative. This is only the fallback
 * used when a version JSON has no `javaVersion` field.
 */
export function recommendedJavaMajor(mcVersion: string): number {
  const m = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) {
    // Year-based scheme (26.1, 26.3, …) introduced after 1.21.x. These require Java 25
    // (class file version 69), which the old 1.x heuristic could never express.
    const year = mcVersion.match(/^(\d{2,})\./);
    if (year && parseInt(year[1], 10) >= 26) return 25;
    return 17;
  }
  const minor = parseInt(m[1], 10);
  const patch = m[2] ? parseInt(m[2], 10) : 0;
  if (minor >= 21) return 21; // 1.21+ requires Java 21
  if (minor >= 20 && patch >= 5) return 21; // 1.20.5+ requires Java 21
  if (minor >= 18) return 17; // 1.18+ requires Java 17
  if (minor === 17) return 17; // 1.17 requires Java 16/17
  return 8; // 1.16.5 and earlier require Java 8
}

/**
 * The Java major an installed version actually requires.
 *
 * Reads `javaVersion.majorVersion` from the version JSON — the same field the
 * official launcher uses — so new versions (e.g. 26.3 → Java 25) are handled
 * without guessing. Falls back to the string heuristic for older JSONs.
 */
export function getRequiredJavaMajor(versionId: string): number {
  const versionsDir = join(resourcePathFor(versionId), 'versions');
  const jsonPath = join(versionsDir, versionId, `${versionId}.json`);
  const mcVersion = getMinecraftVersionOf(versionId);
  if (existsSync(jsonPath)) {
    try {
      const raw = readVersionJson(jsonPath);
      const jv = raw.javaVersion as { majorVersion?: unknown } | undefined;
      const major = typeof jv?.majorVersion === 'number' ? jv.majorVersion : 0;
      if (major > 0) return major;
    } catch {
      /* fall through to the heuristic */
    }
  }
  return recommendedJavaMajor(mcVersion);
}

/** Resolve the real Minecraft version of an installed version. */
export function getMinecraftVersionOf(versionId: string): string {
  const versionsDir = join(resourcePathFor(versionId), 'versions');
  const jsonPath = join(versionsDir, versionId, `${versionId}.json`);
  if (!existsSync(jsonPath)) return versionId;
  try {
    const raw = readVersionJson(jsonPath);
    return deriveMinecraftVersion(raw, versionId);
  } catch {
    return versionId;
  }
}

/** Pre-create the standard game sub-folders for a version (like PCL). */
function ensureIsolatedFolders(versionId: string): void {
  const gameDir = getVersionGameDir(versionId);
  for (const sub of ['mods', 'resourcepacks', 'datapacks', 'saves', 'config', 'shaderpacks']) {
    mkdirSync(join(gameDir, sub), { recursive: true });
  }
}

/** Rename an installed version: move folder, rewrite json id, rename jar. */
export function renameVersion(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const versionsDir = join(resourcePathFor(oldId), 'versions');
  const oldDir = join(versionsDir, oldId);
  if (!existsSync(oldDir)) throw new Error(`版本 ${oldId} 不存在`);
  const newDir = join(versionsDir, newId);
  if (existsSync(newDir)) throw new Error(`版本 ${newId} 已存在`);

  renameSync(oldDir, newDir);

  const oldJson = join(newDir, `${oldId}.json`);
  const newJson = join(newDir, `${newId}.json`);
  if (existsSync(oldJson)) {
    const json = readVersionJson(oldJson);
    // Preserve the real Minecraft version so the list keeps showing it after rename.
    if (typeof json.mcVersion !== 'string' && typeof json.inheritsFrom !== 'string' && typeof json._minecraftVersion !== 'string' && typeof json.clientVersion !== 'string') {
      json.mcVersion = deriveMinecraftVersion(json, oldId);
    }
    json.id = newId;
    writeFileSync(newJson, JSON.stringify(json, null, 2));
    rmSync(oldJson, { force: true });
  }

  const oldJar = join(newDir, `${oldId}.jar`);
  const newJar = join(newDir, `${newId}.jar`);
  if (existsSync(oldJar)) renameSync(oldJar, newJar);

  ensureIsolatedFolders(newId);
}

export async function listRemoteVersions(): Promise<RemoteMinecraftVersion[]> {
  const list = await fetchVersionManifest();
  return list.versions.map((v) => ({
    id: v.id,
    type: (v.type as RemoteMinecraftVersion['type']) ?? 'release',
    releaseTime: v.releaseTime,
  }));
}

/** All stable versions of a mod loader for a Minecraft version, newest first. */
export function listLoaderVersions(loader: ModLoader, mcVersion: string): Promise<string[]> {
  return listLoaderVersionChoices(loader, mcVersion);
}

/**
 * Report which Java major a version needs and whether any installed runtime can
 * run it. The renderer uses this to offer downloading the missing Java instead of
 * just failing the launch.
 */
export async function getJavaRequirement(versionId: string): Promise<JavaRequirement> {
  const requiredMajor = getRequiredJavaMajor(versionId);
  const list = await detectJava();
  const known = list.filter((j) => j.major > 0);
  // Java 8 must be an exact match (newer JDKs break 1.16.5 and older); for modern
  // versions any Java at or above the requirement works.
  const usable =
    requiredMajor <= 8
      ? known.filter((j) => j.major === 8)
      : known.filter((j) => j.major >= requiredMajor);
  usable.sort((a, b) => a.major - b.major);
  return {
    versionId,
    requiredMajor,
    bestMajor: usable.length > 0 ? usable[0].major : null,
    satisfied: usable.length > 0,
  };
}

/** Detect the mod loader baked into a version json. */
function detectLoaderOf(raw: Record<string, unknown>, id: string): LocalMinecraftVersion['loader'] {
  // 1. Authoritative: written by SLCL at install time. Survives renaming and
  //    JSON flattening (where `inheritsFrom` and loader fields are dropped).
  const recorded = raw._slclLoader;
  if (recorded === 'fabric' || recorded === 'forge' || recorded === 'neoforge' || recorded === 'quilt') {
    return recorded;
  }

  const idLower = id.toLowerCase();

  // 2. Loader-specific fields written by the various installers.
  if (raw._fabricLoaderVersion) return 'fabric';
  if (raw._quiltLoaderVersion) return 'quilt';
  if (raw._neoForgedVersion) return 'neoforge';
  if (raw._forgeVersion) return 'forge';

  // 3. The main class is the most reliable structural hint.
  const mainClass = typeof raw.mainClass === 'string' ? raw.mainClass.toLowerCase() : '';
  if (mainClass.includes('neoforged')) return 'neoforge';
  if (mainClass.includes('fabricmc')) return 'fabric';
  if (mainClass.includes('quiltmc')) return 'quilt';
  if (mainClass.includes('forge')) return 'forge';

  // 4. Version id / inherited parent id.
  if (idLower.includes('neoforge')) return 'neoforge';
  if (idLower.includes('forge')) return 'forge';
  if (idLower.includes('fabric')) return 'fabric';
  if (idLower.includes('quilt')) return 'quilt';
  if (typeof raw.inheritsFrom === 'string') {
    const parent = raw.inheritsFrom.toLowerCase();
    if (parent.includes('neoforge')) return 'neoforge';
    if (parent.includes('forge')) return 'forge';
    if (parent.includes('quilt')) return 'quilt';
    if (parent.includes('fabric')) return 'fabric';
  }

  // 5. Last resort: a loader library in the classpath.
  const libs = Array.isArray(raw.libraries) ? (raw.libraries as Array<{ name?: unknown }>) : [];
  for (const lib of libs) {
    const name = typeof lib?.name === 'string' ? lib.name.toLowerCase() : '';
    if (name.startsWith('net.neoforged')) return 'neoforge';
    if (name.startsWith('net.fabricmc')) return 'fabric';
    if (name.startsWith('org.quiltmc')) return 'quilt';
    if (name.startsWith('net.minecraftforge')) return 'forge';
  }
  return null;
}

/**
 * Scan every known game root for installed versions.
 * Mirrors what PCL/HMCL do: a version exists when `<root>/versions/<id>/<id>.json` exists.
 */
export function listLocalVersions(): LocalMinecraftVersion[] {
  const out: LocalMinecraftVersion[] = [];
  const seen = new Set<string>();
  for (const root of rootsActiveLast()) {
    const versionsDir = join(root, 'versions');
    if (!existsSync(versionsDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(versionsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const jsonPath = join(versionsDir, entry, `${entry}.json`);
      if (!existsSync(jsonPath)) continue;
      // Same version id may exist in several folders; the active root wins.
      if (seen.has(entry)) continue;
      let type = 'unknown';
      let loader: LocalMinecraftVersion['loader'] = null;
      let minecraftVersion = entry;
      try {
        const raw = readVersionJson(jsonPath);
        type = typeof raw.type === 'string' ? raw.type : 'unknown';
        loader = detectLoaderOf(raw, entry);
        minecraftVersion = deriveMinecraftVersion(raw, entry);
      } catch {
        /* ignore malformed json */
      }
      seen.add(entry);
      out.push({
        id: entry,
        type,
        installed: true,
        hasModLoader: loader !== null,
        minecraftVersion,
        dir: root,
        loader,
      });
    }
  }
  out.sort(compareVersionsForDisplay);
  return out;
}

/**
 * Approximate the release line a snapshot belongs to, so `23w45a` sorts next to
 * 1.20.x instead of being lumped in with every other snapshot.
 * Keyed by the two-digit year prefix of the snapshot id.
 */
const SNAPSHOT_ERA: Record<number, [number, number]> = {
  11: [1, 0],
  12: [1, 3],
  13: [1, 5],
  14: [1, 7],
  15: [1, 8],
  16: [1, 9],
  17: [1, 11],
  18: [1, 12],
  19: [1, 13],
  20: [1, 15],
  21: [1, 16],
  22: [1, 18],
  23: [1, 19],
  24: [1, 20],
  25: [1, 21],
  26: [26, 0],
};

/**
 * Numeric ordering weight for a Minecraft version: higher = newer.
 * Handles releases (`1.21.11`, `26.3`), snapshots (`23w45a`) and old
 * alpha/beta builds (`a1.2.6`, `b1.7.3`).
 */
function mcVersionWeight(v: string): number {
  const s = v.trim().toLowerCase();

  // Old alpha / beta - always oldest.
  const old = s.match(/^([ab])(\d+)\.(\d+)(?:\.(\d+))?/);
  if (old) return (old[1] === 'a' ? 0 : 50_000) + Number(old[2]) * 10 + Number(old[3] ?? 0);

  // Snapshot, e.g. 23w45a.
  const snap = s.match(/^(\d{2})w(\d{2})([a-z])?$/);
  if (snap) {
    const era = SNAPSHOT_ERA[Number(snap[1])] ?? [1, 0];
    return era[0] * 1_000_000 + era[1] * 10_000 + Number(snap[2]) * 100;
  }

  // Release: 1.21.11 or the year-based 26.3.
  const rel = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (rel) return Number(rel[1]) * 1_000_000 + Number(rel[2]) * 10_000 + Number(rel[3] ?? 0);

  return -1;
}

/** Within one game version: Fabric first, then Forge, NeoForge, and vanilla last. */
const LOADER_ORDER: Record<string, number> = {
  fabric: 0,
  quilt: 1,
  forge: 2,
  neoforge: 3,
};

function loaderWeight(loader: LocalMinecraftVersion['loader']): number {
  return loader ? (LOADER_ORDER[loader] ?? 9) : 99;
}

/**
 * Display order for 版本管理: newest game version on top, oldest at the bottom;
 * inside the same game version the loaders are ordered Fabric → Forge →
 * NeoForge → vanilla. Ties fall back to the readable id.
 */
export function compareVersionsForDisplay(a: LocalMinecraftVersion, b: LocalMinecraftVersion): number {
  const byGame = mcVersionWeight(b.minecraftVersion) - mcVersionWeight(a.minecraftVersion);
  if (byGame !== 0) return byGame;
  const byLoader = loaderWeight(a.loader) - loaderWeight(b.loader);
  if (byLoader !== 0) return byLoader;
  return a.id.localeCompare(b.id);
}

/** Install the vanilla version (json + jar + libraries + natives + assets). */
async function installVanilla(versionId: string, onProgress: (p: DownloadProgress) => void): Promise<void> {
  const folder = MinecraftFolder.from(resourcePath());
  const manifest = await fetchVersionManifest(activeAbort?.signal ?? undefined);
  const meta = manifest.versions.find((v) => v.id === versionId);
  if (!meta) throw new Error(`未知的 Minecraft 版本: ${versionId}`);

  onProgress({ progress: 0, totalBytes: 0, downloadedBytes: 0, task: '下载版本元数据' });
  const versionJsonRes = await fetchMirrored(meta.url, { signal: activeAbort?.signal ?? undefined });
  if (!versionJsonRes.ok) throw new Error(`获取版本元数据失败 (${versionJsonRes.status})`);
  const versionJson = await versionJsonRes.text();

  const jsonDest = folder.getVersionJson(versionId);
  mkdirSync(dirname(jsonDest), { recursive: true });
  writeFileSync(jsonDest, versionJson);
  trackVersionDir(versionId);

  const resolved = await resolveVersion(versionId);

  const coreItems = collectCoreDownloads(resolved);
  const assetObjects = await collectAssetObjects(resolved, folder);
  const allItems = [...coreItems, ...assetObjects];

  const totalBytes = allItems.reduce((sum, i) => sum + (i.size && i.size >= 0 ? i.size : 0), 0);
  const totalFiles = allItems.length;
  // Start the largest files first so one big file can't become the lone tail that
  // everything else waits on (the classic "stuck on the last few files" symptom).
  const bySizeDesc = (a: DownloadItem, b: DownloadItem): number => (b.size ?? 0) - (a.size ?? 0);
  const coreSorted = [...coreItems].sort(bySizeDesc);
  const assetSorted = [...assetObjects].sort(bySizeDesc);
  let baseBytes = 0;

  const report = (completed: number, completedBytes: number, inFlightBytes: number, file: string): void => {
    const doneBytes = baseBytes + completedBytes + inFlightBytes;
    // Prefer byte-based progress: it keeps the bar moving smoothly while one large
    // file is downloading, instead of stalling between file boundaries.
    const progress =
      totalBytes > 0
        ? Math.min(0.999, doneBytes / totalBytes)
        : totalFiles === 0
          ? 1
          : Math.min(0.999, completed / totalFiles);
    onProgress({
      progress,
      totalBytes,
      downloadedBytes: doneBytes,
      task: file ? `下载 ${file} (${completed}/${totalFiles})` : '下载版本文件',
      totalFiles,
      completedFiles: completed,
    });
  };

  onProgress({ progress: 0, totalBytes, downloadedBytes: 0, task: '下载版本文件与库' });
  await downloadPool(coreSorted, 12, (t) => {
    report(t.completed, t.completedBytes, t.inFlightBytes, t.file);
  });
  baseBytes += coreItems.reduce((sum, i) => sum + (i.size && i.size > 0 ? i.size : 0), 0);

  if (assetSorted.length > 0) {
    onProgress({
      progress: coreItems.length / Math.max(totalFiles, 1),
      totalBytes,
      downloadedBytes: baseBytes,
      task: '下载资源文件',
    });
    await downloadPool(assetSorted, 24, (t) => {
      report(coreItems.length + t.completed, t.completedBytes, t.inFlightBytes, t.file);
    });
  }
}

async function resolveJavaPath(): Promise<string> {
  const s = getSettings();
  const p = s.javaPath && s.javaPath.trim() !== '' ? s.javaPath : null;
  const resolved = p ?? (await detectJava())[0]?.path;
  if (!resolved) throw new Error('未检测到 Java,无法运行安装器。请在设置中指定 Java 路径');
  return resolved.replace(/javaw\.exe$/i, 'java.exe');
}

/** Run a loader installer (Forge/NeoForge/OptiFine) and return the newly created version id. */
async function runInstaller(
  url: string,
  fileName: string,
  label: string,
  headers: Record<string, string> | undefined,
  onProgress: (p: DownloadProgress) => void,
): Promise<string> {
  const before = new Set(listLocalVersions().map((v) => v.id));

  const installerPath = join(tmpdir(), 'slcl-installers', fileName);
  onProgress({ progress: 0.05, totalBytes: 0, downloadedBytes: 0, task: `下载 ${label} 安装器` });
  await downloadToFile(url, installerPath, headers, activeAbort?.signal ?? undefined);

  const javaPath = await resolveJavaPath();
  onProgress({ progress: 0.15, totalBytes: 0, downloadedBytes: 0, task: `运行 ${label} 安装器(可能需要几分钟)…` });
  // Forge honors `--mirror` to pull its libraries through BMCLAPI; NeoForge ignores it
  // on some builds but it is harmless to pass.
  await runJava(
    javaPath,
    ['-jar', installerPath, '--installClient', resourcePath(), '--mirror', 'https://bmclapi2.bangbang93.com/maven'],
    resourcePath(),
    undefined,
    activeAbort?.signal ?? undefined,
  );

  const after = new Set(listLocalVersions().map((v) => v.id));
  const newIds = [...after].filter((id) => !before.has(id));
  if (newIds.length === 0) throw new Error(`${label} 安装器运行完成,但未生成版本`);
  return newIds[0];
}

/** Install legacy Forge (<=1.12.2). Supports both installer formats (see below). */
async function extractLegacyForge(
  url: string,
  fileName: string,
  label: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<string> {
  const installerPath = join(tmpdir(), 'slcl-installers', fileName);
  onProgress({ progress: 0.05, totalBytes: 0, downloadedBytes: 0, task: `下载 ${label} 安装器` });
  await downloadToFile(url, installerPath, undefined, activeAbort?.signal ?? undefined);

  const folder = MinecraftFolder.from(resourcePath());
  const zip = await openZip(installerPath, { lazyEntries: true, autoClose: false });
  let versionJsonStr = '';
  let hasInstallProfile = false;
  try {
    for await (const entry of walkEntriesGenerator(zip)) {
      if (activeAbort?.signal.aborted) throw new Error(CANCEL_MSG);
      const name = entry.fileName;
      if (name === 'version.json') {
        versionJsonStr = (await readEntry(zip, entry)).toString('utf8');
      } else if (name === 'install_profile.json') {
        hasInstallProfile = true;
      } else if (name.startsWith('maven/') && name.endsWith('.jar') && !name.endsWith('/')) {
        const relPath = name.slice('maven/'.length);
        const dest = folder.getLibraryByPath(relPath);
        if (!existsSync(dest)) {
          mkdirSync(dirname(dest), { recursive: true });
          createdFiles.add(dest);
          const rs = await openEntryReadStream(zip, entry);
          await pipeline(rs, createWriteStream(dest));
        }
      }
    }
  } finally {
    zip.close();
  }

  // Old Forge installers (the pre-2024 format) contain only `install_profile.json` and
  // require running the self-extracting installer, which downloads + renames the
  // universal jar. The rebuilt installers ship a ready `version.json` + `maven/` jars.
  if (!versionJsonStr) {
    if (!hasInstallProfile) throw new Error(`${label} 安装器损坏(缺少 version.json / install_profile.json)`);
    return runLegacyForgeInstaller(installerPath, label, onProgress);
  }

  const versionJson = JSON.parse(versionJsonStr) as { id?: string };
  const id = versionJson.id;
  if (!id) throw new Error(`${label} 安装器缺少版本 id`);
  trackVersionDir(id);

  // Write the version json, then download any remaining libraries.
  const jsonDest = folder.getVersionJson(id);
  mkdirSync(dirname(jsonDest), { recursive: true });
  writeFileSync(jsonDest, versionJsonStr);

  const resolved = await resolveVersion(id);
  await downloadCoreFiles(resolved, onProgress, label);
  return id;
}

/** Run a legacy Forge installer in headless `--installClient` mode. */
async function runLegacyForgeInstaller(
  installerPath: string,
  label: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<string> {
  const before = new Set(listLocalVersions().map((v) => v.id));
  const javaPath = await resolveJavaPath();
  onProgress({ progress: 0.2, totalBytes: 0, downloadedBytes: 0, task: `运行 ${label} 安装器…` });
  await runJava(
    javaPath,
    ['-jar', installerPath, '--installClient'],
    resourcePath(),
    undefined,
    activeAbort?.signal ?? undefined,
  );
  const after = new Set(listLocalVersions().map((v) => v.id));
  const newIds = [...after].filter((id) => !before.has(id));
  if (newIds.length === 0) throw new Error(`${label} 安装器运行完成,但未生成版本`);
  return newIds[0];
}

/** Install a single loader (Fabric=json, Forge/NeoForge=installer). */
async function installLoader(
  loader: ModLoader,
  mcVersion: string,
  onProgress: (p: DownloadProgress) => void,
  loaderVersion?: string,
): Promise<string> {
  const plan = await resolveLoaderPlan(loader, mcVersion, activeAbort?.signal ?? undefined, loaderVersion);
  switch (plan.kind) {
    case 'json': {
      const folder = MinecraftFolder.from(resourcePath());
      const jsonDest = folder.getVersionJson(plan.id);
      mkdirSync(dirname(jsonDest), { recursive: true });
      writeFileSync(jsonDest, plan.json);
      trackVersionDir(plan.id);
      const resolved = await resolveVersion(plan.id);
      await downloadCoreFiles(resolved, onProgress, plan.label);
      return plan.id;
    }
    case 'installer':
      return runInstaller(plan.url, plan.fileName, plan.label, plan.headers, onProgress);
    case 'legacy-forge':
      return extractLegacyForge(plan.url, plan.fileName, plan.label, onProgress);
  }
}

/**
 * Flatten a loader version that inherits `vanillaId` into a self-contained version
 * (PCL-style): merge the vanilla JSON into the loader JSON, drop `inheritsFrom`,
 * copy the vanilla jar into the loader folder, then remove the standalone vanilla folder.
 */
function mergeInheritedJson(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...parent, ...child };

  // Merge libraries (dedupe by `name`, child wins).
  const parentLibs = Array.isArray(parent.libraries) ? (parent.libraries as Array<Record<string, unknown>>) : [];
  const childLibs = Array.isArray(child.libraries) ? (child.libraries as Array<Record<string, unknown>>) : [];
  const seen = new Set<string>();
  const mergedLibs: Array<Record<string, unknown>> = [];
  for (const lib of [...childLibs, ...parentLibs]) {
    const name = typeof lib?.name === 'string' ? lib.name : '';
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    mergedLibs.push(lib);
  }
  result.libraries = mergedLibs;

  // Merge arguments (game/jvm): parent first, then child.
  const parentArgs = (parent.arguments ?? {}) as Record<string, unknown>;
  const childArgs = (child.arguments ?? {}) as Record<string, unknown>;
  const game = [
    ...(Array.isArray(parentArgs.game) ? (parentArgs.game as unknown[]) : []),
    ...(Array.isArray(childArgs.game) ? (childArgs.game as unknown[]) : []),
  ];
  const jvm = [
    ...(Array.isArray(parentArgs.jvm) ? (parentArgs.jvm as unknown[]) : []),
    ...(Array.isArray(childArgs.jvm) ? (childArgs.jvm as unknown[]) : []),
  ];
  if (game.length > 0 || jvm.length > 0) {
    result.arguments = { game, jvm };
  }

  // Drop inheritance so the version becomes self-contained.
  delete result.inheritsFrom;

  // Record the real Minecraft version in a custom field (NOT clientVersion, which
  // @xmcl/core uses to locate the jar and would point it at the deleted vanilla folder).
  if (typeof parent.id === 'string') result.mcVersion = parent.id;

  return result;
}

/** Flatten a loader version into the vanilla version, then remove the vanilla folder. */
function flattenVersion(vanillaId: string, loaderId: string): void {
  const folder = MinecraftFolder.from(resourcePath());
  const vanillaJsonPath = folder.getVersionJson(vanillaId);
  const loaderJsonPath = folder.getVersionJson(loaderId);

  const vanillaRaw = readVersionJson(vanillaJsonPath);
  const loaderRaw = readVersionJson(loaderJsonPath);

  // Only flatten when the loader still inherits the vanilla version.
  if (typeof loaderRaw.inheritsFrom !== 'string') return;

  const merged = mergeInheritedJson(vanillaRaw, loaderRaw);
  writeFileSync(loaderJsonPath, JSON.stringify(merged, null, 2));

  // Copy the vanilla jar into the loader folder (so it becomes self-contained).
  const vanillaJar = folder.getVersionJar(vanillaId);
  const loaderJar = folder.getVersionJar(loaderId);
  if (existsSync(vanillaJar) && !existsSync(loaderJar)) {
    copyFileSync(vanillaJar, loaderJar);
  }

  // Remove the standalone vanilla folder.
  rmSync(join(resourcePath(), 'versions', vanillaId), { recursive: true, force: true });
}

/**
 * Persist the loader that was installed for a version.
 * Flattening drops `inheritsFrom` and installer-specific fields, and users may
 * rename the version, so the loader must be recorded explicitly at install time.
 */
function annotateLoader(versionId: string, loader: ModLoader): void {
  const jsonPath = join(resourcePathFor(versionId), 'versions', versionId, `${versionId}.json`);
  if (!existsSync(jsonPath)) return;
  try {
    const raw = readVersionJson(jsonPath);
    raw._slclLoader = loader;
    writeFileSync(jsonPath, JSON.stringify(raw, null, 2));
  } catch {
    /* annotation is best-effort; heuristics still apply */
  }
}

export async function installVersion(
  versionId: string,
  options: VersionInstallOptions,
  onProgress: (p: DownloadProgress) => void,
): Promise<string> {
  if (busy) throw new Error('已有下载/安装任务在进行中,请稍候');
  busy = true;
  activeAbort = new AbortController();
  createdFiles = new Set();
  createdVersionDirs = new Set();
  try {
    // 1. Install the base vanilla version (json + jar + libraries + assets).
    await installVanilla(versionId, onProgress);

    // 2. Install the main loader (Fabric/Forge/NeoForge) if requested.
    let installedId = versionId;
    if (options.loader) {
      const loaderId = await installLoader(options.loader, versionId, onProgress, options.loaderVersion);
      // 3. Flatten the loader into a self-contained version (PCL-style single folder).
      flattenVersion(versionId, loaderId);
      installedId = loaderId;
    }

    // 4. Apply a custom version name to the primary result.
    let finalId = installedId;
    if (options.name && options.name.trim() !== '') {
      finalId = options.name.trim();
      renameVersion(installedId, finalId);
    }

    // 5. Pre-create the standard game sub-folders (mods/resourcepacks/...) for isolated versions.
    ensureIsolatedFolders(finalId);

    // 6. Record the loader so the UI can show the right icon/badge even after renaming.
    if (options.loader) annotateLoader(finalId, options.loader);

    // 7. Fabric: bundle Fabric API, which nearly every Fabric mod depends on.
    //    Best-effort — a failure here must not fail the install.
    if (options.loader === 'fabric' && options.installFabricApi !== false) {
      onProgress({ progress: 0.99, totalBytes: 0, downloadedBytes: 0, task: '安装 Fabric API…' });
      const result = await installFabricApi(versionId, join(getVersionGameDir(finalId), 'mods'), activeAbort?.signal);
      // Surface the outcome in the log stream (onProgress has no text channel for it).
      if (result.installed) {
        console.log(`[SLCL] Fabric API 已安装: ${result.installed}`);
      } else if (result.reason) {
        console.log(`[SLCL] 跳过 Fabric API: ${result.reason}`);
      }
    }

    onProgress({ progress: 1, totalBytes: 0, downloadedBytes: 0, task: '安装完成' });
    return finalId;
  } catch (e) {
    if (activeAbort?.signal.aborted) {
      cleanupCreated();
      throw new Error(CANCEL_MSG);
    }
    throw e;
  } finally {
    busy = false;
    activeAbort = null;
    createdFiles = new Set();
    createdVersionDirs = new Set();
  }
}

/**
 * Repair a version by downloading any missing/corrupt core files (jar, libraries,
 * natives, asset index). Used both by the "修复" action and automatically before launch.
 */
export async function repairVersion(versionId: string, onProgress: (p: DownloadProgress) => void): Promise<number> {
  if (busy) throw new Error('已有下载/安装任务在进行中,请稍候');
  busy = true;
  activeAbort = new AbortController();
  createdFiles = new Set();
  try {
    // Repair reads from the root that actually owns the version.
    const root = resourcePathFor(versionId);
    const resolved = await resolveVersion(versionId, root);
    const allItems = collectCoreDownloads(resolved, root);

    const missing: DownloadItem[] = [];
    for (const item of allItems) {
      if (!(await fileMatches(item, false))) missing.push(item);
    }

    if (missing.length === 0) return 0;

    const totalBytes = missing.reduce((sum, i) => sum + (i.size && i.size >= 0 ? i.size : 0), 0);
    onProgress({ progress: 0, totalBytes, downloadedBytes: 0, task: '补全缺失文件' });
    const missingSorted = [...missing].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    await downloadPool(missingSorted, 12, (t) => {
      const doneBytes = t.completedBytes + t.inFlightBytes;
      onProgress({
        progress:
          totalBytes > 0 ? Math.min(0.999, doneBytes / totalBytes) : t.total === 0 ? 1 : Math.min(0.999, t.completed / t.total),
        totalBytes,
        downloadedBytes: doneBytes,
        task: `补全缺失文件 (${t.completed}/${t.total})`,
        totalFiles: t.total,
        completedFiles: t.completed,
      });
    });
    return missing.length;
  } catch (e) {
    if (activeAbort?.signal.aborted) {
      cleanupCreated();
      throw new Error(CANCEL_MSG);
    }
    throw e;
  } finally {
    busy = false;
    activeAbort = null;
    createdFiles = new Set();
  }
}

export function removeVersion(versionId: string): void {
  const versionRoot = join(resourcePathFor(versionId), 'versions', versionId);
  if (existsSync(versionRoot)) rmSync(versionRoot, { recursive: true, force: true });
}

// ---- version isolation (always enabled) ----

/**
 * Version isolation is always enabled. Every version gets its own game directory
 * (saves/mods/config under `versions/<id>`), so they never interfere.
 */
export function isVersionIsolated(_versionId: string): boolean {
  return true;
}

/** The effective game directory (saves/mods/config) for a version. */
export function getVersionGameDir(versionId: string): string {
  return join(resourcePathFor(versionId), 'versions', versionId);
}

/** The game root that owns a version (used to launch with the right shared assets). */
export function getVersionResourceRoot(versionId: string): string {
  return resourcePathFor(versionId);
}

/** All relevant on-disk paths for a version. */
export function getVersionPaths(versionId: string): VersionPaths {
  const root = resourcePathFor(versionId);
  const gameDir = join(root, 'versions', versionId);
  return {
    versionFolder: gameDir,
    gameDir,
    modsFolder: join(gameDir, 'mods'),
    shaderpacksFolder: join(gameDir, 'shaderpacks'),
    resourcepacksFolder: join(gameDir, 'resourcepacks'),
    datapacksFolder: join(gameDir, 'datapacks'),
    savesFolder: join(gameDir, 'saves'),
    screenshotsFolder: join(gameDir, 'screenshots'),
  };
}

/** Open a version-related folder in the OS file manager (creating it if needed). */
export async function openVersionFolder(versionId: string, kind: VersionFolderKind): Promise<void> {
  const paths = getVersionPaths(versionId);
  const byKind: Record<VersionFolderKind, string> = {
    version: paths.versionFolder,
    mods: paths.modsFolder,
    shaderpacks: paths.shaderpacksFolder,
    resourcepacks: paths.resourcepacksFolder,
    datapacks: paths.datapacksFolder,
    saves: paths.savesFolder,
    screenshots: paths.screenshotsFolder,
  };
  const target = byKind[kind];
  mkdirSync(target, { recursive: true });
  const err = await shell.openPath(target);
  if (err) throw new Error(`无法打开文件夹: ${err}`);
}

// ---- version contents (mods / shaderpacks / saves) ----

/** Read the world name from a level.dat file (gzip NBT), falling back to null. */
function readWorldName(levelDatPath: string): string | null {
  try {
    const buf = readFileSync(levelDatPath);
    const data = gunzipSync(buf);
    const marker = Buffer.from('LevelName');
    const idx = data.indexOf(marker);
    if (idx < 0) return null;
    // LevelName is stored as TAG_String: 0x08, uint16 big-endian length, UTF-8 bytes.
    let p = idx + marker.length;
    if (data[p] !== 0x08) return null;
    p += 1;
    const len = data.readUInt16BE(p);
    p += 2;
    return data.subarray(p, p + len).toString('utf8');
  } catch {
    return null;
  }
}

/** List the entries of a directory (files + folders), sorted by name. */
function listDirEntries(dir: string): VersionContentItem[] {
  if (!existsSync(dir)) return [];
  const out: VersionContentItem[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let isDir = false;
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      size = isDir ? 0 : st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    out.push({ name, isDir, size, mtimeMs });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Aggregate the mods / shaderpacks / saves contents of a version. */
export function listVersionContents(versionId: string): VersionContents {
  const paths = getVersionPaths(versionId);

  // A disabled mod is the same .jar renamed to `<name>.jar.disabled`.
  const modItems: VersionContentItem[] = [];
  for (const e of listDirEntries(paths.modsFolder)) {
    if (e.isDir) continue;
    const lower = e.name.toLowerCase();
    if (lower.endsWith('.jar')) modItems.push({ ...e, disabled: false });
    else if (lower.endsWith('.jar.disabled')) modItems.push({ ...e, disabled: true });
  }
  const mods = modItems;

  const shaderpacks = listDirEntries(paths.shaderpacksFolder);

  const saves = listDirEntries(paths.savesFolder)
    .filter((e) => e.isDir)
    .map((e) => {
      const levelDat = join(paths.savesFolder, e.name, 'level.dat');
      const worldName = readWorldName(levelDat) ?? e.name;
      return { ...e, worldName };
    });

  return { mods, shaderpacks, saves };
}

// ---- mod management (icons / enable-disable / delete) ----

/** Cache of extracted mod icons, keyed by absolute path + mtime + size. */
const modIconCache = new Map<string, string | null>();

/** Read a PNG/JPG inside a mod jar and return it as a data URL. */
async function extractIconFromJar(jarPath: string, entryPath: string): Promise<string | null> {
  let zip: Awaited<ReturnType<typeof openZip>> | null = null;
  try {
    zip = await openZip(jarPath, { lazyEntries: true, autoClose: false });
    const norm = entryPath.replace(/^\/+/, '');
    for await (const entry of walkEntriesGenerator(zip)) {
      if (entry.fileName.replace(/\\/g, '/') !== norm) continue;
      const buf = await readEntry(zip, entry);
      // Modern launchers only render PNG icons for mods; keep it simple and safe.
      if (buf.length < 8 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
      // Skip absurdly large images to keep IPC payloads sane.
      if (buf.length > 2 * 1024 * 1024) return null;
      return `data:image/png;base64,${buf.toString('base64')}`;
    }
  } catch {
    /* unreadable jar */
  } finally {
    zip?.close();
  }
  return null;
}

function pickIconPathFromJson(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const icon = obj.icon;
  if (typeof icon === 'string' && icon.trim()) return icon.trim();
  // Fabric allows { "icon": { "128": "path.png" } }.
  if (icon && typeof icon === 'object') {
    const map = icon as Record<string, unknown>;
    const keys = Object.keys(map).sort((a, b) => Number(b) - Number(a));
    for (const k of keys) {
      const v = map[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  // Quilt: { "metadata": { "icon": ... } }
  const meta = obj.metadata;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    if (typeof m.icon === 'string' && m.icon.trim()) return m.icon.trim();
  }
  const logo = obj.logoFile;
  if (typeof logo === 'string' && logo.trim()) return logo.trim();
  return null;
}

function pickIconPathFromToml(text: string): string | null {
  const m = text.match(/^\s*logoFile\s*=\s*"([^"]+)"/m) ?? text.match(/^\s*logoFile\s*=\s*'([^']+)'/m);
  return m ? m[1] : null;
}

function pickIconPathFromMcmodInfo(text: string): string | null {
  // Legacy mods may carry an array or a single object; a regex is enough here.
  const m = text.match(/"logoFile"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** Metadata read from one jar: what it declares about itself. */
export interface ModMeta {
  /** On-disk file name, including a `.disabled` suffix when present. */
  file: string;
  /** Every modId the jar declares (a multi-module jar can have several). */
  ids: string[];
  /** Declared version, or empty when the metadata does not carry one. */
  version: string;
}

type ModMetaCore = Omit<ModMeta, 'file'>;

/**
 * Cache keyed by `path|mtime|size`, shared by every consumer of a jar's metadata.
 *
 * A jar is immutable once written, so mtime+size is enough to know the entry is
 * still valid; a replaced file naturally gets a new key.
 */
const modMetaCache = new Map<string, ModMetaCore>();
const MOD_META_CACHE_LIMIT = 4000;

/** Parse Forge/NeoForge `mods.toml`, which can declare several `[[mods]]` blocks. */
function parseTomlMods(text: string): ModMetaCore {
  const ids: string[] = [];
  let version = '';
  // Each `[[mods]]` block starts a new entry; the values below it belong to it.
  const blocks = text.split(/^\s*\[\[mods\]\]\s*$/m);
  for (const blockText of blocks) {
    const idMatch = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(blockText);
    if (!idMatch) continue;
    ids.push(idMatch[1]);
    if (!version) {
      const vMatch = /^\s*version\s*=\s*["']([^"']*)["']/m.exec(blockText);
      if (vMatch && vMatch[1]) version = vMatch[1];
    }
  }
  // Forge lets authors reference the jar manifest instead of a literal.
  if (version.startsWith('${')) version = '';
  return { ids, version };
}

/** Parse `fabric.mod.json` / `quilt.mod.json`. */
function parseJsonMods(raw: unknown): ModMetaCore {
  if (!raw || typeof raw !== 'object') return { ids: [], version: '' };
  const obj = raw as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof obj.id === 'string' && obj.id) ids.push(obj.id);
  // Quilt nests the same fields under `quilt_loader`.
  const loader = obj.quilt_loader;
  if (loader && typeof loader === 'object') {
    const l = loader as Record<string, unknown>;
    if (typeof l.id === 'string' && l.id && !ids.includes(l.id)) ids.push(l.id);
  }
  const version = typeof obj.version === 'string' ? obj.version : '';
  return { ids, version };
}

/** Parse legacy `mcmod.info` (an array of objects, or a single object). */
function parseMcmodInfo(text: string): ModMetaCore {
  try {
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!first || typeof first !== 'object') return { ids: [], version: '' };
    const obj = first as Record<string, unknown>;
    const id = typeof obj.modid === 'string' ? obj.modid : '';
    const version = typeof obj.version === 'string' ? obj.version : '';
    return { ids: id ? [id] : [], version };
  } catch {
    return { ids: [], version: '' };
  }
}

/**
 * Read the modId(s) and version of one jar.
 *
 * Returns empty `ids` when the jar carries no recognisable metadata — a few very
 * old mods predate all four formats, and callers must fall back to filenames.
 */
async function readModMeta(jarPath: string): Promise<ModMetaCore> {
  let zip: Awaited<ReturnType<typeof openZip>> | null = null;
  const ids: string[] = [];
  let version = '';
  try {
    zip = await openZip(jarPath, { lazyEntries: true, autoClose: false });
    for await (const entry of walkEntriesGenerator(zip)) {
      const name = entry.fileName.replace(/\\/g, '/');
      const isJson = name === 'fabric.mod.json' || name === 'quilt.mod.json';
      const isToml = name === 'META-INF/mods.toml' || name === 'META-INF/neoforge.mods.toml';
      const isLegacy = name === 'mcmod.info';
      if (!isJson && !isToml && !isLegacy) continue;

      try {
        const text = (await readEntry(zip, entry)).toString('utf8');
        const parsed = isJson
          ? parseJsonMods(JSON.parse(text) as unknown)
          : isToml
            ? parseTomlMods(text)
            : parseMcmodInfo(text);
        for (const id of parsed.ids) if (!ids.includes(id)) ids.push(id);
        if (!version && parsed.version) version = parsed.version;
      } catch {
        /* malformed metadata: keep whatever the other files said */
      }
      // Fabric metadata is authoritative; nothing after it adds a modId.
      if (isJson && ids.length > 0) break;
    }
  } catch {
    /* unreadable jar */
  } finally {
    zip?.close();
  }
  return { ids, version };
}

/**
 * Metadata for every mod jar in a directory.
 *
 * Backs "is this dependency already installed?" — matching on modId is the only
 * reliable test, because the same mod arrives with different file names depending
 * on the download source, and a jar can be renamed by hand.
 *
 * Bounded concurrency keeps a 200-mod pack from exhausting file handles; results
 * are cached by `path|mtime|size`, so repeat calls are free.
 */
export async function scanModsMeta(modsDir: string): Promise<ModMeta[]> {
  if (!existsSync(modsDir)) return [];
  const files = readdirSync(modsDir).filter((f) => {
    const lower = f.toLowerCase();
    return lower.endsWith('.jar') || lower.endsWith('.jar.disabled');
  });

  const out: ModMeta[] = [];
  const tasks = files.map(async (file) => {
    const full = join(modsDir, file);
    let cacheKey: string;
    try {
      const st = statSync(full);
      cacheKey = `${full}|${st.mtimeMs}|${st.size}`;
    } catch {
      return;
    }
    let core = modMetaCache.get(cacheKey);
    if (!core) {
      core = await readModMeta(full);
      if (modMetaCache.size >= MOD_META_CACHE_LIMIT) {
        const oldest = modMetaCache.keys().next().value;
        if (oldest !== undefined) modMetaCache.delete(oldest);
      }
      modMetaCache.set(cacheKey, core);
    }
    out.push({ file, ...core });
  });

  const LIMIT = 8;
  for (let i = 0; i < tasks.length; i += LIMIT) {
    await Promise.all(tasks.slice(i, i + LIMIT));
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Metadata of a single jar, using the same cache as `scanModsMeta`.
 *
 * Used right after a download to learn which modIds the new file declares — that
 * is what makes duplicate-modId cleanup exact instead of heuristic.
 */
export async function readModMetaOf(jarPath: string): Promise<{ ids: string[]; version: string }> {
  let cacheKey: string;
  try {
    const st = statSync(jarPath);
    cacheKey = `${jarPath}|${st.mtimeMs}|${st.size}`;
  } catch {
    return { ids: [], version: '' };
  }
  const hit = modMetaCache.get(cacheKey);
  if (hit) return hit;
  const fresh = await readModMeta(jarPath);
  if (modMetaCache.size >= MOD_META_CACHE_LIMIT) {
    const oldest = modMetaCache.keys().next().value;
    if (oldest !== undefined) modMetaCache.delete(oldest);
  }
  modMetaCache.set(cacheKey, fresh);
  return fresh;
}
/**
 * Resolve every mod's icon for a version.
 * Returns a map of on-disk filename -> PNG data URL (null when the mod ships none).
 */
export async function listModIcons(versionId: string): Promise<Record<string, string | null>> {
  const paths = getVersionPaths(versionId);
  const out: Record<string, string | null> = {};
  if (!existsSync(paths.modsFolder)) return out;

  const files = readdirSync(paths.modsFolder).filter((f) => {
    const lower = f.toLowerCase();
    return lower.endsWith('.jar') || lower.endsWith('.jar.disabled');
  });
  const tasks = files.map(async (file) => {
    const full = join(paths.modsFolder, file);
    let cacheKey: string;
    try {
      const st = statSync(full);
      cacheKey = `${full}|${st.mtimeMs}|${st.size}`;
    } catch {
      out[file] = null;
      return;
    }
    if (modIconCache.has(cacheKey)) {
      out[file] = modIconCache.get(cacheKey) ?? null;
      return;
    }

    let iconPath: string | null = null;
    let zip: Awaited<ReturnType<typeof openZip>> | null = null;
    try {
      zip = await openZip(full, { lazyEntries: true, autoClose: false });
      for await (const entry of walkEntriesGenerator(zip)) {
        const name = entry.fileName.replace(/\\/g, '/');
        if (name === 'fabric.mod.json' || name === 'quilt.mod.json') {
          try {
            const raw = JSON.parse((await readEntry(zip, entry)).toString('utf8')) as unknown;
            iconPath = pickIconPathFromJson(raw);
          } catch {
            /* malformed metadata */
          }
        } else if (name === 'META-INF/mods.toml' || name === 'META-INF/neoforge.mods.toml') {
          try {
            const text = (await readEntry(zip, entry)).toString('utf8');
            iconPath = iconPath ?? pickIconPathFromToml(text);
          } catch {
            /* malformed metadata */
          }
        } else if (name === 'mcmod.info') {
          try {
            const text = (await readEntry(zip, entry)).toString('utf8');
            iconPath = iconPath ?? pickIconPathFromMcmodInfo(text);
          } catch {
            /* malformed metadata */
          }
        }
        // Fabric's icon wins; once we have one we can stop.
        if (iconPath) break;
      }
    } catch {
      /* unreadable jar */
    } finally {
      zip?.close();
    }

    const dataUrl = iconPath ? await extractIconFromJar(full, iconPath) : null;
    modIconCache.set(cacheKey, dataUrl);
    out[file] = dataUrl;
  });

  // Bounded concurrency so a 200-mod pack doesn't blow up the file handles.
  const LIMIT = 8;
  for (let i = 0; i < tasks.length; i += LIMIT) {
    await Promise.all(tasks.slice(i, i + LIMIT));
  }
  return out;
}

/** Enable/disable a mod by renaming it to/from `<name>.jar.disabled`. */
export function toggleMod(versionId: string, filename: string): void {
  const paths = getVersionPaths(versionId);
  const safe = basename(filename);
  const dir = paths.modsFolder;
  const full = join(dir, safe);
  if (!existsSync(full)) throw new Error('该模组不存在,可能已被删除');

  const lower = safe.toLowerCase();
  if (lower.endsWith('.jar.disabled')) {
    const target = join(dir, safe.slice(0, safe.length - '.disabled'.length));
    if (existsSync(target)) throw new Error(`无法启用:${basename(target)} 已存在`);
    renameSync(full, target);
    return;
  }
  if (lower.endsWith('.jar')) {
    const target = join(dir, `${safe}.disabled`);
    if (existsSync(target)) throw new Error(`无法禁用:${basename(target)} 已存在`);
    renameSync(full, target);
    return;
  }
  throw new Error('只能对 .jar 模组执行此操作');
}

/** Delete a mod file, a shaderpack, or a save folder. */
export function deleteVersionContent(
  versionId: string,
  kind: 'mods' | 'shaderpacks' | 'saves',
  name: string,
): void {
  const paths = getVersionPaths(versionId);
  const dir = kind === 'mods' ? paths.modsFolder : kind === 'shaderpacks' ? paths.shaderpacksFolder : paths.savesFolder;
  const safe = basename(name);
  if (!safe || safe === '.' || safe === '..') throw new Error('无效的名称');
  const full = join(dir, safe);
  // Guard against a crafted name escaping the folder.
  if (dirname(full) !== dir && !full.startsWith(dir + '\\') && !full.startsWith(dir + '/')) {
    throw new Error('无效的路径');
  }
  if (!existsSync(full)) throw new Error('该项目不存在,可能已被删除');
  if (kind === 'mods') {
    const lower = safe.toLowerCase();
    if (!lower.endsWith('.jar') && !lower.endsWith('.jar.disabled')) {
      throw new Error('只能删除 .jar 模组文件');
    }
  }
  rmSync(full, { recursive: kind !== 'mods', force: true });
}

// ---- screenshots ----

/** List screenshot files in the version's screenshots folder (newest first). */
export function listScreenshots(versionId: string): ScreenshotInfo[] {
  const paths = getVersionPaths(versionId);
  const dir = paths.screenshotsFolder;
  if (!existsSync(dir)) return [];
  const out: ScreenshotInfo[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!name.toLowerCase().endsWith('.png')) continue;
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(full);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    out.push({ name, size, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function screenshotPath(versionId: string, name: string): string {
  const safe = name.replace(/[/\\]/g, '');
  const paths = getVersionPaths(versionId);
  const p = join(paths.screenshotsFolder, safe);
  if (!existsSync(p)) throw new Error('截图文件不存在');
  return p;
}

/** Read a screenshot as a base64 data URL for previewing. */
export function readScreenshot(versionId: string, name: string): string {
  const p = screenshotPath(versionId, name);
  const buf = readFileSync(p);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/** Copy a screenshot image to the system clipboard. */
export async function copyScreenshot(versionId: string, name: string): Promise<void> {
  const p = screenshotPath(versionId, name);
  const buf = readFileSync(p);
  const blob = new Blob([buf], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** Delete a screenshot file. */
export function deleteScreenshot(versionId: string, name: string): void {
  const p = screenshotPath(versionId, name);
  rmSync(p, { force: true });
}

/** Open a screenshot in the OS default image viewer. */
export async function openScreenshot(versionId: string, name: string): Promise<void> {
  const p = screenshotPath(versionId, name);
  const err = await shell.openPath(p);
  if (err) throw new Error(`无法打开截图: ${err}`);
}

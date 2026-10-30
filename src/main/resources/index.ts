import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import { tmpdir } from 'os';
import { createHash, randomUUID } from 'crypto';
import { open as openZip, readEntry, walkEntriesGenerator } from '@xmcl/unzip';
import type {
  DownloadProgress,
  ModpackInstallResult,
  ResolvedDependency,
  ResourceDependency,
  ResourceFileInfo,
  ResourceInstallResult,
  ResourceInstallTarget,
  ResourceProject,
  ResourceSearchOptions,
  ResourceSearchResult,
  ResourceSource,
  ResourceType,
  ResourceVersion,
} from '@shared/types';
import { getVersionGameDir, installVersion, listLocalVersions, readModMetaOf, scanModsMeta } from '../versions';
import { createThrottle, runPool } from '../download/pool';
import { guessProjectModIds, knownProjectModIds, normalizeModKey, rememberProjectModIds } from './modIds';
import {
  installCurseforge,
  installCurseforgeModpack,
  listCurseforgeProjectVersions,
  listCurseforgeSupport,
  listCurseforgeVersions,
  lookupCurseforgeProjects,
  searchCurseforge,
} from './curseforge';
import { downloadToFile, fetchJson, modrinthCandidates } from './http';
import {
  cachedZhNames as zhNameCache,
  chineseNameScore,
  hasCjk,
  onZhNameResolved as zhNameSubscribe,
  queueZhNames as zhNameQueue,
  resolveChineseNames,
  resolveMcmodLink,
} from './mcmod';

/** Modrinth `project_type` value for each resource category. */
const PROJECT_TYPE: Record<ResourceType, string> = {
  mod: 'mod',
  resourcepack: 'resourcepack',
  shader: 'shader',
  datapack: 'datapack',
  modpack: 'modpack',
};

/** On-disk folder that receives each resource type (relative to the game directory). */
const FOLDER_BY_TYPE: Record<Exclude<ResourceType, 'modpack'>, string> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks',
};

/**
 * Acceptable file extensions per type. Datapacks are sometimes distributed as
 * `.jar` (e.g. VeinMiner's NeoForge build), so both are allowed there.
 */
const EXTENSIONS: Record<ResourceType, string[]> = {
  mod: ['.jar'],
  resourcepack: ['.zip'],
  shader: ['.zip'],
  datapack: ['.zip', '.jar'],
  modpack: ['.mrpack'],
};

interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author?: string;
  icon_url?: string;
  downloads?: number;
  categories?: string[];
  versions?: string[];
}

interface ModrinthFile {
  url: string;
  filename: string;
  size: number;
  primary: boolean;
  /** Provided by Modrinth for every file; used to reject truncated/mirrored junk. */
  hashes?: { sha1?: string; sha512?: string };
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: 'release' | 'beta' | 'alpha';
  date_published: string;
  downloads: number;
  game_versions: string[];
  loaders: string[];
  files: ModrinthFile[];
  /**
   * Declared dependencies. `dependency_type` is Modrinth's own vocabulary:
   * `required` | `optional` | `incompatible` | `embedded`. Only the first two
   * matter here — `embedded` is bundled inside the jar and `incompatible` must
   * not be installed at all.
   */
  dependencies?: Array<{
    project_id?: string | null;
    version_id?: string | null;
    dependency_type?: string;
  }>;
}

interface ModpackIndexFile {
  path: string;
  hashes?: Record<string, string>;
  env?: { client?: 'required' | 'optional' | 'unsupported'; server?: string };
  downloads?: string[];
  fileSize?: number;
}

interface ModpackIndex {
  formatVersion: number;
  game: string;
  versionId?: string;
  name?: string;
  dependencies?: Record<string, string>;
  files?: ModpackIndexFile[];
}

/** Modrinth metadata request: MCIM mirror first, official API as fallback. */
async function modrinthGet<T>(path: string): Promise<T> {
  const candidates = modrinthCandidates().map((c) => ({ ...c, url: `${c.url}${path}` }));
  return await fetchJson<T>(candidates, { accept: 'application/json' });
}

function hasAllowedExtension(type: ResourceType, filename: string): boolean {
  const lower = filename.toLowerCase();
  return EXTENSIONS[type].some((ext) => lower.endsWith(ext));
}

function pickPrimaryFile(files: ModrinthFile[] | undefined): ModrinthFile | undefined {
  if (!files || files.length === 0) return undefined;
  return files.find((f) => f.primary) ?? files[0];
}

// ---- search / version listing ----

/** Modrinth website path segment per category. */
const MODRINTH_SITE_PATH: Record<ResourceType, string> = {
  mod: 'mod',
  resourcepack: 'resourcepack',
  shader: 'shader',
  datapack: 'datapack',
  modpack: 'modpack',
};

function modrinthPageUrl(type: ResourceType, slug: string): string {
  return `https://modrinth.com/${MODRINTH_SITE_PATH[type]}/${slug}`;
}

export async function searchModrinth(
  type: ResourceType,
  query: string,
  options?: ResourceSearchOptions,
): Promise<ResourceProject[]> {
  const facetGroups: string[][] = [[`project_type:${PROJECT_TYPE[type]}`]];
  if (options?.gameVersion) facetGroups.push([`versions:${options.gameVersion}`]);
  if (options?.loader) facetGroups.push([`categories:${options.loader.toLowerCase()}`]);

  const params = new URLSearchParams();
  params.set('query', query.trim());
  params.set('facets', JSON.stringify(facetGroups));
  params.set('limit', String(options?.limit ?? 20));
  params.set('offset', String(options?.offset ?? 0));
  params.set('index', options?.sortBy ?? 'relevance');

  const data = await modrinthGet<{ hits?: ModrinthHit[] }>(`/search?${params.toString()}`);
  return (data.hits ?? []).map((hit) => ({
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description ?? '',
    author: hit.author ?? '',
    iconUrl: hit.icon_url,
    downloads: hit.downloads ?? 0,
    categories: hit.categories ?? [],
    gameVersions: hit.versions ?? [],
    source: 'modrinth',
    pageUrl: modrinthPageUrl(type, hit.slug),
  }));
}

/** Convert a Modrinth version's declared dependencies into the launcher's shape. */
function toModrinthDependencies(
  raw: ModrinthVersion['dependencies'],
): ResourceDependency[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: ResourceDependency[] = [];
  const seen = new Set<string>();
  for (const dep of raw) {
    const kind =
      dep.dependency_type === 'required'
        ? 'required'
        : dep.dependency_type === 'optional'
          ? 'optional'
          : null;
    if (!kind || !dep.project_id) continue;
    if (seen.has(dep.project_id)) continue;
    seen.add(dep.project_id);
    out.push({
      projectId: dep.project_id,
      kind,
      // A pinned version id is authoritative; the resolver uses it verbatim.
      ...(dep.version_id ? { versionId: dep.version_id } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** All downloadable versions of a project, newest first (powers the history picker). */
export async function listModrinthVersions(
  _type: ResourceType,
  projectId: string,
  options?: ResourceSearchOptions,
): Promise<ResourceVersion[]> {
  const params = new URLSearchParams();
  if (options?.gameVersion) params.set('game_versions', JSON.stringify([options.gameVersion]));
  if (options?.loader) params.set('loaders', JSON.stringify([options.loader.toLowerCase()]));
  const qs = params.toString();
  const raw = await modrinthGet<ModrinthVersion[]>(
    `/project/${encodeURIComponent(projectId)}/version${qs ? `?${qs}` : ''}`,
  );

  return raw
    .filter((v) => Array.isArray(v.files) && v.files.length > 0)
    .map((v) => ({ v, file: pickPrimaryFile(v.files) as ModrinthFile }))
    .filter((entry) => entry.file !== undefined)
    .sort((a, b) => Date.parse(b.v.date_published) - Date.parse(a.v.date_published))
    .map(({ v, file }) => ({
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      versionType: v.version_type,
      datePublished: v.date_published,
      downloads: v.downloads ?? 0,
      gameVersions: v.game_versions ?? [],
      loaders: v.loaders ?? [],
      filename: file.filename,
      fileSize: file.size,
      url: file.url,
      dependencies: toModrinthDependencies(v.dependencies),
    }));
}

// ---- target folder resolution ----

/**
 * Resolve (and create) the folder a resource should be installed into.
 * Priority: explicit `customDir` -> datapack world folder -> version type folder.
 */
export function resolveTargetDir(type: ResourceType, target: ResourceInstallTarget): string {
  if (type === 'modpack') throw new Error('整合包必须通过整合包安装流程安装');

  let dir: string;
  const customDir = target.customDir?.trim();
  if (customDir) {
    if (!isAbsolute(customDir)) throw new Error('请选择绝对路径作为安装位置');
    dir = customDir;
  } else {
    if (!target.versionId) throw new Error('请先选择要安装到的游戏版本');
    const gameDir = getVersionGameDir(target.versionId);
    const worldFolder = target.worldFolder?.trim();
    if (type === 'datapack' && worldFolder) {
      dir = join(gameDir, 'saves', basename(worldFolder), 'datapacks');
    } else {
      dir = join(gameDir, FOLDER_BY_TYPE[type]);
    }
  }

  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTargetDir(type: ResourceType, target: ResourceInstallTarget): string {
  return resolveTargetDir(type, target);
}

// ---- install / list / remove ----

/**
 * Reject a downloaded file whose bytes do not match what the API promised.
 *
 * Checks the size first (cheap) and the sha1 only when one is published, so a
 * mirror serving the wrong file is caught instead of being installed as if fine.
 * A mismatch deletes the file: leaving it would make the next attempt append to a
 * corrupt jar.
 */
async function assertFileHash(
  path: string,
  hashes: { sha1?: string } | undefined,
  expectedSize: number,
): Promise<void> {
  try {
    const actualSize = statSync(path).size;
    if (expectedSize > 0 && actualSize !== expectedSize) {
      throw new Error(`文件大小不符（${actualSize}/${expectedSize} 字节）`);
    }
    const expected = hashes?.sha1?.toLowerCase();
    if (!expected) return;
    const hash = createHash('sha1');
    const stream = createReadStream(path);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    if (hash.digest('hex').toLowerCase() !== expected) {
      throw new Error('文件校验失败（sha1 不匹配）');
    }
  } catch (e) {
    rmSync(path, { force: true });
    throw new Error(`下载的文件不完整或已损坏：${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function installModrinth(
  type: ResourceType,
  projectId: string,
  versionId: string,
  target: ResourceInstallTarget,
): Promise<ResourceInstallResult> {
  if (type === 'modpack') throw new Error('请使用整合包安装流程');
  const version = await modrinthGet<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`);
  if (version.project_id !== projectId) throw new Error('版本与项目不匹配');

  const file = pickPrimaryFile(version.files);
  if (!file) throw new Error('该版本没有可下载的文件');

  const dir = resolveTargetDir(type, target);
  const filename = basename(file.filename);
  const dest = join(dir, filename);
  await downloadToFile(file.url, dest);
  // Mirror/CDN hiccups have produced truncated jars that the game then failed to
  // read. An explicit hash check is the only reliable guard, since a silent early
  // close looks like success at the socket level.
  await assertFileHash(dest, file.hashes, file.size);
  if (type === 'mod') await reconcileInstalledMod(dest, 'modrinth', projectId);

  return {
    path: dest,
    filename,
    title: version.name || version.version_number,
    versionNumber: version.version_number,
  };
}

/**
 * Post-install housekeeping for a mod jar.
 *
 * Two jobs, both needing the *downloaded* jar's own metadata:
 *
 * 1. Remember which modIds this project maps to, so later "already installed?"
 *    checks are exact instead of guessing from the slug.
 * 2. Remove any other jar in the folder declaring the same modId. Two jars with one
 *    modId make Minecraft refuse to start, and the crash never names the cause.
 *    Doing it here makes the guarantee exact — it does not depend on having
 *    recognised the old file beforehand.
 *
 * Best-effort: a jar without metadata, or an unreadable folder, must never fail an
 * install that already succeeded.
 */
export async function reconcileInstalledMod(
  destPath: string,
  source: ResourceSource,
  projectId: string,
): Promise<void> {
  const dir = dirname(destPath);
  const keepName = basename(destPath);
  try {
    const meta = await readModMetaOf(destPath);
    if (meta.ids.length === 0) return;
    rememberProjectModIds(source, projectId, meta.ids);

    const wanted = new Set(meta.ids.map(normalizeModKey));
    for (const other of await scanModsMeta(dir)) {
      if (other.file === keepName) continue;
      if (!other.ids.some((id) => wanted.has(normalizeModKey(id)))) continue;
      try {
        rmSync(join(dir, other.file), { force: true });
      } catch {
        /* Leave it rather than failing the install. */
      }
    }
  } catch {
    /* Metadata is a bonus, not a requirement. */
  }
}

export function listInstalledResources(type: ResourceType, target: ResourceInstallTarget): ResourceFileInfo[] {
  if (type === 'modpack') return [];
  const dir = resolveTargetDir(type, target);
  const out: ResourceFileInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!hasAllowedExtension(type, name)) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* ignore unreadable entries */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function removeResource(type: ResourceType, filename: string, target: ResourceInstallTarget): void {
  if (type === 'modpack') throw new Error('请删除整个游戏版本来移除整合包');
  const safe = basename(filename);
  if (!hasAllowedExtension(type, safe)) throw new Error('无效的文件名');
  const dir = resolveTargetDir(type, target);
  rmSync(join(dir, safe), { force: true });
}

// ---- modpack (.mrpack) installation ----

/** Join a zip-relative path onto a base directory, rejecting path traversal. */
function safeJoin(base: string, entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('整合包包含非法路径');
  }
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) throw new Error('整合包包含非法路径');
  const dest = join(base, ...segments);
  const rel = relative(base, dest);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('整合包包含非法路径');
  return dest;
}

function sanitizeVersionName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || 'Modpack';
}

function uniqueVersionName(base: string): string {
  const existing = new Set(listLocalVersions().map((v) => v.id));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

function detectLoader(deps: Record<string, string>): 'fabric' | 'forge' | 'neoforge' | undefined {
  if (deps['fabric-loader']) return 'fabric';
  if (deps.neoforge) return 'neoforge';
  if (deps.forge) return 'forge';
  return undefined;
}

/**
 * Overall progress budget for a modpack install. Each stage reserves a slice so
 * the bar never jumps backwards when the inner version installer reports its own
 * 0..1 progress.
 */
const PACK_SLICE = { from: 0.01, to: 0.05 } as const;
const CORE_SLICE = { from: 0.05, to: 0.5 } as const;
const OVERRIDE_SLICE = { from: 0.5, to: 0.55 } as const;
const FILES_SLICE = { from: 0.55, to: 1 } as const;

/** Map a child stage's 0..1 progress into an overall slice. */
function mapProgress(slice: { from: number; to: number }, progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return slice.from + clamped * (slice.to - slice.from);
}

/**
 * Install a Modrinth modpack (.mrpack):
 * 1. create the matching Minecraft version (plus its mod loader),
 * 2. download every file listed in `modrinth.index.json`,
 * 3. unpack `overrides/` and `client-overrides/` into the new game directory.
 */
export async function installModrinthModpack(
  projectId: string,
  versionId: string,
  name: string | undefined,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<ModpackInstallResult> {
  const version = await modrinthGet<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`);
  if (version.project_id !== projectId) throw new Error('版本与项目不匹配');

  const packFile = version.files.find((f) => f.filename.toLowerCase().endsWith('.mrpack'));
  if (!packFile) throw new Error('该版本不提供整合包文件');

  const tmpFile = join(tmpdir(), `slcl-pack-${randomUUID()}.mrpack`);
  try {
    // ---- the .mrpack itself, streamed so the bar moves during the download ----
    const packSize = packFile.size ?? 0;
    let packDone = 0;
    const emitPack = createThrottle(() => {
      onProgress({
        progress:
          packSize > 0
            ? mapProgress(PACK_SLICE, packDone / packSize)
            : PACK_SLICE.from,
        totalBytes: packSize,
        downloadedBytes: packDone,
        task: '下载整合包…',
        totalFiles: 1,
        completedFiles: 0,
      });
    });
    try {
      onProgress({ progress: 0, totalBytes: packSize, downloadedBytes: 0, task: '下载整合包…', totalFiles: 1, completedFiles: 0 });
      await downloadToFile(packFile.url, tmpFile, {
        signal,
        onBytes: (delta) => {
          packDone += delta;
          emitPack.emit();
        },
      });
    } finally {
      emitPack.stop();
    }

    // ---- pass 1: read the manifest ----
    onProgress({ progress: PACK_SLICE.to, totalBytes: 0, downloadedBytes: 0, task: '解析整合包清单…' });

    let indexRaw = '';
    let zip = await openZip(tmpFile, { lazyEntries: true, autoClose: false });
    try {
      for await (const entry of walkEntriesGenerator(zip)) {
        if (entry.fileName === 'modrinth.index.json') {
          indexRaw = (await readEntry(zip, entry)).toString('utf8');
          break;
        }
      }
    } finally {
      zip.close();
    }
    if (!indexRaw) throw new Error('整合包缺少 modrinth.index.json');

    const index = JSON.parse(indexRaw) as ModpackIndex;
    const deps = index.dependencies ?? {};
    const mcVersion = deps.minecraft;
    if (!mcVersion) throw new Error('整合包缺少 Minecraft 版本信息');
    const loader = detectLoader(deps);

    const packName = uniqueVersionName(sanitizeVersionName(name?.trim() || version.name || 'Modpack'));
    // The version installer reports its own 0..1 progress; fold it into the slice so
    // the overall bar keeps climbing instead of dropping back to a stage constant.
    const newId = await installVersion(mcVersion, { loader, name: packName }, (p) => {
      onProgress({
        progress: mapProgress(CORE_SLICE, p.progress),
        totalBytes: p.totalBytes,
        downloadedBytes: p.downloadedBytes,
        task: p.task,
        totalFiles: p.totalFiles,
        completedFiles: p.completedFiles,
      });
    });
    const gameDir = getVersionGameDir(newId);

    // ---- pass 2: unpack overrides ----
    onProgress({ progress: OVERRIDE_SLICE.from, totalBytes: 0, downloadedBytes: 0, task: '解压整合包配置…' });
    zip = await openZip(tmpFile, { lazyEntries: true, autoClose: false });
    try {
      for await (const entry of walkEntriesGenerator(zip)) {
        if (entry.fileName.endsWith('/')) continue;
        const prefix = entry.fileName.startsWith('overrides/')
          ? 'overrides/'
          : entry.fileName.startsWith('client-overrides/')
            ? 'client-overrides/'
            : null;
        if (!prefix) continue;
        const relPath = entry.fileName.slice(prefix.length);
        if (!relPath) continue;
        const dest = safeJoin(gameDir, relPath);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, await readEntry(zip, entry));
      }
    } finally {
      zip.close();
    }

    // ---- download the listed files (parallel, byte-accurate, cancellable) ----
    const files = (index.files ?? []).filter((f) => f.env?.client !== 'unsupported');
    const total = files.length;
    const totalBytes = files.reduce((sum, f) => sum + (f.fileSize ?? 0), 0);
    let done = 0;
    let doneBytes = 0;
    // Bytes of the files currently in flight, so the bar moves during a single big mod.
    const inFlight = new Map<number, number>();
    const sumInFlight = (): number => {
      let sum = 0;
      for (const v of inFlight.values()) sum += v;
      return sum;
    };

    const emitFiles = createThrottle(() => {
      const bytes = doneBytes + sumInFlight();
      const ratio = totalBytes > 0 ? Math.min(1, bytes / totalBytes) : done / Math.max(total, 1);
      onProgress({
        progress: mapProgress(FILES_SLICE, ratio),
        totalBytes,
        downloadedBytes: bytes,
        task: `下载整合包文件 (${Math.min(done + 1, total)}/${total})`,
        totalFiles: total,
        completedFiles: done,
      });
    });

    try {
      onProgress({
        progress: FILES_SLICE.from,
        totalBytes,
        downloadedBytes: 0,
        task: `下载整合包文件 (0/${total})`,
        totalFiles: total,
        completedFiles: 0,
      });
      await runPool(
        files,
        async (f, i) => {
          const url = f.downloads?.[0];
          const dest = safeJoin(gameDir, f.path);
          if (!url) {
            done += 1;
            doneBytes += f.fileSize ?? 0;
            emitFiles.emit();
            return;
          }
          let got = 0;
          inFlight.set(i, 0);
          try {
            await downloadToFile(url, dest, {
              signal,
              onBytes: (delta) => {
                got += delta;
                inFlight.set(i, got);
                emitFiles.emit();
              },
            });
          } finally {
            inFlight.delete(i);
          }
          done += 1;
          doneBytes += got > 0 ? got : (f.fileSize ?? 0);
          emitFiles.emit();
        },
        { signal, concurrency: 8 },
      );
    } finally {
      emitFiles.stop();
    }

    onProgress({
      progress: 1,
      totalBytes,
      downloadedBytes: totalBytes,
      task: '整合包安装完成',
      totalFiles: total,
      completedFiles: total,
    });
    return { versionId: newId, files: done };
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
  }
}

// ---- source dispatch (Modrinth / CurseForge) ----

/** Search the requested site with one exact keyword. */
function searchSource(
  type: ResourceType,
  query: string,
  options?: ResourceSearchOptions,
): Promise<ResourceProject[]> {
  if (options?.source === 'curseforge') return searchCurseforge(type, query, options);
  return searchModrinth(type, query, options);
}

/**
 * How many translated names are queried. One API call each, so this stays small:
 * the top mcmod hit is the exact match and already returns its own add-ons.
 */
const MAX_TRANSLATED_QUERIES = 3;

/** Default page size used by both APIs when the caller does not pass one. */
const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Merge several result lists, round-robin by position.
 *
 * Round-robin (rather than concatenation) so that a secondary name still
 * contributes: for "机械动力" the primary "Create" search fills the whole page on
 * its own, and the add-ons found via the other names would otherwise never show.
 */
function mergeRoundRobin(lists: ResourceProject[][], limit: number): ResourceProject[] {
  const out: ResourceProject[] = [];
  const seen = new Set<string>();
  const longest = lists.reduce((max, l) => Math.max(max, l.length), 0);

  for (let i = 0; i < longest && out.length < limit; i += 1) {
    for (const list of lists) {
      if (out.length >= limit) break;
      const project = list[i];
      if (!project) continue;
      // Ids are only unique within one site, so key on both.
      const key = `${project.source}:${project.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(project);
    }
  }
  return out;
}

/**
 * Search whichever site the caller asked for.
 *
 * A Chinese keyword is first resolved to the English project names it refers to
 * (see `resolveChineseNames`); Modrinth and CurseForge only index English titles,
 * so "机械动力" would otherwise match nothing but the handful of projects with
 * Chinese characters in their own title.
 *
 * Only **mods** are translated: MC百科's `class/` entries are mods exclusively
 * (verified — searching for a modpack, resource pack, shader or datapack name
 * returns unrelated mods, or nothing at all). Translating a shader keyword would
 * therefore turn "光影" into a set of *mod* names, search those with
 * `project_type:shader`, find nothing, and hide the working raw-keyword fallback.
 * English keywords skip the lookup entirely — no round trip, no behaviour change.
 */
export async function searchResources(
  type: ResourceType,
  query: string,
  options?: ResourceSearchOptions,
): Promise<ResourceSearchResult> {
  const keyword = query.trim();
  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!keyword || type !== 'mod' || !hasCjk(keyword)) {
    return { items: await searchSource(type, keyword, options) };
  }

  const names = await resolveChineseNames(keyword);
  const translated = names.slice(0, MAX_TRANSLATED_QUERIES).map((name) => name.en);
  // A confident translation replaces the raw keyword: searching both would append
  // the Chinese full-text hits, and those are mostly noise ("优化" pulls in every
  // project whose description merely mentions it). With no translation the raw
  // keyword is the fallback, i.e. exactly the previous behaviour.
  const queries = translated.length > 0 ? translated : [keyword];

  const settled = await Promise.allSettled(queries.map((q) => searchSource(type, q, options)));
  const lists = settled
    .filter((r): r is PromiseFulfilledResult<ResourceProject[]> => r.status === 'fulfilled')
    .map((r) => r.value);

  const items = mergeRoundRobin(lists, limit);
  const translatedQuery = translated[0];
  if (!translatedQuery) return { items };

  // Label the cards with the Chinese name they were found under, so the user can
  // see that "Create" is "机械动力" and that the translation was correct. The best
  // scoring name wins, never the first that merely contains the title.
  for (const project of items) {
    let best: { score: number; zh: string } | null = null;
    for (const name of names) {
      const score = chineseNameScore(name.en, project.title);
      if (score > 0 && (!best || score > best.score)) best = { score, zh: name.zh };
    }
    if (best) project.titleZh = best.zh;
  }

  return { items, translatedQuery };
}

/** List downloadable versions/fils of a project on the requested site. */
export async function listResourceVersions(
  type: ResourceType,
  projectId: string,
  options?: ResourceSearchOptions,
): Promise<ResourceVersion[]> {
  if (options?.source === 'curseforge') return listCurseforgeVersions(type, projectId, options);
  return listModrinthVersions(type, projectId, options);
}

/**
 * Every Minecraft version and mod loader a project ships files for.
 *
 * Backs the install dialog's two filters, which must not offer values the resource
 * never supported — picking one produced an empty version list with no obvious way
 * back. Both sources expose the whole matrix in one request (Modrinth's project
 * document, CurseForge's `latestFilesIndexes`), so this stays cheap even for
 * projects with thousands of files.
 */
export async function supportedGameSupport(
  projectId: string,
  source: ResourceSource = 'modrinth',
): Promise<{ gameVersions: string[]; loaders: string[] }> {
  if (source === 'curseforge') return listCurseforgeSupport(projectId);
  const project = await modrinthGet<{ game_versions?: string[]; loaders?: string[] }>(
    `/project/${encodeURIComponent(projectId)}`,
  );
  return {
    gameVersions: project.game_versions ?? [],
    loaders: project.loaders ?? [],
  };
}

/** Cap on how many dependency versions are offered in the picker. */
const MAX_DEPENDENCY_CANDIDATES = 60;

/**
 * List Modrinth versions of a project that could satisfy a dependency, best first.
 *
 * Ordering is deliberate and is what the picker shows top-to-bottom:
 *   1. matches the dependent's game version *and* loader
 *   2. matches the game version only
 *   3. matches the loader only
 *   4. everything else
 * Within each group the newest release wins, then newest overall.
 *
 * The API is asked to filter first: a project like JEI has ~4000 versions, and
 * downloading all of them just to filter locally times out and silently yields
 * "no dependency found". Only when the filtered query comes back empty does it fall
 * back to the full list and rank locally.
 */
async function listModrinthProjectVersions(
  projectId: string,
  gameVersions?: string[],
  loaders?: string[],
): Promise<ResourceVersion[]> {
  const games = (gameVersions ?? []).filter(Boolean);
  const lds = (loaders ?? []).filter(Boolean);
  const wantGames = new Set(games.map((g) => g.toLowerCase()));
  const wantLoaders = new Set(lds.map((l) => l.toLowerCase()));

  const query = async (params: URLSearchParams): Promise<ModrinthVersion[]> => {
    const qs = params.toString();
    try {
      return await modrinthGet<ModrinthVersion[]>(
        `/project/${encodeURIComponent(projectId)}/version${qs ? `?${qs}` : ''}`,
      );
    } catch {
      return [];
    }
  };

  const usable = (raw: ModrinthVersion[]): ModrinthVersion[] =>
    raw.filter((v) => Array.isArray(v.files) && v.files.length > 0 && pickPrimaryFile(v.files));

  const filtered = new URLSearchParams();
  if (games.length > 0) filtered.set('game_versions', JSON.stringify(games));
  if (lds.length > 0) filtered.set('loaders', JSON.stringify(lds));
  let pool = usable(await query(filtered));
  if (pool.length === 0 && (games.length > 0 || lds.length > 0)) {
    pool = usable(await query(new URLSearchParams()));
  }
  if (pool.length === 0) return [];

  const matchesGames = (v: ModrinthVersion): boolean =>
    wantGames.size === 0 || (v.game_versions ?? []).some((g) => wantGames.has(g.toLowerCase()));
  const matchesLoaders = (v: ModrinthVersion): boolean =>
    wantLoaders.size === 0 || (v.loaders ?? []).some((l) => wantLoaders.has(l.toLowerCase()));

  const rank = (v: ModrinthVersion): number => {
    const g = matchesGames(v);
    const l = matchesLoaders(v);
    if (g && l) return 0;
    if (g) return 1;
    if (l) return 2;
    return 3;
  };

  const byDate = (a: ModrinthVersion, b: ModrinthVersion): number =>
    Date.parse(b.date_published) - Date.parse(a.date_published);
  const byRelease = (a: ModrinthVersion, b: ModrinthVersion): number => {
    const weight = (t: string): number => (t === 'release' ? 0 : t === 'beta' ? 1 : 2);
    return weight(a.version_type) - weight(b.version_type);
  };

  return [...pool]
    .sort((a, b) => rank(a) - rank(b) || byRelease(a, b) || byDate(a, b))
    .slice(0, MAX_DEPENDENCY_CANDIDATES)
    .map((v) => {
      const file = pickPrimaryFile(v.files) as ModrinthFile;
      return {
        id: v.id,
        name: v.name,
        versionNumber: v.version_number,
        versionType: v.version_type,
        datePublished: v.date_published,
        downloads: v.downloads ?? 0,
        gameVersions: v.game_versions ?? [],
        loaders: v.loaders ?? [],
        filename: file.filename,
        fileSize: file.size,
        url: file.url,
        dependencies: toModrinthDependencies(v.dependencies),
      };
    });
}

// ---- dependency (前置模组) resolution ----

/**
 * How deep the resolver walks dependencies of dependencies.
 *
 * Two nested levels cover the real cases (mod -> API -> core API). Deeper chains
 * almost always end in something already installed, and every level costs requests.
 */
const MAX_DEPENDENCY_DEPTH = 3;

/**
 * Projects that must never be offered as a dependency, keyed by `source:id`.
 *
 * Fabric API is installed automatically with every Fabric version (see
 * `versions/fabricApi`), so listing it as a prerequisite would make the user
 * download the same jar twice — and on an already-prepared version it is noise.
 */
const AUTO_INSTALLED_PROJECTS = new Set([
  'modrinth:P7dR8mSH', // Fabric API
  'curseforge:306612', // Fabric API
]);

/** Titles + slugs for a batch of Modrinth project ids (one request). */
async function lookupModrinthProjects(
  projectIds: readonly string[],
): Promise<Map<string, { title: string; slug: string }>> {
  const out = new Map<string, { title: string; slug: string }>();
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return out;
  try {
    const list = await modrinthGet<Array<{ id: string; title: string; slug: string }>>(
      `/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`,
    );
    for (const project of list) {
      out.set(project.id, { title: project.title, slug: project.slug });
    }
  } catch {
    /* Titles are cosmetic; the id is shown instead. */
  }
  return out;
}

/** Fetch one Modrinth version by id (used when an author pins a dependency version). */
async function lookupModrinthVersionById(versionId: string): Promise<ResourceVersion | null> {
  try {
    const v = await modrinthGet<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`);
    const file = pickPrimaryFile(v.files);
    if (!file) return null;
    return {
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      versionType: v.version_type,
      datePublished: v.date_published,
      downloads: v.downloads ?? 0,
      gameVersions: v.game_versions ?? [],
      loaders: v.loaders ?? [],
      filename: file.filename,
      fileSize: file.size,
      url: file.url,
      dependencies: toModrinthDependencies(v.dependencies),
    };
  } catch {
    return null;
  }
}

/**
 * Turn a version's declared dependencies into something the UI can act on.
 *
 * For each dependency this resolves the title, the versions the user may pick
 * (best match first), and whether it is already present. Recurses into the
 * dependencies of the *selected* version, bounded by `MAX_DEPENDENCY_DEPTH` and
 * guarded against cycles.
 *
 * `gameVersions` / `loaders` must describe the dependent version's own support, not
 * the dialog filters: a 1.20.1 Forge mod needs a 1.20.1 Forge dependency even when
 * the user is browsing "全部版本". Matching "anything" produced 26.4 builds for
 * 1.20.1 mods.
 */
export async function resolveResourceDependencies(
  type: ResourceType,
  dependencies: ResourceDependency[] | undefined,
  options: {
    source: ResourceSource;
    gameVersions?: string[];
    loaders?: string[];
    target: ResourceInstallTarget;
  },
): Promise<ResolvedDependency[]> {
  if (!dependencies || dependencies.length === 0) return [];

  const source = options.source;
  /**
   * Keep only what the launcher is willing to show and install.
   *
   * Two filters, both applied at *every* depth:
   *   - `optional` dependencies are dropped entirely. They are a suggestion from
   *     the author, not a prerequisite: listing them next to the real ones made the
   *     panel read as "install all of this or it breaks", which is wrong.
   *   - auto-installed projects (Fabric API) are dropped: they ship with the
   *     loader already, so offering them would mean downloading the same jar twice.
   *
   * The depth matters: Fabric API is a dependency *of* other dependencies too
   * (Create Fabric depends on it), so filtering only the entry list still let it
   * through as a child row.
   */
  const keep = (deps: ResourceDependency[]): ResourceDependency[] =>
    deps.filter(
      (dep) =>
        dep.kind === 'required' && !AUTO_INSTALLED_PROJECTS.has(`${source}:${dep.projectId}`),
    );

  const declared = keep(dependencies);
  if (declared.length === 0) return [];

  /**
   * What is already on disk, indexed two ways.
   *
   * `byFile` answers "is this exact build installed". `byModId` answers the more
   * useful question "is this *mod* installed" and is what makes a version switch
   * behave: without it, picking 6.0.7 while 6.0.8 is present looked uninstalled and
   * would have written a second jar with the same modId.
   *
   * Only mods have modIds; other resource types fall back to filenames.
   */
  const byFile = new Map<string, { filename: string; version: string }>();
  const byModId = new Map<string, { filename: string; version: string }>();
  try {
    const dir = resolveTargetDir(type, options.target);
    for (const f of listInstalledResources(type, options.target)) {
      byFile.set(f.name, { filename: f.name, version: '' });
    }
    if (type === 'mod') {
      for (const meta of await scanModsMeta(dir)) {
        const entry = { filename: meta.file, version: meta.version };
        for (const id of meta.ids) {
          byModId.set(normalizeModKey(id), entry);
        }
        // A jar whose version came from metadata is more informative than the name.
        if (meta.version) byFile.set(meta.file, entry);
      }
    }
  } catch {
    /* Target folder may not exist yet; nothing is installed then. */
  }

  /** Resolve which installed jar, if any, satisfies a dependency's project. */
  const findInstalled = (dep: ResourceDependency, slug: string, title: string): ResolvedDependency['installedFile'] => {
    if (type !== 'mod') return undefined;
    // 1) Learned association (exact, once the project has been installed by us).
    for (const id of knownProjectModIds(source, dep.projectId)) {
      const hit = byModId.get(normalizeModKey(id));
      if (hit) return hit;
    }
    // 2) Heuristic: slug / title usually equal the modId.
    for (const guess of guessProjectModIds(slug, title)) {
      const hit = byModId.get(normalizeModKey(guess));
      if (hit) return hit;
    }
    return undefined;
  };

  const isModrinth = source !== 'curseforge';

  const resolveLevel = async (
    deps: ResourceDependency[],
    depth: number,
    seen: Set<string>,
  ): Promise<ResolvedDependency[]> => {
    const fresh = deps.filter(
      (d) =>
        d.kind === 'required' &&
        !seen.has(d.projectId) &&
        !AUTO_INSTALLED_PROJECTS.has(`${source}:${d.projectId}`),
    );
    if (fresh.length === 0) return [];
    for (const d of fresh) seen.add(d.projectId);

    const projectIds = fresh.map((d) => d.projectId);
    const info = isModrinth
      ? await lookupModrinthProjects(projectIds)
      : await lookupCurseforgeProjects(projectIds);

    const resolved: ResolvedDependency[] = [];
    for (const dep of fresh) {
      const meta = info.get(dep.projectId);
      const title = meta?.title ?? dep.projectId;

      // A pinned version id wins; otherwise offer every compatible version with
      // the best match first, and let the user override it in the dropdown.
      let candidates: ResourceVersion[] = [];
      if (dep.versionId) {
        const pinned = await lookupModrinthVersionById(dep.versionId);
        if (pinned) candidates = [pinned];
      }
      if (candidates.length === 0) {
        candidates = await (isModrinth
          ? listModrinthProjectVersions(dep.projectId, options.gameVersions, options.loaders)
          : listCurseforgeProjectVersions(dep.projectId, options.gameVersions, options.loaders));
      }
      const version = candidates[0] ?? null;

      // Exact file first, then "any version of this mod".
      const installedExact = candidates
        .map((c) => byFile.get(basename(c.filename)))
        .find((hit) => hit !== undefined);
      const installedFile = installedExact ?? findInstalled(dep, meta?.slug ?? '', title);
      const installed = installedFile !== undefined;

      let problem: string | undefined;
      if (!version) {
        const scoped = (options.gameVersions?.length ?? 0) + (options.loaders?.length ?? 0) > 0;
        problem = scoped ? '没有匹配该模组游戏版本与加载器的文件' : '未找到可下载的文件';
      }

      const children =
        version && depth < MAX_DEPENDENCY_DEPTH
          ? await resolveLevel(version.dependencies ?? [], depth + 1, seen)
          : [];

      resolved.push({
        ...dep,
        title,
        slug: meta?.slug ?? dep.projectId,
        candidates,
        version,
        ...(problem ? { problem } : {}),
        installed,
        ...(installedFile ? { installedFile } : {}),
        children,
      });
    }
    return resolved;
  };

  return resolveLevel(declared, 0, new Set());
}

/** Download one specific file of a project into the resolved target folder. */
export async function installResource(
  type: ResourceType,
  projectId: string,
  versionId: string,
  target: ResourceInstallTarget,
  source: ResourceSource = 'modrinth',
): Promise<ResourceInstallResult> {
  if (source === 'curseforge') {
    return installCurseforge(type, projectId, versionId, target, resolveTargetDir, reconcileInstalledMod);
  }
  return installModrinth(type, projectId, versionId, target);
}

/** Install a modpack (Modrinth .mrpack or CurseForge .zip with manifest.json). */
/**
 * Abort controller for a modpack install.
 *
 * The version installer owns its own controller, but it clears it once the version
 * is created — the mod file downloads that follow would then be uncancellable and
 * the UI's "cancel" button would appear dead. This controller covers the whole
 * modpack session, and the IPC cancel handler aborts both.
 */
let modpackAbort: AbortController | null = null;

export function cancelModpackInstall(): void {
  modpackAbort?.abort();
}

export async function installModpack(
  projectId: string,
  versionId: string,
  name: string | undefined,
  onProgress: (p: DownloadProgress) => void,
  source: ResourceSource = 'modrinth',
): Promise<ModpackInstallResult> {
  if (modpackAbort) throw new Error('已有整合包安装任务在进行中,请稍候');
  const controller = new AbortController();
  modpackAbort = controller;
  try {
    if (source === 'curseforge') {
      return await installCurseforgeModpack(projectId, versionId, name, onProgress, controller.signal);
    }
    return await installModrinthModpack(projectId, versionId, name, onProgress, controller.signal);
  } catch (e) {
    if (controller.signal.aborted) throw new Error('已取消');
    throw e;
  } finally {
    modpackAbort = null;
  }
}

/**
 * MC百科 entry for a project, used by the resource cards' quick links.
 * Returns a direct entry URL when a confident title match exists, plus a search URL
 * that always works.
 */
export async function mcmodLink(title: string): Promise<{ url: string | null; search: string }> {
  return resolveMcmodLink(title);
}

/**
 * Chinese names for a page of cards (cached only, instant).
 *
 * Every card should read in Chinese where a Chinese name exists — not just the
 * ones a Chinese search happened to find. Whatever is already known comes back
 * immediately; the rest is queued in the background, because mcmod allows about
 * one request per second and a page holds ~20 cards.
 */
export function cachedZhNames(titles: readonly string[]): Record<string, string> {
  return zhNameCache(titles);
}

/** Queue background lookups for a page; results arrive via `onZhNameResolved`. */
export function queueZhNames(titles: readonly string[]): void {
  zhNameQueue(titles);
}

/** Subscribe to background name resolutions (main-process side). */
export function onZhNameResolved(listener: (p: { title: string; zh: string }) => void): () => void {
  return zhNameSubscribe(listener);
}
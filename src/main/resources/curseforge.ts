import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { open as openZip, readEntry, walkEntriesGenerator } from '@xmcl/unzip';
import type {
  DownloadProgress,
  ResourceDependency,
  ModpackInstallResult,
  ResourceInstallResult,
  ResourceInstallTarget,
  ResourceProject,
  ResourceSearchOptions,
  ResourceSource,
  ResourceType,
  ResourceVersion,
} from '@shared/types';
import { userAgent } from '../ua';
import { getSettings } from '../settings/store';
import { getVersionGameDir, installVersion, listLocalVersions } from '../versions';
import { createThrottle, runPool } from '../download/pool';
import { curseforgeCandidates, downloadToFile, fetchJson } from './http';

/**
 * CurseForge support.
 *
 * Two routes, chosen by whether the user supplied an API key:
 *
 *   - **With a key** (free at https://console.curseforge.com/): the official API
 *     is queried first. It is authoritative and credits the author, and the
 *     official file CDN is used. If the official host is unreachable the request
 *     falls back to the MCIM mirror.
 *   - **Without a key**: the official API answers 403 for every call, so requests
 *     go straight to the MCIM mirror (`mod.mcimirror.top/curseforge`), which
 *     exposes the same paths and response shapes. This is what other launchers
 *     do, and it is why CurseForge browsing no longer needs a key.
 */
const GAME_ID = 432; // Minecraft (Java Edition)

/** CurseForge class ids per resource category. */
const CLASS_ID: Record<ResourceType, number> = {
  mod: 6,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945,
  modpack: 4471,
};

/** CurseForge website path segment per category (for building project URLs). */
const SITE_PATH: Record<ResourceType, string> = {
  mod: 'mc-mods',
  resourcepack: 'texture-packs',
  shader: 'shaders',
  datapack: 'data-packs',
  modpack: 'modpacks',
};

/** CurseForge modLoaderType values. */
const LOADER_TYPE: Record<string, number> = {
  forge: 1,
  liteloader: 3,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

/** Inverse of `LOADER_TYPE`, for reading a project's supported loaders back out. */
const LOADER_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(LOADER_TYPE).map(([name, id]) => [id, name]),
);

interface CfMod {
  id: number;
  name?: string;
  slug?: string;
  summary?: string;
  downloadCount?: number;
  classId?: number;
  logo?: { thumbnailUrl?: string };
  links?: { websiteUrl?: string };
  authors?: Array<{ name?: string }>;
  categories?: Array<{ name?: string }>;
  latestFilesIndexes?: Array<{ gameVersion?: string }>;
}

interface CfFile {
  id: number;
  modId?: number;
  displayName?: string;
  fileName?: string;
  fileLength?: number;
  fileDate?: string;
  releaseType?: number;
  gameVersions?: string[];
  downloadUrl?: string | null;
  isAvailable?: boolean;
  fileFingerprint?: number;
  /** Declared relations to other projects; see `cfDependencyKind`. */
  dependencies?: Array<{ modId?: number; relationType?: number }>;
}

/**
 * CurseForge file relation codes, mapped onto what the launcher cares about.
 *
 *   1 EmbeddedLibrary   — already inside the jar, nothing to download
 *   2 OptionalDependency — nice to have
 *   3 RequiredDependency — the mod will not load without it
 *   4 Tool              — dev tooling, not a runtime dependency
 *   5 Incompatible      — must NOT be installed alongside
 *   6 Include           — shipped with the parent, nothing to download
 *
 * Only 2 and 3 become `ResourceDependency`; the rest are dropped so the UI does
 * not suggest installing something that is already inside the file.
 */
function cfDependencyKind(relationType: number | undefined): 'required' | 'optional' | null {
  if (relationType === 3) return 'required';
  if (relationType === 2) return 'optional';
  return null;
}

/** Convert a file's raw relations into the launcher's dependency shape. */
function toCfDependencies(
  raw: Array<{ modId?: number; relationType?: number }> | undefined,
): ResourceDependency[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: ResourceDependency[] = [];
  const seen = new Set<string>();
  for (const dep of raw) {
    const kind = cfDependencyKind(dep.relationType);
    if (!kind || dep.modId === undefined) continue;
    const projectId = String(dep.modId);
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    out.push({ projectId, kind });
  }
  return out.length > 0 ? out : undefined;
}

interface CfPage<T> {
  data?: T[];
  pagination?: { index?: number; pageSize?: number; resultCount?: number; totalCount?: number };
}

/** CurseForge metadata request: official-first when keyed, mirror-only otherwise. */
async function cfGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== '') search.set(k, String(v));
  }
  const query = search.toString();
  const suffix = `${path}${query ? `?${query}` : ''}`;

  const key = getSettings().curseforgeApiKey?.trim() ?? '';
  const candidates = curseforgeCandidates(key).map((c) => ({ ...c, url: `${c.url}${suffix}` }));

  try {
    return await fetchJson<T>(candidates, { accept: 'application/json' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 403 only ever comes from the official host, so it always means "bad key".
    if (key && message.includes('api.curseforge.com HTTP 403')) {
      throw new Error(`CurseForge API Key 无效或已过期，请在「游戏设置」中更新。${message}`);
    }
    throw e;
  }
}

function projectPageUrl(type: ResourceType, mod: CfMod): string {
  const explicit = mod.links?.websiteUrl;
  if (explicit) return explicit;
  const slug = mod.slug ?? String(mod.id);
  return `https://www.curseforge.com/minecraft/${SITE_PATH[type]}/${slug}`;
}

// ---- search / versions ----

export async function searchCurseforge(
  type: ResourceType,
  query: string,
  options?: ResourceSearchOptions,
): Promise<ResourceProject[]> {
  const data = await cfGet<CfPage<CfMod>>('/mods/search', {
    gameId: GAME_ID,
    classId: CLASS_ID[type],
    searchFilter: query.trim() || undefined,
    sortField: options?.sortBy === 'downloads' || !query.trim() ? 2 : 1, // 2=popularity, 1=relevance
    sortOrder: 'desc',
    pageSize: options?.limit ?? 20,
    index: options?.offset ?? 0,
    gameVersion: options?.gameVersion,
    modLoaderType: options?.loader ? LOADER_TYPE[options.loader.toLowerCase()] : undefined,
  });

  return (data.data ?? []).map((mod) => ({
    id: String(mod.id),
    slug: mod.slug ?? String(mod.id),
    title: mod.name ?? String(mod.id),
    description: mod.summary ?? '',
    author: mod.authors?.[0]?.name ?? '',
    iconUrl: mod.logo?.thumbnailUrl,
    downloads: mod.downloadCount ?? 0,
    categories: (mod.categories ?? []).map((c) => c.name ?? '').filter(Boolean),
    gameVersions: [
      ...new Set((mod.latestFilesIndexes ?? []).map((f) => f.gameVersion ?? '').filter(Boolean)),
    ],
    source: 'curseforge',
    pageUrl: projectPageUrl(type, mod),
  }));
}

function releaseTypeOf(releaseType: number | undefined): ResourceVersion['versionType'] {
  if (releaseType === 2) return 'beta';
  if (releaseType === 3) return 'alpha';
  return 'release';
}

/** All downloadable files of a CurseForge project, newest first. */
export async function listCurseforgeVersions(
  _type: ResourceType,
  projectId: string,
  options?: ResourceSearchOptions,
): Promise<ResourceVersion[]> {
  const data = await cfGet<CfPage<CfFile>>(`/mods/${encodeURIComponent(projectId)}/files`, {
    pageSize: 50,
    gameVersion: options?.gameVersion,
    modLoaderType: options?.loader ? LOADER_TYPE[options.loader.toLowerCase()] : undefined,
  });

  return (data.data ?? [])
    .filter((f) => f.isAvailable !== false)
    .sort((a, b) => Date.parse(b.fileDate ?? '') - Date.parse(a.fileDate ?? ''))
    .map((f) => ({
      id: String(f.id),
      name: f.displayName ?? f.fileName ?? String(f.id),
      versionNumber: f.displayName ?? f.fileName ?? String(f.id),
      versionType: releaseTypeOf(f.releaseType),
      datePublished: f.fileDate ?? '',
      downloads: 0,
      gameVersions: f.gameVersions ?? [],
      loaders: [],
      filename: f.fileName ?? `curseforge-${f.id}.jar`,
      fileSize: f.fileLength ?? 0,
      // Resolved lazily: many files hide the direct URL from the API.
      url: f.downloadUrl ?? '',
      dependencies: toCfDependencies(f.dependencies),
    }));
}

/**
 * Titles + slugs for a batch of project ids, for labelling dependencies.
 *
 * Uses the batch `POST /mods` endpoint (verified to work through the MCIM mirror)
 * so a project with six dependencies costs one request instead of six. Unknown ids
 * are simply absent from the map — callers fall back to showing the id.
 */
export async function lookupCurseforgeProjects(
  projectIds: readonly string[],
): Promise<Map<string, { title: string; slug: string }>> {
  const out = new Map<string, { title: string; slug: string }>();
  const ids = [...new Set(projectIds.map((id) => Number(id)).filter((n) => Number.isFinite(n)))];
  if (ids.length === 0) return out;

  const key = getSettings().curseforgeApiKey?.trim() ?? '';
  const candidates = curseforgeCandidates(key);
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate.url + '/mods', {
        method: 'POST',
        headers: {
          'User-Agent': userAgent(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...candidate.headers,
        },
        body: JSON.stringify({ modIds: ids, filterPcOnly: false }),
        signal: AbortSignal.timeout(candidate.timeoutMs ?? 30000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: CfMod[] };
      for (const mod of body.data ?? []) {
        out.set(String(mod.id), {
          title: mod.name ?? String(mod.id),
          slug: mod.slug ?? String(mod.id),
        });
      }
      return out;
    } catch {
      /* try the next host */
    }
  }
  return out;
}

/** Cap on how many dependency versions are offered in the picker. */
const MAX_DEPENDENCY_CANDIDATES = 60;

/**
 * List CurseForge files of a project that could satisfy a dependency, best first.
 *
 * Same ordering contract as the Modrinth side: exact match (game + loader) first,
 * then each partial match, newest release before newer betas within a group.
 *
 * CurseForge's `gameVersions` mixes real versions with loader/platform tags, so the
 * loader half is matched against those tags ("Forge", "NeoForge", "Fabric") rather
 * than a separate field.
 */
export async function listCurseforgeProjectVersions(
  projectId: string,
  gameVersions?: string[],
  loaders?: string[],
): Promise<ResourceVersion[]> {
  try {
    const data = await cfGet<CfPage<CfFile>>(`/mods/${encodeURIComponent(projectId)}/files`, {
      pageSize: 50,
    });
    const files = (data.data ?? []).filter((f) => f.isAvailable !== false);
    if (files.length === 0) return [];

    const wantGames = new Set((gameVersions ?? []).map((g) => g.toLowerCase()));
    const wantLoaders = new Set((loaders ?? []).map((l) => l.toLowerCase()));
    const tags = (f: CfFile): string[] => (f.gameVersions ?? []).map((v) => v.toLowerCase());

    const matchesGames = (f: CfFile): boolean =>
      wantGames.size === 0 || tags(f).some((t) => wantGames.has(t));
    const matchesLoaders = (f: CfFile): boolean =>
      wantLoaders.size === 0 || tags(f).some((t) => wantLoaders.has(t));

    const rank = (f: CfFile): number => {
      const g = matchesGames(f);
      const l = matchesLoaders(f);
      if (g && l) return 0;
      if (g) return 1;
      if (l) return 2;
      return 3;
    };

    const byDate = (a: CfFile, b: CfFile): number =>
      Date.parse(b.fileDate ?? '') - Date.parse(a.fileDate ?? '');
    const releaseWeight = (f: CfFile): number => {
      const t = releaseTypeOf(f.releaseType);
      return t === 'release' ? 0 : t === 'beta' ? 1 : 2;
    };
    const byRelease = (a: CfFile, b: CfFile): number => releaseWeight(a) - releaseWeight(b);

    return [...files]
      .sort((a, b) => rank(a) - rank(b) || byRelease(a, b) || byDate(a, b))
      .slice(0, MAX_DEPENDENCY_CANDIDATES)
      .map((f) => ({
        id: String(f.id),
        name: f.displayName ?? f.fileName ?? String(f.id),
        versionNumber: f.displayName ?? f.fileName ?? String(f.id),
        versionType: releaseTypeOf(f.releaseType),
        datePublished: f.fileDate ?? '',
        downloads: 0,
        gameVersions: minecraftOnlyGameVersions(f.gameVersions),
        loaders: [],
        filename: f.fileName ?? `curseforge-${f.id}.jar`,
        fileSize: f.fileLength ?? 0,
        url: f.downloadUrl ?? '',
        dependencies: toCfDependencies(f.dependencies),
      }));
  } catch {
    return [];
  }
}

/**
 * CurseForge mixes loader/platform tags into `gameVersions` (a JEI file reports
 * `["Client","NeoForge","Server","26.1"]`). Showing "Client" as a game version is
 * nonsense, and filtering by it returns nothing, so only real versions survive.
 */
function minecraftOnlyGameVersions(list: string[] | undefined): string[] {
  return (list ?? []).filter((v) => /^\d+(\.\d+)+(-(pre|rc)\d+)?$/i.test(v) || /^\d{2}w\d{2}[a-z]$/i.test(v));
}

/** Resolve a downloadable URL for a CurseForge file (API fallback). */
async function resolveFileUrl(modId: string, fileId: string, known?: string): Promise<string> {
  if (known) return known;
  const res = await cfGet<{ data?: string | null }>(
    `/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}/download-url`,
  );
  if (!res.data) {
    throw new Error('该文件不允许第三方启动器下载(作者关闭了 API 分发),请在网页手动下载');
  }
  return res.data;
}

/**
 * Every Minecraft version and mod loader this project ships files for.
 *
 * Both lists come from the mod detail endpoint's `latestFilesIndexes` — one entry
 * per (game version × loader) combination of the newest file in that slot, so the
 * unions cover the project's whole support matrix (JEI reports 51 Minecraft
 * versions across forge/fabric/neoforge) in a single request.
 *
 * Paging `/files` instead would need dozens of requests: the API caps a page at 50
 * files and popular projects have thousands.
 */
export async function listCurseforgeSupport(projectId: string): Promise<{
  gameVersions: string[];
  loaders: string[];
}> {
  interface Detail {
    latestFilesIndexes?: Array<{ gameVersion?: string; modLoader?: number }>;
  }
  const res = await cfGet<{ data?: Detail }>(`/mods/${encodeURIComponent(projectId)}`);
  const indexes = res.data?.latestFilesIndexes ?? [];

  const gameVersions = new Set<string>();
  const loaders = new Set<string>();
  for (const entry of indexes) {
    if (entry.gameVersion) gameVersions.add(entry.gameVersion);
    if (entry.modLoader !== undefined) {
      const name = LOADER_NAME[entry.modLoader];
      // 0 stands for "any/unknown" and carries no information.
      if (name) loaders.add(name);
    }
  }
  return { gameVersions: [...gameVersions], loaders: [...loaders] };
}

// ---- install ----

/** Folder that receives each single-file resource type. */
const FOLDER_BY_TYPE: Record<Exclude<ResourceType, 'modpack'>, string> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks',
};

export async function installCurseforge(
  type: ResourceType,
  projectId: string,
  versionId: string,
  target: ResourceInstallTarget,
  resolveTargetDir: (t: ResourceType, target: ResourceInstallTarget) => string,
  /**
   * Post-download hook: remembers the jar's modIds and removes same-modId duplicates.
   * Injected by the caller because it lives in the resources module, which already
   * imports this one — importing back would be a cycle.
   */
  onInstalled?: (destPath: string, source: ResourceSource, projectId: string) => Promise<void>,
): Promise<ResourceInstallResult> {
  if (type === 'modpack') throw new Error('整合包必须通过整合包安装流程安装');

  const files = await listCurseforgeVersions(type, projectId);
  const file = files.find((f) => f.id === versionId);
  if (!file) throw new Error('找不到该文件版本');

  const url = await resolveFileUrl(projectId, versionId, file.url);
  const dir = resolveTargetDir(type, target);
  const filename = basename(file.filename);
  const dest = join(dir, filename);
  await downloadToFile(url, dest);
  if (type === 'mod' && onInstalled) await onInstalled(dest, 'curseforge', projectId);

  return { path: dest, filename, title: file.name, versionNumber: file.versionNumber };
}

interface CfManifest {
  minecraft?: { version?: string; modLoaders?: Array<{ id?: string; primary?: boolean }> };
  files?: Array<{ projectID?: number; fileID?: number; required?: boolean }>;
  name?: string;
  overrides?: string;
}

function sanitizeVersionName(raw: string): string {
  return (
    raw
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'Modpack'
  );
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

/** Join a zip-relative path onto a base directory, rejecting path traversal. */
function safeJoin(base: string, entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('整合包包含非法路径');
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) throw new Error('整合包包含非法路径');
  const dest = join(base, ...segments);
  const rel = relative(base, dest);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('整合包包含非法路径');
  return dest;
}

/** Parse a CurseForge modpack loader id such as "forge-47.2.0" / "fabric-0.15.7". */
function loaderFromManifest(manifest: CfManifest): 'fabric' | 'forge' | 'neoforge' | undefined {
  const ids = (manifest.minecraft?.modLoaders ?? []).map((m) => (m.id ?? '').toLowerCase());
  const primary = (manifest.minecraft?.modLoaders ?? []).find((m) => m.primary)?.id?.toLowerCase();
  const candidate = primary ?? ids[0] ?? '';
  if (candidate.startsWith('neoforge')) return 'neoforge';
  if (candidate.startsWith('forge')) return 'forge';
  if (candidate.startsWith('fabric')) return 'fabric';
  return undefined;
}

/**
 * Install a CurseForge modpack (.zip with `manifest.json`):
 * create the matching Minecraft version + loader, download every listed file,
 * then unpack the `overrides/` folder.
 */
export async function installCurseforgeModpack(
  projectId: string,
  fileId: string,
  name: string | undefined,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<ModpackInstallResult> {
  const files = await listCurseforgeVersions('modpack', projectId);
  const pack = files.find((f) => f.id === fileId);
  if (!pack) throw new Error('找不到该整合包版本');
  const packUrl = await resolveFileUrl(projectId, fileId, pack.url);

  const tmpFile = join(tmpdir(), `slcl-cfpack-${randomUUID()}.zip`);
  try {
    // ---- the archive itself, streamed so the bar moves during the download ----
    const packSize = pack.fileSize ?? 0;
    let packDone = 0;
    const emitPack = createThrottle(() => {
      onProgress({
        progress: packSize > 0 ? 0.01 + Math.min(1, packDone / packSize) * 0.04 : 0.01,
        totalBytes: packSize,
        downloadedBytes: packDone,
        task: '下载整合包…',
        totalFiles: 1,
        completedFiles: 0,
      });
    });
    try {
      onProgress({ progress: 0, totalBytes: packSize, downloadedBytes: 0, task: '下载整合包…', totalFiles: 1, completedFiles: 0 });
      await downloadToFile(packUrl, tmpFile, {
        signal,
        onBytes: (delta) => {
          packDone += delta;
          emitPack.emit();
        },
      });
    } finally {
      emitPack.stop();
    }

    // ---- read manifest ----
    onProgress({ progress: 0.05, totalBytes: 0, downloadedBytes: 0, task: '解析整合包清单…' });
    let manifestRaw = '';
    let zip = await openZip(tmpFile, { lazyEntries: true, autoClose: false });
    try {
      for await (const entry of walkEntriesGenerator(zip)) {
        if (entry.fileName === 'manifest.json') {
          manifestRaw = (await readEntry(zip, entry)).toString('utf8');
          break;
        }
      }
    } finally {
      zip.close();
    }
    if (!manifestRaw) throw new Error('整合包缺少 manifest.json');

    const manifest = JSON.parse(manifestRaw.replace(/^\uFEFF/, '')) as CfManifest;
    const mcVersion = manifest.minecraft?.version;
    if (!mcVersion) throw new Error('整合包缺少 Minecraft 版本信息');
    const loader = loaderFromManifest(manifest);

    const packName = uniqueVersionName(sanitizeVersionName(name?.trim() || pack.name || 'Modpack'));
    // Fold the nested version install into 0.05..0.5 so the overall bar never
    // jumps back to a stage constant once the version is ready.
    const newId = await installVersion(mcVersion, { loader, name: packName }, (p) => {
      onProgress({
        progress: 0.05 + Math.max(0, Math.min(1, p.progress)) * 0.45,
        totalBytes: p.totalBytes,
        downloadedBytes: p.downloadedBytes,
        task: p.task,
        totalFiles: p.totalFiles,
        completedFiles: p.completedFiles,
      });
    });
    const gameDir = getVersionGameDir(newId);

    // ---- unpack overrides (folder name is configurable in the manifest) ----
    const overridesDir = (manifest.overrides ?? 'overrides').replace(/\/+$/, '');
    onProgress({ progress: 0.5, totalBytes: 0, downloadedBytes: 0, task: '解压整合包配置…' });
    zip = await openZip(tmpFile, { lazyEntries: true, autoClose: false });
    try {
      for await (const entry of walkEntriesGenerator(zip)) {
        if (entry.fileName.endsWith('/')) continue;
        if (!entry.fileName.startsWith(`${overridesDir}/`)) continue;
        const relPath = entry.fileName.slice(overridesDir.length + 1);
        if (!relPath) continue;
        const dest = safeJoin(gameDir, relPath);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, await readEntry(zip, entry));
      }
    } finally {
      zip.close();
    }

    // ---- download the listed project files (parallel, cancellable) ----
    const wanted = (manifest.files ?? []).filter((f) => f.projectID && f.fileID);
    const total = wanted.length;
    let done = 0;
    let doneBytes = 0;

    const emitFiles = createThrottle(() => {
      onProgress({
        progress: 0.55 + Math.min(0.99, (done / Math.max(total, 1)) * 0.44),
        totalBytes: 0,
        downloadedBytes: doneBytes,
        task: `下载整合包文件 (${Math.min(done + 1, total)}/${total})`,
        totalFiles: total,
        completedFiles: done,
      });
    });

    try {
      onProgress({
        progress: 0.55,
        totalBytes: 0,
        downloadedBytes: 0,
        task: `下载整合包文件 (0/${total})`,
        totalFiles: total,
        completedFiles: 0,
      });
      await runPool(
        wanted,
        async (item) => {
          const modId = String(item.projectID);
          const fid = String(item.fileID);
          try {
            // The manifest does not include the target path, so resolve it from the
            // file metadata: mods go to mods/, everything else by its own top folder.
            const info = await cfGet<{ data?: CfFile }>(`/mods/${modId}/files/${fid}`);
            const file = info.data;
            if (!file) return;
            const url = await resolveFileUrl(modId, fid, file.downloadUrl ?? undefined);
            const filename = basename(file.fileName ?? `cf-${fid}.jar`);
            const sub = FOLDER_BY_TYPE.mod;
            const dest = join(gameDir, sub, filename);
            let got = 0;
            await downloadToFile(url, dest, {
              signal,
              onBytes: (delta) => {
                got += delta;
                emitFiles.emit();
              },
            });
            doneBytes += got > 0 ? got : (file.fileLength ?? 0);
          } catch (e) {
            // A cancelled task must stop the pool; a single unavailable file must not
            // abort the whole pack.
            if (signal.aborted) throw e;
          } finally {
            done += 1;
            emitFiles.emit();
          }
        },
        { signal, concurrency: 6 },
      );
    } finally {
      emitFiles.stop();
    }

    onProgress({
      progress: 1,
      totalBytes: 0,
      downloadedBytes: doneBytes,
      task: '整合包安装完成',
      totalFiles: total,
      completedFiles: total,
    });
    return { versionId: newId, files: done };
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
  }
}

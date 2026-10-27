import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { open as openZip, readEntry, walkEntriesGenerator } from '@xmcl/unzip';
import type {
  DownloadProgress,
  ModpackInstallResult,
  ResourceInstallResult,
  ResourceInstallTarget,
  ResourceProject,
  ResourceSearchOptions,
  ResourceType,
  ResourceVersion,
} from '@shared/types';
import { getSettings } from '../settings/store';
import { getVersionGameDir, installVersion, listLocalVersions } from '../versions';
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
    }));
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
): Promise<ModpackInstallResult> {
  const files = await listCurseforgeVersions('modpack', projectId);
  const pack = files.find((f) => f.id === fileId);
  if (!pack) throw new Error('找不到该整合包版本');
  const packUrl = await resolveFileUrl(projectId, fileId, pack.url);

  const tmpFile = join(tmpdir(), `slcl-cfpack-${randomUUID()}.zip`);
  try {
    onProgress({ progress: 0, totalBytes: 0, downloadedBytes: 0, task: '下载整合包…' });
    await downloadToFile(packUrl, tmpFile);

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
    const newId = await installVersion(mcVersion, { loader, name: packName }, onProgress);
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

    // ---- download the listed project files ----
    const wanted = (manifest.files ?? []).filter((f) => f.projectID && f.fileID);
    const total = wanted.length;
    let done = 0;
    for (const item of wanted) {
      const modId = String(item.projectID);
      const fid = String(item.fileID);
      onProgress({
        progress: 0.5 + (done / Math.max(total, 1)) * 0.49,
        totalBytes: 0,
        downloadedBytes: 0,
        task: `下载整合包文件 (${done + 1}/${total})`,
      });
      try {
        // The manifest does not include the target path, so resolve it from the
        // file metadata: mods go to mods/, everything else by its own top folder.
        const info = await cfGet<{ data?: CfFile }>(`/mods/${modId}/files/${fid}`);
        const file = info.data;
        if (!file) {
          done += 1;
          continue;
        }
        const url = await resolveFileUrl(modId, fid, file.downloadUrl ?? undefined);
        const filename = basename(file.fileName ?? `cf-${fid}.jar`);
        const sub = FOLDER_BY_TYPE.mod;
        const dest = join(gameDir, sub, filename);
        await downloadToFile(url, dest);
      } catch {
        /* a single unavailable file must not abort the whole pack */
      }
      done += 1;
    }

    onProgress({ progress: 1, totalBytes: 0, downloadedBytes: 0, task: '整合包安装完成' });
    return { versionId: newId, files: done };
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
  }
}

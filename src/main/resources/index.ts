import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { open as openZip, readEntry, walkEntriesGenerator } from '@xmcl/unzip';
import type {
  DownloadProgress,
  ModpackInstallResult,
  ResourceFileInfo,
  ResourceInstallResult,
  ResourceInstallTarget,
  ResourceProject,
  ResourceSearchOptions,
  ResourceSource,
  ResourceType,
  ResourceVersion,
} from '@shared/types';
import { getVersionGameDir, installVersion, listLocalVersions } from '../versions';
import {
  installCurseforge,
  installCurseforgeModpack,
  listCurseforgeVersions,
  searchCurseforge,
} from './curseforge';
import { downloadToFile, fetchJson, modrinthCandidates } from './http';

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

  return {
    path: dest,
    filename,
    title: version.name || version.version_number,
    versionNumber: version.version_number,
  };
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
): Promise<ModpackInstallResult> {
  const version = await modrinthGet<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`);
  if (version.project_id !== projectId) throw new Error('版本与项目不匹配');

  const packFile = version.files.find((f) => f.filename.toLowerCase().endsWith('.mrpack'));
  if (!packFile) throw new Error('该版本不提供整合包文件');

  const tmpFile = join(tmpdir(), `slcl-pack-${randomUUID()}.mrpack`);
  try {
    onProgress({ progress: 0, totalBytes: 0, downloadedBytes: 0, task: '下载整合包…' });
    await downloadToFile(packFile.url, tmpFile);

    // ---- pass 1: read the manifest ----
    onProgress({ progress: 0.05, totalBytes: 0, downloadedBytes: 0, task: '解析整合包清单…' });
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
    const newId = await installVersion(mcVersion, { loader, name: packName }, onProgress);
    const gameDir = getVersionGameDir(newId);

    // ---- pass 2: unpack overrides ----
    onProgress({ progress: 0.55, totalBytes: 0, downloadedBytes: 0, task: '解压整合包配置…' });
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

    // ---- download the listed files ----
    const files = (index.files ?? []).filter((f) => f.env?.client !== 'unsupported');
    const total = files.length;
    let done = 0;
    let doneBytes = 0;
    let totalBytes = 0;
    for (const f of files) totalBytes += f.fileSize ?? 0;

    for (const f of files) {
      const url = f.downloads?.[0];
      if (!url) {
        done += 1;
        doneBytes += f.fileSize ?? 0;
        continue;
      }
      const dest = safeJoin(gameDir, f.path);
      onProgress({
        progress: 0.55 + (done / Math.max(total, 1)) * 0.44,
        totalBytes,
        downloadedBytes: doneBytes,
        task: `下载整合包文件 (${done + 1}/${total})`,
      });
      await downloadToFile(url, dest);
      done += 1;
      doneBytes += f.fileSize ?? 0;
    }

    onProgress({ progress: 1, totalBytes, downloadedBytes: totalBytes, task: '整合包安装完成' });
    return { versionId: newId, files: done };
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
  }
}

// ---- source dispatch (Modrinth / CurseForge) ----

/** Search whichever site the caller asked for. */
export async function searchResources(
  type: ResourceType,
  query: string,
  options?: ResourceSearchOptions,
): Promise<ResourceProject[]> {
  if (options?.source === 'curseforge') return searchCurseforge(type, query, options);
  return searchModrinth(type, query, options);
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

/** Download one specific file of a project into the resolved target folder. */
export async function installResource(
  type: ResourceType,
  projectId: string,
  versionId: string,
  target: ResourceInstallTarget,
  source: ResourceSource = 'modrinth',
): Promise<ResourceInstallResult> {
  if (source === 'curseforge') {
    return installCurseforge(type, projectId, versionId, target, resolveTargetDir);
  }
  return installModrinth(type, projectId, versionId, target);
}

/** Install a modpack (Modrinth .mrpack or CurseForge .zip with manifest.json). */
export async function installModpack(
  projectId: string,
  versionId: string,
  name: string | undefined,
  onProgress: (p: DownloadProgress) => void,
  source: ResourceSource = 'modrinth',
): Promise<ModpackInstallResult> {
  if (source === 'curseforge') {
    return installCurseforgeModpack(projectId, versionId, name, onProgress);
  }
  return installModrinthModpack(projectId, versionId, name, onProgress);
}

import { spawn } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ModLoader } from '@shared/types';
import { fetchMirrored, mirrorCandidates } from '../download/bmcl';
import { userAgent } from '../ua';

async function getText(url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const res = await fetchMirrored(url, { headers: { 'User-Agent': userAgent(), ...headers }, signal });
  return res.text();
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return JSON.parse(await getText(url, undefined, signal)) as T;
}

export async function downloadToFile(
  url: string,
  dest: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  let lastError: Error | null = null;
  for (const candidate of mirrorCandidates(url)) {
    try {
      const res = await fetch(candidate, { headers: { 'User-Agent': userAgent(), ...headers }, signal });
      if (!res.ok || !res.body) {
        lastError = new Error(`下载失败 (${res.status}): ${candidate}`);
        continue;
      }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
      return;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`下载失败: ${url}`);
}

/** Run a Java process and wait for it to finish, capturing recent output for errors. */
export async function runJava(
  javaPath: string,
  args: string[],
  cwd: string,
  onLog: ((line: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    let tail = '';
    const feed = (d: Buffer): void => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      onLog?.(s);
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort);
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('已取消'));
      else if (code === 0) resolve();
      else reject(new Error(`安装器退出码 ${code}: ${tail.slice(-1500)}`));
    });
  });
}

/** Launch a Java GUI installer detached (does NOT block the launcher). */
export function launchDetached(javaPath: string, args: string[], cwd: string): void {
  const child = spawn(javaPath, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

export type LoaderPlan =
  | { kind: 'json'; json: string; id: string; label: string }
  | { kind: 'installer'; url: string; label: string; fileName: string; headers?: Record<string, string> }
  | { kind: 'legacy-forge'; url: string; label: string; fileName: string };

// ---- version listing (used by the download dialog's loader-version dropdown) ----

/** Minor version of a "1.x.y" Minecraft version (e.g. "1.12.2" -> 12). */
function mcMinor(mcVersion: string): number {
  const m = mcVersion.match(/^1\.(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i] ?? 0) ? pa[i] : 0;
    const y = Number.isFinite(pb[i] ?? 0) ? pb[i] : 0;
    if (x !== y) return y - x;
  }
  return 0;
}

function neoForgePrefix(mcVersion: string): string {
  if (mcVersion === '1.20.1') return '47.1';
  const m = mcVersion.match(/^1\.(\d+)\.(\d+)$/);
  if (m) {
    const minor = parseInt(m[1], 10);
    const patch = parseInt(m[2], 10);
    if (minor >= 21) return `${minor}.${patch}`;
    if (minor === 20 && patch >= 2) return `20.${patch}`;
  }
  throw new Error(`无法确定 ${mcVersion} 对应的 NeoForge 版本前缀`);
}

// Fabric meta is already newest-first; the response shape is [{ loader: { version } }].
export async function listFabricVersions(mcVersion: string, signal?: AbortSignal): Promise<string[]> {
  const list = await getJson<Array<{ loader: { version: string } }>>(
    `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`,
    signal,
  );
  return list.map((x) => x.loader.version);
}

// Forge maven-metadata.xml lists every forge version (5094 entries); cache it.
let forgeAllCache: { at: number; list: string[] } | null = null;
async function listAllForgeVersions(signal?: AbortSignal): Promise<string[]> {
  if (forgeAllCache && Date.now() - forgeAllCache.at < 30 * 60 * 1000) return forgeAllCache.list;
  const xml = await getText(
    'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
    undefined,
    signal,
  );
  const list = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  forgeAllCache = { at: Date.now(), list };
  return list;
}

/** Stable Forge versions for a Minecraft version, newest first (e.g. "14.23.5.2864"). */
export async function listForgeVersions(mcVersion: string, signal?: AbortSignal): Promise<string[]> {
  const all = await listAllForgeVersions(signal);
  const prefix = `${mcVersion}-`;
  return all
    .filter((v) => v.startsWith(prefix))
    .filter((v) => !v.includes('-pre') && !v.includes('-rc'))
    .map((v) => v.slice(prefix.length))
    .sort(compareVersionDesc);
}

// NeoForge maven-metadata.xml; cache it.
let neoForgeAllCache: { at: number; list: string[] } | null = null;
async function listAllNeoForgeVersions(signal?: AbortSignal): Promise<string[]> {
  if (neoForgeAllCache && Date.now() - neoForgeAllCache.at < 30 * 60 * 1000) return neoForgeAllCache.list;
  const xml = await getText(
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
    undefined,
    signal,
  );
  const list = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  neoForgeAllCache = { at: Date.now(), list };
  return list;
}

/** Stable NeoForge versions for a Minecraft version, newest first. */
export async function listNeoForgeVersions(mcVersion: string, signal?: AbortSignal): Promise<string[]> {
  const prefix = neoForgePrefix(mcVersion);
  const all = await listAllNeoForgeVersions(signal);
  return all.filter((v) => v.startsWith(`${prefix}.`) && !v.includes('-')).sort(compareVersionDesc);
}

/** All stable versions of a loader for a Minecraft version, newest first. */
export async function listLoaderVersions(
  loader: ModLoader,
  mcVersion: string,
  signal?: AbortSignal,
): Promise<string[]> {
  switch (loader) {
    case 'fabric':
      return listFabricVersions(mcVersion, signal);
    case 'forge':
      return listForgeVersions(mcVersion, signal);
    case 'neoforge':
      return listNeoForgeVersions(mcVersion, signal);
  }
}

// ---- resolve a concrete loader install plan (optionally for a specific version) ----

export async function resolveLoaderPlan(
  loader: ModLoader,
  mcVersion: string,
  signal?: AbortSignal,
  loaderVersion?: string,
): Promise<LoaderPlan> {
  switch (loader) {
    case 'fabric':
      return resolveFabric(mcVersion, signal, loaderVersion);
    case 'forge':
      return resolveForge(mcVersion, signal, loaderVersion);
    case 'neoforge':
      return resolveNeoForge(mcVersion, signal, loaderVersion);
  }
}

async function resolveFabric(
  mcVersion: string,
  signal?: AbortSignal,
  explicit?: string,
): Promise<LoaderPlan> {
  const versions = await listFabricVersions(mcVersion, signal);
  if (versions.length === 0) throw new Error(`Fabric 不支持 ${mcVersion}`);
  const loaderVersion = explicit ?? versions[0];
  const json = await getText(
    `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`,
    undefined,
    signal,
  );
  const id = (JSON.parse(json) as { id?: string }).id ?? `fabric-loader-${loaderVersion}-${mcVersion}`;
  return { kind: 'json', json, id, label: `Fabric ${loaderVersion}` };
}

async function resolveForge(
  mcVersion: string,
  signal?: AbortSignal,
  explicit?: string,
): Promise<LoaderPlan> {
  const versions = await listForgeVersions(mcVersion, signal);
  if (versions.length === 0) throw new Error(`Forge 不支持 ${mcVersion}`);
  const version = explicit ?? versions[0];
  const fileName = `forge-${mcVersion}-${version}-installer.jar`;
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${version}/${fileName}`;
  // Legacy Forge (<=1.12.2) ships a self-extracting installer that we unpack directly;
  // modern Forge (1.13+) supports the headless `--installClient` CLI.
  if (mcMinor(mcVersion) <= 12) {
    return { kind: 'legacy-forge', url, label: `Forge ${version}`, fileName };
  }
  return { kind: 'installer', url, label: `Forge ${version}`, fileName };
}

async function resolveNeoForge(
  mcVersion: string,
  signal?: AbortSignal,
  explicit?: string,
): Promise<LoaderPlan> {
  const versions = await listNeoForgeVersions(mcVersion, signal);
  if (versions.length === 0) throw new Error(`NeoForge 不支持 ${mcVersion}`);
  const version = explicit ?? versions[0];
  const fileName = `neoforge-${version}-installer.jar`;
  const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/${fileName}`;
  return { kind: 'installer', url, label: `NeoForge ${version}`, fileName };
}

import { app } from 'electron';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { open as openZip, openEntryReadStream, walkEntriesGenerator } from '@xmcl/unzip';
import type { DownloadProgress, JavaInstallation } from '@shared/types';
import { JAVA_MAJOR_MAX, JAVA_MAJOR_MIN } from '@shared/types';
import { readJavaInfo } from './detector';
import { userAgent } from '../ua';

const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest';
const CANCEL_MSG = '已取消';

let activeAbort: AbortController | null = null;
let busy = false;

/** Directory where SLCL installs its own Java runtimes. */
export function getJavaRuntimeDir(): string {
  return join(app.getPath('userData'), 'java');
}

/** Cancel the currently running Java install. */
export function cancelJavaInstall(): void {
  activeAbort?.abort();
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Recursively find javaw.exe (or java.exe) under a directory. */
function findJavaw(root: string): string | null {
  const prefer = ['javaw.exe', 'java.exe'];
  for (const name of prefer) {
    const p = join(root, 'bin', name);
    if (existsSync(p)) return p;
  }
  // The zip has one top-level dir (e.g. jdk8u504-b01-jre). Look one level deeper.
  try {
    for (const entry of readdirSync(root)) {
      const sub = join(root, entry);
      if (!isDir(sub)) continue;
      for (const name of prefer) {
        const p = join(sub, 'bin', name);
        if (existsSync(p)) return p;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent() }, signal });
  if (!res.ok) throw new Error(`查询 Java 版本失败 (${res.status})`);
  return res.json();
}

interface JavaPackage {
  name: string;
  link: string;
  size: number;
  imageType: 'jre' | 'jdk';
}

/**
 * Resolve the newest Adoptium build for a major version.
 *
 * Prefers a JRE (much smaller), but some majors (notably Java 16) are only
 * published as a JDK — so we fall back instead of failing.
 */
async function resolvePackage(major: number, signal?: AbortSignal): Promise<JavaPackage> {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  for (const imageType of ['jre', 'jdk'] as const) {
    const url = `${ADOPTIUM_API}/${major}/hotspot?architecture=${arch}&image_type=${imageType}&os=windows&vendor=eclipse`;
    let data: Array<{ binary?: { package?: { name?: string; link?: string; size?: number } } }>;
    try {
      data = (await getJson(url, signal)) as typeof data;
    } catch {
      continue; // try the other image type
    }
    const pkg = data[0]?.binary?.package;
    if (pkg?.link && pkg.name) {
      return { name: pkg.name, link: pkg.link, size: pkg.size ?? 0, imageType };
    }
  }
  throw new Error(`Adoptium 上找不到 Java ${major} 的 Windows 安装包(可能版本过旧或输入有误)`);
}

/**
 * Install a Java runtime (Adoptium Temurin) for the given major version.
 * Any major Adoptium publishes is accepted (8, 11, 16–26, …), not just the
 * launcher's preset buttons.
 */
export async function installJava(
  major: number,
  onProgress: (p: DownloadProgress) => void,
): Promise<JavaInstallation> {
  if (!Number.isInteger(major) || major < JAVA_MAJOR_MIN || major > JAVA_MAJOR_MAX) {
    throw new Error(`Java 主版本号无效:${major}(有效范围 ${JAVA_MAJOR_MIN}–${JAVA_MAJOR_MAX})`);
  }
  if (busy) throw new Error('已有 Java 安装任务在进行中,请稍候');
  busy = true;
  activeAbort = new AbortController();
  const signal = activeAbort.signal;
  const targetDir = join(getJavaRuntimeDir(), `jre-${major}`);
  let zipPath = '';
  let zipDownloaded = false;

  try {
    // 1. Resolve the newest build for this major + platform (JRE, or JDK fallback).
    onProgress({ progress: 0, totalBytes: 0, downloadedBytes: 0, task: `查询 Java ${major} 最新版本` });
    const pkg = await resolvePackage(major, signal);

    const zipUrl = pkg.link;
    const fileName = pkg.name;
    const totalSize = pkg.size;

    // 2. Download the zip.
    mkdirSync(targetDir, { recursive: true });
    zipPath = join(targetDir, fileName);

    onProgress({
      progress: 0.05,
      totalBytes: totalSize,
      downloadedBytes: 0,
      task: `下载 Java ${major} (${pkg.imageType.toUpperCase()})`,
    });
    if (!existsSync(zipPath)) {
      const res = await fetch(zipUrl, { headers: { 'User-Agent': userAgent() }, signal });
      if (!res.ok || !res.body) throw new Error(`下载 Java ${major} 失败 (${res.status})`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath));
      zipDownloaded = true;
    }

    if (signal.aborted) throw new Error(CANCEL_MSG);

    // 3. Extract the zip.
    onProgress({ progress: 0.6, totalBytes: totalSize, downloadedBytes: totalSize, task: `解压 Java ${major}` });
    const zip = await openZip(zipPath, { lazyEntries: true, autoClose: false });
    try {
      for await (const entry of walkEntriesGenerator(zip)) {
        if (signal.aborted) throw new Error(CANCEL_MSG);
        if (entry.fileName.endsWith('/')) continue;
        // Strip the top-level directory inside the zip.
        const parts = entry.fileName.split('/');
        const rel = parts.length > 1 ? parts.slice(1).join('/') : entry.fileName;
        const dest = join(targetDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        if (existsSync(dest)) continue;
        const rs = await openEntryReadStream(zip, entry);
        await pipeline(rs, createWriteStream(dest));
      }
    } finally {
      zip.close();
    }

    if (signal.aborted) throw new Error(CANCEL_MSG);

    // 4. Locate javaw.exe and read its version.
    const javaw = findJavaw(targetDir);
    if (!javaw) throw new Error(`解压完成但未找到 Java ${major} 的可执行文件`);

    const info = await readJavaInfo(javaw);
    onProgress({ progress: 1, totalBytes: totalSize, downloadedBytes: totalSize, task: `Java ${major} 安装完成` });

    return {
      path: javaw,
      version: info?.version ?? `Java ${major}`,
      major: info?.major ?? major,
      is64Bit: info?.is64Bit ?? true,
      source: 'common_paths',
      isManaged: true,
    };
  } catch (e) {
    // On cancel, remove the partially-installed runtime.
    if (signal.aborted) {
      rmSync(targetDir, { recursive: true, force: true });
      throw new Error(CANCEL_MSG);
    }
    // On download failure, remove the partial zip.
    if (zipDownloaded && zipPath) {
      rmSync(zipPath, { force: true });
    }
    throw e;
  } finally {
    busy = false;
    activeAbort = null;
  }
}

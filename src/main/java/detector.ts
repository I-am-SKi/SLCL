import { execFile } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import { app } from 'electron';
import type { JavaInstallation } from '@shared/types';
import { getSettings } from '../settings/store';

const execFileAsync = promisify(execFile);

function parseMajor(version: string): number {
  const m = version.match(/^(\d+)/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (n === 1) {
    const m2 = version.match(/^1\.(\d+)/);
    if (m2) return parseInt(m2[1], 10);
  }
  return n;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read version + arch info from a JDK/JRE "release" file, or by running -version. */
export async function readJavaInfo(javaExe: string): Promise<{ version: string; major: number; is64Bit: boolean } | null> {
  const binDir = dirname(javaExe);
  const home = dirname(binDir);
  const releaseFile = join(home, 'release');

  if (existsSync(releaseFile)) {
    try {
      const raw = readFileSync(releaseFile, 'utf8');
      const v = raw.match(/JAVA_VERSION="([^"]+)"/);
      const arch = raw.match(/OS_ARCH="([^"]+)"/);
      if (v) {
        const version = v[1];
        return {
          version,
          major: parseMajor(version),
          is64Bit: arch ? arch[1].toLowerCase().includes('64') : true,
        };
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(javaExe, ['-version'], { timeout: 10000, windowsHide: true });
    const out = `${stdout}\n${stderr}`;
    const v = out.match(/version\s+"([^"]+)"/) ?? out.match(/version\s+([^\s]+)/);
    const arch64 = /64-Bit/i.test(out);
    if (v) {
      const version = v[1];
      return { version, major: parseMajor(version), is64Bit: arch64 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function resolveJavawFromHome(home: string): string | null {
  const exe = join(home, 'bin', 'javaw.exe');
  if (existsSync(exe)) return exe;
  const java = join(home, 'bin', 'java.exe');
  if (existsSync(java)) return java;
  return null;
}

function candidatesFromEnv(): string[] {
  const out: string[] = [];
  const javaHome = process.env.JAVA_HOME;
  if (javaHome && isDir(javaHome)) out.push(javaHome);
  const jreHome = process.env.JRE_HOME;
  if (jreHome && isDir(jreHome)) out.push(jreHome);
  return out;
}

function candidatesFromCommonPaths(): string[] {
  // The official Minecraft launcher bundles JREs under <appData>/.minecraft/runtime
  // (e.g. jre-legacy = Java 8, java-runtime-delta = Java 21). SLCL's one-click
  // installer writes runtimes under <userData>/java. Both must be scanned.
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files (x86)\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Semeru',
    'C:\\Program Files\\AdoptOpenJDK',
    // Official launcher runtimes (jre-legacy / java-runtime-delta / ...)
    join(appData, '.minecraft', 'runtime'),
    // SLCL's own auto-installed runtimes
    join(app.getPath('userData'), 'java'),
  ];
  const found: string[] = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(root, e);
      if (isDir(full)) {
        // Some vendors nest under <vendor>/jdk-XX/bin
        const exe = resolveJavawFromHome(full);
        if (exe) found.push(full);
        else {
          try {
            for (const sub of readdirSync(full)) {
              const subFull = join(full, sub);
              if (isDir(subFull) && resolveJavawFromHome(subFull)) found.push(subFull);
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return found;
}

async function candidatesFromRegistry(): Promise<string[]> {
  const found: string[] = [];
  const queries = [
    'reg query "HKLM\\SOFTWARE\\JavaSoft" /s /v JavaHome',
    'reg query "HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft" /s /v JavaHome',
    'reg query "HKCU\\SOFTWARE\\JavaSoft" /s /v JavaHome',
    'reg query "HKLM\\SOFTWARE\\Microsoft\\JDK" /s /v Path',
    'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\JDK" /s /v Path',
    'reg query "HKLM\\SOFTWARE\\Eclipse Adoptium" /s /v Path',
    'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Eclipse Adoptium" /s /v Path',
  ];
  for (const q of queries) {
    try {
      const args = q.match(/"([^"]+)"|(\S+)/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? [];
      const { stdout } = await execFileAsync('reg', args, { timeout: 10000, windowsHide: true });
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/REG_\w+\s+(.+)$/);
        if (m) {
          const p = m[1].trim();
          if (isDir(p) && resolveJavawFromHome(p)) found.push(p);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return found;
}

async function candidatesFromPath(): Promise<string[]> {
  const found: string[] = [];
  try {
    const { stdout } = await execFileAsync('where', ['java'], { timeout: 10000, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const p = line.trim();
      // Skip the Oracle javapath shim (a symlink, not a real home).
      if (!p || !existsSync(p) || p.toLowerCase().includes('javapath')) continue;
      const home = dirname(dirname(p));
      if (isDir(home)) found.push(home);
    }
  } catch {
    /* ignore */
  }
  return found;
}

export async function detectJava(): Promise<JavaInstallation[]> {
  const homes = new Set<string>();
  for (const h of [...candidatesFromEnv(), ...candidatesFromCommonPaths(), ...(await candidatesFromRegistry()), ...(await candidatesFromPath())]) {
    if (h) homes.add(h);
  }

  const results: JavaInstallation[] = [];
  for (const home of homes) {
    const exe = resolveJavawFromHome(home);
    if (!exe) continue;
    const info = await readJavaInfo(exe);
    results.push({
      path: exe,
      version: info?.version ?? 'unknown',
      major: info?.major ?? 0,
      is64Bit: info?.is64Bit ?? true,
      source: 'common_paths',
      isManaged: home.startsWith(join(app.getPath('userData'), 'java')),
    });
  }

  // Merge manually-imported Java executables.
  for (const exePath of getSettings().manualJavaPaths ?? []) {
    if (!existsSync(exePath)) continue;
    const info = await readJavaInfo(exePath);
    results.push({
      path: exePath,
      version: info?.version ?? 'unknown',
      major: info?.major ?? 0,
      is64Bit: info?.is64Bit ?? true,
      source: 'manual',
      isManaged: false,
    });
  }

  // Dedupe by path, sort by major desc (unknown majors last), 64-bit preferred.
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  });
  deduped.sort((a, b) => {
    if (a.major === 0 && b.major !== 0) return 1;
    if (b.major === 0 && a.major !== 0) return -1;
    return b.major - a.major || Number(b.is64Bit) - Number(a.is64Bit);
  });
  return deduped;
}

/**
 * Pick the best Java for a required major version.
 * Prefers an exact major match, then a newer major, then anything (fallback).
 */
export function pickBestJava(list: JavaInstallation[], requiredMajor: number): JavaInstallation | null {
  const known = list.filter((j) => j.major > 0);
  const exact = known.filter((j) => j.major === requiredMajor);
  if (exact.length > 0) return exact[0];
  const newer = known.filter((j) => j.major > requiredMajor).sort((a, b) => a.major - b.major);
  if (newer.length > 0) return newer[0];
  return list[0] ?? null;
}

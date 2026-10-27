import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

/**
 * authlib-injector is the JVM agent that lets the vanilla client talk to a
 * third-party Yggdrasil server (LittleSkin) instead of Mojang's session servers.
 * Without it the game launches but skins never load.
 *
 * We resolve the newest build from the official artifact service (with the
 * BMCLAPI mirror as a fallback, since the official host can be slow in China).
 */
const ARTIFACT_LATEST = [
  'https://authlib-injector.yushi.moe/artifact/latest.json',
  'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json',
];

/** Pinned fallback used when both artifact services are unreachable. */
const FALLBACK_URL = 'https://authlib-injector.yushi.moe/artifact/56/authlib-injector-1.2.8.jar';
const FALLBACK_FILENAME = 'authlib-injector-1.2.8.jar';

const MIN_JAR_BYTES = 10_000;

interface ArtifactLatest {
  version?: string;
  download_url?: string;
}

function injectorDir(): string {
  const dir = join(app.getPath('userData'), 'authlib-injector');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isUsableJar(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > MIN_JAR_BYTES;
  } catch {
    return false;
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length <= MIN_JAR_BYTES) throw new Error('下载到的文件不完整');
  // Zip signature check (jar files are zip archives).
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error('下载到的文件不是有效的 jar');
  writeFileSync(dest, buf);
}

interface ResolvedArtifact {
  url: string;
  filename: string;
}

/** Resolve the newest authlib-injector artifact url. */
async function resolveArtifact(): Promise<ResolvedArtifact> {
  for (const endpoint of ARTIFACT_LATEST) {
    try {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const data = (await res.json()) as ArtifactLatest;
      if (data.download_url) {
        const filename = data.download_url.split('/').pop() ?? FALLBACK_FILENAME;
        return { url: data.download_url, filename };
      }
    } catch {
      /* try the next artifact service */
    }
  }
  return { url: FALLBACK_URL, filename: FALLBACK_FILENAME };
}

/**
 * Ensure the authlib-injector jar exists locally and return its absolute path.
 * Cached across launches; re-downloaded only when missing or truncated.
 */
export async function ensureAuthlibInjector(): Promise<string> {
  const dir = injectorDir();
  const artifact = await resolveArtifact();
  const target = join(dir, artifact.filename);
  if (isUsableJar(target)) return target;

  try {
    await downloadTo(artifact.url, target);
    return target;
  } catch (primaryError) {
    // Retry through the pinned build before giving up.
    const fallback = join(dir, FALLBACK_FILENAME);
    if (isUsableJar(fallback)) return fallback;
    try {
      await downloadTo(FALLBACK_URL, fallback);
      return fallback;
    } catch (fallbackError) {
      const reason = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const reason2 = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`下载 authlib-injector 失败(${reason};备用源:${reason2}),请检查网络后重试`);
    }
  }
}

/**
 * Build the JVM arguments needed to route the game's auth through an API root.
 * `-Dauthlibinjector.noLogFile` keeps the agent from writing `authlib-injector.log`
 * into the game directory — it still logs to stdout, which we already capture.
 */
export function authlibInjectorArgs(jarPath: string, apiRoot: string): string[] {
  return ['-Dauthlibinjector.noLogFile', `-javaagent:${jarPath}=${apiRoot}`];
}

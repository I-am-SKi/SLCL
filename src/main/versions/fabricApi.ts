/**
 * Pre-installs Fabric API into a freshly created Fabric version.
 *
 * Rationale: almost every Fabric mod depends on Fabric API, so users would
 * otherwise install the loader, launch, crash with "requires fabric-api", and then
 * have to find the matching build themselves. Doing it at install time removes that
 * whole failure mode.
 *
 * Everything here is best-effort: a failed or unavailable Fabric API must never
 * abort the version install. Some Minecraft versions (very old ones, or snapshots
 * Fabric API has no build for) legitimately have nothing to install.
 */
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { userAgent } from '../ua';
import { MODRINTH_API, MODRINTH_MIRROR_API, downloadToFile } from '../resources/http';

/** Modrinth project id of Fabric API. Stable, unlike the slug. */
const FABRIC_API_PROJECT = 'P7dR8mSH';

interface ModrinthVersionFile {
  url: string;
  filename: string;
  size: number;
  primary?: boolean;
}

interface ModrinthVersion {
  id: string;
  version_number: string;
  date_published: string;
  files?: ModrinthVersionFile[];
}

async function fetchVersions(mcVersion: string, signal: AbortSignal): Promise<ModrinthVersion[]> {
  const query =
    `?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}` +
    `&loaders=${encodeURIComponent(JSON.stringify(['fabric']))}`;

  // Same mirror-first strategy as the resources page, so this keeps working for
  // users who cannot reach Modrinth directly.
  for (const base of [MODRINTH_MIRROR_API, MODRINTH_API]) {
    try {
      const res = await fetch(`${base}/project/${FABRIC_API_PROJECT}/version${query}`, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
        // The mirror negotiates responses; keep formats honest (see skinImage.ts).
        cache: 'no-store',
        signal,
      });
      if (!res.ok) continue;
      const list = (await res.json()) as ModrinthVersion[];
      if (Array.isArray(list)) return list;
    } catch {
      /* try the next base */
    }
  }
  return [];
}

/**
 * True when the mods folder already contains a Fabric API jar. Guards against
 * duplicates when a user reinstalls a version over an existing one.
 */
function hasFabricApi(modsDir: string): boolean {
  if (!existsSync(modsDir)) return false;
  try {
    return readdirSync(modsDir).some((name) => {
      const lower = name.toLowerCase();
      return lower.startsWith('fabric-api') && lower.endsWith('.jar');
    });
  } catch {
    return false;
  }
}

export interface FabricApiResult {
  /** File name that was written, or null when nothing was installed. */
  installed: string | null;
  /** Why nothing was installed (for the log), or null on success. */
  reason: string | null;
}

/**
 * Download the newest Fabric API build for `mcVersion` into `modsDir`.
 * Never throws: callers treat this as a convenience step.
 */
export async function installFabricApi(
  mcVersion: string,
  modsDir: string,
  signal?: AbortSignal,
): Promise<FabricApiResult> {
  try {
    if (hasFabricApi(modsDir)) {
      return { installed: null, reason: '已存在 Fabric API，跳过' };
    }

    const timeout = AbortSignal.timeout(30000);
    const list = await fetchVersions(mcVersion, signal ? AbortSignal.any([signal, timeout]) : timeout);
    if (list.length === 0) {
      return { installed: null, reason: `Fabric API 没有支持 ${mcVersion} 的版本` };
    }

    // Newest first by publish date; Modrinth does not guarantee ordering.
    const newest = [...list].sort(
      (a, b) => Date.parse(b.date_published) - Date.parse(a.date_published),
    )[0];
    const file = newest.files?.find((f) => f.primary) ?? newest.files?.[0];
    if (!file) return { installed: null, reason: 'Fabric API 版本没有可下载的文件' };

    mkdirSync(modsDir, { recursive: true });
    await downloadToFile(file.url, join(modsDir, file.filename));
    return { installed: file.filename, reason: null };
  } catch (e) {
    return { installed: null, reason: e instanceof Error ? e.message : String(e) };
  }
}

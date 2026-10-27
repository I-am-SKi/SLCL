/**
 * BMCLAPI (https://bmclapidoc.bangbang93.com/) is a China-friendly mirror of the
 * Mojang / Forge / Fabric / NeoForge download services, run by bangbang93.
 *
 * This module rewrites official URLs onto BMCLAPI and provides a download helper
 * that always keeps the original URL as a fallback, so a mirror outage can never
 * break an install.
 *
 * Mirror rules (from the official docs + launcher source implementations):
 *   launchermeta.mojang.com | launcher.mojang.com | piston-*.mojang.com -> same path
 *   resources.download.minecraft.net/<path>    -> /assets/<path>
 *   libraries.minecraft.net/<path>             -> /maven/<path>
 *   files.minecraftforge.net[/maven]/<path>    -> /maven/<path>
 *   maven.minecraftforge.net/<path>            -> /maven/<path>
 *   maven.fabricmc.net/<path>                  -> /maven/<path>
 *   meta.fabricmc.net/<path>                   -> /fabric-meta/<path>
 *   maven.neoforged.net/releases/<path>        -> /maven/<path>
 */
const BMCL_HOST = 'bmclapi2.bangbang93.com';

function rewrite(u: URL): string | null {
  const host = u.hostname;
  const path = u.pathname;
  switch (host) {
    case 'launchermeta.mojang.com':
    case 'launcher.mojang.com':
    case 'piston-meta.mojang.com':
    case 'piston-data.mojang.com':
      return `https://${BMCL_HOST}${path}`;
    case 'resources.download.minecraft.net':
      return `https://${BMCL_HOST}/assets${path}`;
    case 'libraries.minecraft.net':
      return `https://${BMCL_HOST}/maven${path}`;
    case 'files.minecraftforge.net':
    case 'maven.minecraftforge.net':
      return `https://${BMCL_HOST}/maven${path.replace(/^\/maven/, '')}`;
    case 'maven.fabricmc.net':
      return `https://${BMCL_HOST}/maven${path}`;
    case 'meta.fabricmc.net':
      return `https://${BMCL_HOST}/fabric-meta${path}`;
    case 'maven.neoforged.net':
      return `https://${BMCL_HOST}/maven${path.replace(/^\/releases/, '')}`;
    default:
      return null;
  }
}

/** Map an official URL onto its BMCLAPI mirror (identity when not mirrorable). */
export function bmclify(url: string): string {
  try {
    return rewrite(new URL(url)) ?? url;
  } catch {
    return url;
  }
}

/**
 * Mirror + original URL (deduplicated), mirror first. Used to try the fast CDN
 * first and fall back to the official host when the mirror is down or corrupt.
 */
export function mirrorCandidates(url: string): string[] {
  const mirror = bmclify(url);
  return mirror === url ? [url] : [mirror, url];
}

/** Fetch a URL, transparently failing over from the mirror to the official host. */
export async function fetchMirrored(url: string, init?: RequestInit): Promise<Response> {
  const candidates = mirrorCandidates(url);
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    // Guard against a stalled connection: these are small metadata files, so a
    // generous total timeout is safe and prevents "hanging forever" on the
    // manifest / version JSON / asset index.
    const timeout = AbortSignal.timeout(60000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const res = await fetch(candidate, { ...init, signal });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`请求失败: ${url}`);
}

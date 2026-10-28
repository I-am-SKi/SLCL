/**
 * Shared HTTP layer for resource lookups (CurseForge / Modrinth).
 *
 * Two responsibilities:
 *
 * 1. **User-Agent.** Every request built here carries the registered
 *    `SLCL/{version}` UA (see `src/main/ua.ts`). MCIM asks integrators to register
 *    the name and UA in advance and warns that it may start enforcing a UA
 *    allowlist, so every attempt — including fallbacks — sends it explicitly,
 *    never an empty or library-default UA. Registered at
 *    mcmod-info-mirror/mcim-rust-api#12.
 *
 * 2. **MCIM mirror.** MCIM (https://www.mcimirror.top) mirrors Modrinth and
 *    CurseForge metadata + files for users in mainland China. Paths, query
 *    parameters and response shapes match the upstream APIs, so switching
 *    sources is a pure host rewrite:
 *
 *      api.curseforge.com   -> mod.mcimirror.top/curseforge
 *      edge.forgecdn.net    -> mod.mcimirror.top
 *      media.forgecdn.net   -> mod.mcimirror.top
 *      api.modrinth.com     -> mod.mcimirror.top/modrinth
 *      cdn.modrinth.com     -> mod.mcimirror.top
 *
 *    `mediafilez.forgecdn.net` is intentionally NOT rewritten: the MCIM guide
 *    explicitly says to leave it alone.
 *
 * Both APIs are free of API keys through the mirror, so a launcher that cannot
 * ask every user for a CurseForge key still gets full search / file access. The
 * official host always stays in the candidate list as a fallback, so a mirror
 * outage degrades to "slower" rather than "broken".
 */
import { mkdirSync, rmSync } from 'fs';
import { dirname } from 'path';
import { userAgent } from '../ua';
import { downloadWithStall } from '../download/stream';

const MCIM_HOST = 'https://mod.mcimirror.top';

/** Metadata endpoints, kept as constants so call sites stay readable. */
export const CURSEFORGE_API = 'https://api.curseforge.com/v1';
export const CURSEFORGE_MIRROR_API = `${MCIM_HOST}/curseforge/v1`;
export const MODRINTH_API = 'https://api.modrinth.com/v2';
export const MODRINTH_MIRROR_API = `${MCIM_HOST}/modrinth/v2`;

/**
 * Map an official URL onto its MCIM mirror (identity when not mirrorable).
 */
export function mcimify(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const suffix = `${url.pathname}${url.search}${url.hash}`;
  switch (url.hostname) {
    case 'api.curseforge.com':
      return `${MCIM_HOST}/curseforge${suffix}`;
    case 'api.modrinth.com':
      return `${MCIM_HOST}/modrinth${suffix}`;
    case 'cdn.modrinth.com':
    case 'edge.forgecdn.net':
    case 'media.forgecdn.net':
      return `${MCIM_HOST}${suffix}`;
    // `mediafilez.forgecdn.net` deliberately falls through unchanged.
    default:
      return raw;
  }
}

/** One attempt in a fallback chain. */
export interface HttpCandidate {
  url: string;
  /** Extra headers for this attempt only (e.g. `x-api-key` on the official host). */
  headers?: Record<string, string>;
  /** Per-attempt timeout. A short first hop keeps failover snappy. */
  timeoutMs?: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Try each candidate in order and return the first successful response.
 *
 * Used for metadata only: the response is consumed as JSON in the caller, so the
 * body is never buffered twice. Every attempt carries the registered UA.
 */
export async function fetchFirst(
  candidates: HttpCandidate[],
  init: { accept?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    const timeout = AbortSignal.timeout(candidate.timeoutMs ?? 30000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const res = await fetch(candidate.url, {
        headers: {
          'User-Agent': userAgent(),
          ...(init.accept ? { Accept: init.accept } : {}),
          ...candidate.headers,
        },
        signal,
      });
      if (res.ok) return res;
      failures.push(`${hostOf(candidate.url)} HTTP ${res.status}`);
    } catch (e) {
      failures.push(`${hostOf(candidate.url)} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`请求失败（${failures.join('；')}）`);
}

/** Fetch JSON through a fallback chain. */
export async function fetchJson<T>(
  candidates: HttpCandidate[],
  init: { accept?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetchFirst(candidates, init);
  return (await res.json()) as T;
}

/** Mirror-first candidate list for a file URL (identity when not mirrorable). */
export function downloadCandidates(url: string): string[] {
  const mirror = mcimify(url);
  return mirror === url ? [url] : [mirror, url];
}

/**
 * Download a URL into `dest`, trying the mirror first and the official CDN
 * second. A partial file left by a failed attempt is removed before retrying so
 * the fallback never appends to a truncated download.
 *
 * Uses the stall-protected streamer from the version downloader: a connection
 * that accepts then goes silent (common on the CDN) would otherwise hang the
 * modpack install forever.
 */
export interface DownloadToFileOptions {
  /** Upstream cancel signal. */
  signal?: AbortSignal;
  /** Called after every received chunk with the bytes just written. */
  onBytes?: (delta: number) => void;
  /** Abort when no bytes arrive for this long. */
  stallMs?: number;
}

export async function downloadToFile(
  url: string,
  dest: string,
  opts: DownloadToFileOptions = {},
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const failures: string[] = [];

  for (const candidate of downloadCandidates(url)) {
    if (opts.signal?.aborted) throw new Error('已取消');
    try {
      await downloadWithStall(candidate, dest, {
        signal: opts.signal,
        stallMs: opts.stallMs,
        headers: { 'User-Agent': userAgent() },
        onBytes: opts.onBytes,
      });
      return;
    } catch (e) {
      if (opts.signal?.aborted) throw new Error('已取消');
      failures.push(`${hostOf(candidate)} ${e instanceof Error ? e.message : String(e)}`);
      rmSync(dest, { force: true });
    }
  }

  throw new Error(`下载失败（${failures.join('；')}）`);
}

/**
 * CurseForge metadata candidates.
 *
 * With a user-supplied key the official API comes first — it is authoritative and
 * credits the author — and the mirror only serves as an outage fallback. Without
 * a key the official host would answer 403, so it is left out entirely and the
 * mirror is the only source.
 */
export function curseforgeCandidates(apiKey: string): HttpCandidate[] {
  const candidates: HttpCandidate[] = [];
  if (apiKey) {
    candidates.push({ url: CURSEFORGE_API, headers: { 'x-api-key': apiKey }, timeoutMs: 30000 });
    candidates.push({ url: CURSEFORGE_MIRROR_API, timeoutMs: 20000 });
  } else {
    candidates.push({ url: CURSEFORGE_MIRROR_API, timeoutMs: 20000 });
  }
  return candidates;
}

/** Modrinth metadata candidates: mirror first (China latency), official fallback. */
export function modrinthCandidates(): HttpCandidate[] {
  return [
    { url: MODRINTH_MIRROR_API, timeoutMs: 10000 },
    { url: MODRINTH_API, timeoutMs: 30000 },
  ];
}

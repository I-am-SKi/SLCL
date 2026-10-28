/**
 * Resolves a project to its MC百科 (mcmod.cn) entry.
 *
 * mcmod.cn has no public JSON search API for third parties, so this scrapes the
 * search page. Two rules keep it safe:
 *
 *   - Only an exact-ish title match is accepted. Sending the user to the wrong mod
 *     page is worse than sending them to search results.
 *   - Results are cached (including negatives) because the search page is heavy
 *     and the resource cards render in bulk.
 */
import { userAgent } from '../ua';

const SEARCH_BASE = 'https://search.mcmod.cn/s';
const CLASS_URL = /https:\/\/www\.mcmod\.cn\/class\/(\d+)\.html/;

interface CacheEntry {
  /** Direct entry URL, or null when no confident match exists. */
  url: string | null;
  /** Fallback search URL, always usable. */
  search: string;
}

const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 500;

/** Normalise a title for comparison: strip decorations, case, spacing, punctuation. */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    // [JEI] / 【xxx】 style abbreviations
    .replace(/[[【][^\]】]*[\]】]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Same as `normalize` but with every separator removed (JustEnoughItems == Just Enough Items). */
function compact(raw: string): string {
  return normalize(raw).replace(/\s+/g, '');
}

/**
 * An anchor text on mcmod looks like "[JEI] JEI物品管理器 (JustEnoughItems)".
 * Compare every plausible form of both sides so the match survives formatting
 * differences (brackets, the English name in parentheses, missing spaces).
 */
function titleMatches(anchorText: string, projectTitle: string): boolean {
  const targetSpaced = normalize(projectTitle);
  const targetCompact = compact(projectTitle);
  if (!targetCompact) return false;

  const pieces = new Set<string>([anchorText]);
  // Text inside parentheses is usually the English name.
  for (const m of anchorText.matchAll(/[(（]([^)）]+)[)）]/g)) pieces.add(m[1]);
  // Head without the bracketed abbreviation.
  pieces.add(anchorText.replace(/[[【][^\]】]*[\]】]/g, ''));

  for (const piece of pieces) {
    const spaced = normalize(piece);
    const packed = compact(piece);
    if (!packed) continue;
    if (spaced === targetSpaced || packed === targetCompact) return true;
    // Containment covers "JEI物品管理器 (JustEnoughItems)" vs "Just Enough Items (JEI)":
    // at least one side's English name is fully contained in the other.
    if (packed.includes(targetCompact) && packed.length <= targetCompact.length + 12) return true;
    if (targetCompact.includes(packed) && targetCompact.length <= packed.length + 12) return true;
  }
  return false;
}

/**
 * mcmod.cn rate-limits its search page: bursts return a page with no results, and
 * a few seconds later the same query succeeds. Requests are therefore serialised
 * with a minimum gap, and one retry covers the case where the limit was already hit.
 */
const MIN_INTERVAL_MS = 1500;
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttle<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return task();
  });
  // Keep the chain alive even when a task rejects.
  queue = run.catch(() => undefined);
  return run;
}

async function fetchSearchHtml(search: string): Promise<string | null> {
  try {
    const res = await fetch(search, {
      headers: {
        'User-Agent': userAgent(),
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function resolveUncached(projectTitle: string): Promise<CacheEntry> {
  const title = projectTitle.trim();
  const search = `${SEARCH_BASE}?key=${encodeURIComponent(title)}`;
  const entry: CacheEntry = { url: null, search };
  if (!title) return entry;

  const parse = (html: string): string | null => {
    // Only consider anchors inside a result item, so navigation links are excluded.
    const blocks = html.split('class="result-item"').slice(1, 6);
    for (const blockText of blocks) {
      const link = CLASS_URL.exec(blockText);
      if (!link) continue;
      const anchor = /<a[^>]*href="https:\/\/www\.mcmod\.cn\/class\/\d+\.html"[^>]*>([\s\S]*?)<\/a>/.exec(blockText);
      const text = anchor ? anchor[1].replace(/<[^>]+>/g, '') : '';
      if (titleMatches(text, title)) return `https://www.mcmod.cn/class/${link[1]}.html`;
    }
    return null;
  };

  // mcmod's search treats parentheses/brackets literally and then finds nothing, so
  // fall back to a simplified keyword ("Just Enough Items (JEI)" -> "Just Enough Items").
  const queries = [title];
  const simplified = title
    .replace(/[(（][^)）]*[)）]/g, ' ')
    .replace(/[[【][^\]】]*[\]】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (simplified && simplified !== title) queries.push(simplified);

  // Serialised + retry: the search page answers an empty result set when hit in
  // bursts, and the same query succeeds a few seconds later.
  for (const keyword of queries) {
    const url = `${SEARCH_BASE}?key=${encodeURIComponent(keyword)}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const html = await throttle(() => fetchSearchHtml(url));
      const hit = html ? parse(html) : null;
      if (hit) {
        entry.url = hit;
        return entry;
      }
    }
  }
  return entry;
}

/**
 * Look up the MC百科 link for a project name. Never throws; `url` is null when no
 * confident entry was found, in which case `search` still works.
 */
export async function resolveMcmodLink(projectTitle: string): Promise<CacheEntry> {
  const key = normalize(projectTitle);
  const hit = cache.get(key);
  if (hit) return hit;

  const entry = await resolveUncached(projectTitle);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
  return entry;
}

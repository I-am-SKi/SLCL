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
 *
 * It also translates between the two naming worlds: Modrinth / CurseForge index
 * English titles, while players know Chinese ones. The search result page holds
 * both ("机械动力 (Create)"), so one request settles either direction.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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
 * mcmod.cn rate-limits its search page: bursts return a page with *no results*
 * (HTTP 200, indistinguishable from "nothing found"), and a few seconds later the
 * same query succeeds. Measured on a 20-request burst:
 *
 *   gap 400ms -> 8/20 empty;  gap 800ms -> 1/20;  gap 1000ms -> 0/20.
 *
 * Requests are therefore serialised with a 1s floor, and an empty answer adds an
 * extra cooldown.
 */
const MIN_INTERVAL_MS = 1000;
/** Extra cooldown after mcmod answers with zero results (it is rate-limiting us). */
const EMPTY_BACKOFF_MS = 2000;

/**
 * Priority of a queued request. A user click must never sit behind a page of
 * background name lookups.
 */
export const McmodPriority = {
  /** Prefetching Chinese names for cards already on screen. */
  background: 0,
  /** The user clicked something and is waiting for the result. */
  user: 2,
} as const;

interface QueuedTask {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  priority: number;
}

let pending: QueuedTask[] = [];
let draining = false;
let nextAllowedAt = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `task` through the single mcmod lane.
 *
 * All mcmod traffic shares this queue, so the site never sees our requests in
 * parallel. Higher `priority` jumps ahead of queued background work.
 */
export function scheduleMcmod<T>(task: () => Promise<T>, priority: number = McmodPriority.background): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.push({ run: task, resolve: resolve as (v: unknown) => void, reject, priority });
    // Small queue (a page of cards), so a linear insert is cheaper than a sort.
    let at = pending.length - 1;
    while (at > 0 && pending[at - 1].priority < pending[at].priority) {
      [pending[at - 1], pending[at]] = [pending[at], pending[at - 1]];
      at -= 1;
    }
    void drainQueue();
  });
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.length > 0) {
      const task = pending.shift() as QueuedTask;
      const wait = nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextAllowedAt = Date.now() + MIN_INTERVAL_MS;
      try {
        task.resolve(await task.run());
      } catch (e) {
        task.reject(e);
      }
    }
  } finally {
    draining = false;
  }
}

/** Tell the queue that mcmod just refused to answer, so it backs off. */
function noteRateLimited(): void {
  nextAllowedAt = Math.max(nextAllowedAt, Date.now() + EMPTY_BACKOFF_MS);
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
      const html = await scheduleMcmod(() => fetchSearchHtml(url), McmodPriority.user);
      const hit = html ? parse(html) : null;
      if (hit) {
        entry.url = hit;
        return entry;
      }
      noteRateLimited();
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

// ---------------------------------------------------------------------------
// Chinese name resolution (Chinese search keyword -> English project names)
// ---------------------------------------------------------------------------
//
// Modrinth and CurseForge index project *titles*, which are overwhelmingly
// English. A Chinese keyword therefore only matches the few projects that happen
// to carry Chinese characters in their title, and the mods people actually mean
// ("机械动力" -> Create) are invisible.
//
// mcmod.cn's search page indexes Chinese names and displays both halves of every
// title ("机械动力 (Create)"), so one lookup yields the English name to search.
// That is the same trick the mainstream Chinese launchers use.

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Whether a keyword contains CJK characters (and thus needs translating). */
export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/** One mcmod hit, split into its two names. */
export interface ChineseName {
  /** Chinese name as published on mcmod, without the bracketed abbreviation. */
  zh: string;
  /** English name to send to Modrinth / CurseForge. */
  en: string;
  /** mcmod entry URL (kept for diagnostics). */
  url: string;
}

/** Decode the few HTML entities mcmod uses inside titles. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Split an mcmod anchor text into Chinese and English names.
 *
 * Titles come in three shapes: "[JEI] JEI物品管理器 (Just Enough Items)",
 * "机械动力 (Create)" and English-only "EMI". The trailing parenthetical is the
 * English name; the bracketed abbreviation is not part of either name.
 */
function parseAnchorTitle(raw: string): { zh: string; en: string } {
  let text = decodeEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  let en = '';
  const paren = /[(（]([^()（）]+)[)）]\s*$/.exec(text);
  if (paren && /[A-Za-z]/.test(paren[1])) {
    en = paren[1].trim();
    text = text.slice(0, paren.index).trim();
  }
  const zh = text.replace(/^[[【][^\]】]*[\]】]\s*/, '').trim();
  return { zh, en: en || zh };
}

/**
 * How well a Chinese name matches the keyword. 0 rejects the entry.
 *
 * mcmod searches descriptions as well as titles, so a generic word ("光影")
 * returns unrelated mods. Treating those as translation candidates would query
 * the APIs with the wrong English names, which is worse than not translating.
 */
function nameScore(query: string, zh: string): number {
  if (!zh || !CJK.test(zh)) return 0;
  const q = normalize(query);
  const z = normalize(zh);
  if (!q || !z) return 0;
  if (z === q) return 100;
  if (z.startsWith(q)) return 80;
  if (z.includes(q)) return 60;
  // A mixed keyword ("Create 机械动力") contains the name rather than the reverse.
  if (q.includes(z)) return 50;
  return 0;
}

/**
 * How confidently `title` is the project whose English name is `english`. 0 = no.
 *
 * Stricter than `titleMatches` on purpose: this decides which Chinese gloss a
 * *search result* is labelled with, and a wrong label is worse than none. The
 * relaxed containment rule used by `titleMatches` would label "Sodium Extra" as
 * "钠" (Sodium), which is exactly the kind of mix-up to avoid. Only an exact
 * match, or one that differs by a trailing parenthetical, counts.
 */
export function chineseNameScore(english: string, title: string): number {
  const e = compact(english);
  const t = compact(title);
  if (!e || !t) return 0;
  if (e === t) return 100;

  // "Just Enough Items (JEI)" vs "Just Enough Items": the parenthetical is an
  // abbreviation, not a different project.
  const stripParen = (s: string): string => compact(s.replace(/[(（][^()（）]*[)）]\s*$/, ''));
  if (stripParen(title) === e) return 90;
  if (stripParen(english) === t) return 90;

  // Tiny spelling differences beyond a parenthetical: a leading article
  // ("Twilight Forest" vs mcmod's "The TwilightForest") or a missing suffix of a
  // few characters. Bounded to 4 so "Sodium" never claims "Sodium Extra".
  if (e.includes(t) && e.length - t.length <= 4) return 70;
  if (t.includes(e) && t.length - e.length <= 4) return 70;
  return 0;
}

const nameCache = new Map<string, { at: number; names: ChineseName[] }>();
const NAME_TTL_MS = 30 * 60 * 1000;
const MAX_NAME_CACHE = 200;
/** Upper bound on stored matches; callers only search the first few. */
const MAX_NAMES = 6;
/**
 * How long a search may wait for mcmod before falling back to the raw keyword.
 *
 * The lookup happens inline with the user's search, so it has to be quick: the
 * page itself allows 20s, but a search that takes 20s to show *something* reads as
 * broken. Timing out loses only the translation, never the results.
 */
const NAME_LOOKUP_BUDGET_MS = 5000;

/**
 * Translate a Chinese keyword into the English names it refers to, best first.
 *
 * Never throws: an unreachable, slow or rate-limited mcmod yields an empty list
 * and the caller falls back to searching the original keyword.
 */
export async function resolveChineseNames(query: string): Promise<ChineseName[]> {
  const key = normalize(query);
  if (!key) return [];

  const cached = nameCache.get(key);
  if (cached && Date.now() - cached.at < NAME_TTL_MS) return cached.names;

  const names = await lookupChineseNames(query);
  // `null` means "could not ask", not "no such mod" — caching that would keep the
  // fallback for half an hour after a single hiccup.
  if (names === null) return [];

  if (nameCache.size >= MAX_NAME_CACHE) {
    const oldest = nameCache.keys().next().value;
    if (oldest !== undefined) nameCache.delete(oldest);
  }
  nameCache.set(key, { at: Date.now(), names });
  return names;
}

async function lookupChineseNames(query: string): Promise<ChineseName[] | null> {
  const url = `${SEARCH_BASE}?key=${encodeURIComponent(query.trim())}`;
  // Shares the module's serialised throttle, so a burst of searches cannot trip
  // mcmod's rate limit.
  const request = scheduleMcmod(() => fetchSearchHtml(url), McmodPriority.user).catch(() => null);

  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), NAME_LOOKUP_BUDGET_MS);
  });
  const html = await Promise.race([request, budget]);
  if (timer) clearTimeout(timer);
  // The abandoned request still settles (and keeps the throttle chain intact);
  // its result is simply dropped.
  if (html === null) return null;

  const scored: Array<{ score: number; name: ChineseName }> = [];
  const seen = new Set<string>();

  // One page is plenty: mcmod orders by relevance, so the exact hit is at the top.
  for (const block of html.split('class="result-item"').slice(1, 10)) {
    const link = CLASS_URL.exec(block);
    const anchor = /<a[^>]*href="https:\/\/www\.mcmod\.cn\/class\/\d+\.html"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link || !anchor) continue;

    const { zh, en } = parseAnchorTitle(anchor[1]);
    const score = nameScore(query, zh);
    if (score === 0 || !en) continue;

    const dedupe = compact(en);
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);

    scored.push({ score, name: { zh, en, url: `https://www.mcmod.cn/class/${link[1]}.html` } });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_NAMES).map((s) => s.name);
}

// ---------------------------------------------------------------------------
// English title -> Chinese name (for cards that were not found by a Chinese search)
// ---------------------------------------------------------------------------
//
// Every card should read in Chinese where a Chinese name exists, whether it came
// from a Chinese search, an English search or the popularity list. That means the
// reverse direction: look the English title up on mcmod and read the Chinese half
// of the anchor text.
//
// The lookups are one request each and mcmod allows roughly one per second, so
// they run in the background (low priority) and the results are persisted — the
// first visit to a page fills the cache, later visits are instant.

/** Cached outcome of a reverse lookup. `zh: null` means "mcmod has no Chinese name". */
interface ZhEntry {
  zh: string | null;
  /** Epoch ms of the lookup, for TTL. */
  at: number;
  /** The lookup never got an answer (rate limited) — retry soon, do not trust it. */
  unconfirmed?: boolean;
}

/** Positive hits are stable; a miss may appear after mcmod adds a translation. */
const ZH_TTL_HIT_MS = 30 * 24 * 60 * 60 * 1000;
const ZH_TTL_MISS_MS = 3 * 24 * 60 * 60 * 1000;
/** A miss we could not verify (mcmod never answered) is retried within hours. */
const ZH_TTL_UNCONFIRMED_MS = 2 * 60 * 60 * 1000;

const zhCache = new Map<string, ZhEntry>();
let zhCacheLoaded = false;
let zhSaveTimer: NodeJS.Timeout | undefined;
/** Titles with a lookup in flight, so a re-render cannot queue duplicates. */
const zhInFlight = new Map<string, Promise<string | null>>();

function zhCacheFile(): string {
  return join(app.getPath('userData'), 'cache', 'resource-zh-names.json');
}

function loadZhCache(): void {
  if (zhCacheLoaded) return;
  zhCacheLoaded = true;
  try {
    const file = zhCacheFile();
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, ZhEntry>;
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && typeof entry.at === 'number') zhCache.set(key, entry);
    }
  } catch {
    // A corrupt cache is not worth reporting: the worst case is re-fetching.
  }
}

function saveZhCacheSoon(): void {
  if (zhSaveTimer) return;
  zhSaveTimer = setTimeout(() => {
    zhSaveTimer = undefined;
    try {
      const file = zhCacheFile();
      mkdirSync(dirname(file), { recursive: true });
      const out: Record<string, ZhEntry> = {};
      for (const [key, entry] of zhCache) {
        // Drop expired negatives so the file does not grow forever.
        if (entry.zh === null && Date.now() - entry.at > ZH_TTL_MISS_MS) continue;
        out[key] = entry;
      }
      writeFileSync(file, JSON.stringify(out), 'utf8');
    } catch {
      // Cache writes are best-effort.
    }
  }, 2000);
  // Never hold the process open just to flush a cache.
  zhSaveTimer.unref?.();
}

function zhCached(title: string): { hit: boolean; zh: string | null } {
  loadZhCache();
  const entry = zhCache.get(compact(title));
  if (!entry) return { hit: false, zh: null };
  const ttl =
    entry.zh !== null
      ? ZH_TTL_HIT_MS
      : entry.unconfirmed
        ? ZH_TTL_UNCONFIRMED_MS
        : ZH_TTL_MISS_MS;
  if (Date.now() - entry.at > ttl) return { hit: false, zh: null };
  return { hit: true, zh: entry.zh };
}

/**
 * Query strings worth trying for one English title.
 *
 * mcmod's search is literal: apostrophes and colons make it return nothing
 * ("Create: Steam 'n' Rails" -> 0 results), so simplified variants are tried in
 * order. Every result is still validated by `chineseNameScore`, so a looser query
 * cannot attach the wrong Chinese name.
 */
function englishQueryVariants(title: string): string[] {
  const out: string[] = [];
  const push = (value: string): void => {
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  };

  // Drop a trailing parenthetical ("Just Enough Items (JEI)"). Safe and often
  // necessary: mcmod returns *zero* hits for the parenthesised form.
  const noParen = title.replace(/[(（][^()（）]*[)）]\s*$/, '');
  // Apostrophes/quotes/punctuation also yield zero hits, so they are stripped when
  // the title contains any. Colons are kept out of `risky` only because the
  // subtitle is a useful fallback query below.
  const risky = /['’`"]|[:：]/.test(title);
  const plain = title.replace(/['’`"]/g, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  // A subtitle after a colon ("Create: Steam 'n' Rails" is found under "Create").
  const head = title.split(/[:：]/)[0];

  if (risky) push(plain);
  push(noParen);
  push(title);
  push(plain);
  if (head && head !== title) push(head);
  return out.slice(0, 3);
}

/** Outcome of one reverse lookup. */
interface ZhLookup {
  zh: string | null;
  /**
   * True when mcmod actually answered with results (so "no Chinese name" is a
   * real answer). False means every query came back empty — most likely the
   * silent rate limit, so the negative must expire quickly.
   */
  confirmed: boolean;
}

/**
 * Resolve one English title to its Chinese name.
 *
 * Returns `zh: null` when mcmod has no Chinese name for it (many mods are listed
 * in English only) or when the lookup could not run. Never throws.
 */
async function lookupZhForEnglish(title: string): Promise<ZhLookup> {
  let sawAnyResults = false;
  const variants = englishQueryVariants(title);

  for (const [index, keyword] of variants.entries()) {
    const url = `${SEARCH_BASE}?key=${encodeURIComponent(keyword)}`;
    // An empty page is usually the silent rate limit rather than "no such mod", so
    // the last variant gets one retry. Earlier variants do not: if they came back
    // empty for that reason, the next variant serves as the retry anyway.
    const attempts = index === variants.length - 1 ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const html = await scheduleMcmod(() => fetchSearchHtml(url), McmodPriority.background);
      if (!html) break;

      let sawResults = false;
      let best: { score: number; zh: string } | null = null;
      for (const block of html.split('class="result-item"').slice(1, 10)) {
        const anchor = /<a[^>]*href="https:\/\/www\.mcmod\.cn\/class\/\d+\.html"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        if (!anchor) continue;
        const { zh, en } = parseAnchorTitle(anchor[1]);
        if (!en) continue;
        sawResults = true;
        // Must actually be a translation: an English-only entry ("IrisShaders")
        // is not a Chinese name and must not be shown as one.
        if (!CJK.test(zh)) continue;
        const score = chineseNameScore(title, en);
        if (score > 0 && (!best || score > best.score)) best = { score, zh };
      }

      if (best) return { zh: best.zh, confirmed: true };
      if (sawResults) {
        // Real answer: this query has results, none of them is this project.
        sawAnyResults = true;
        break;
      }
      noteRateLimited();
    }
  }

  return { zh: null, confirmed: sawAnyResults };
}

/**
 * Chinese name for an English project title, or `null` when there is none.
 *
 * Cached in memory and on disk; concurrent callers share one request.
 */
export async function resolveZhName(title: string): Promise<string | null> {
  const key = compact(title);
  if (!key) return null;

  const cached = zhCached(title);
  if (cached.hit) return cached.zh;

  const existing = zhInFlight.get(key);
  if (existing) return existing;

  const request = lookupZhForEnglish(title)
    .catch((): ZhLookup => ({ zh: null, confirmed: false }))
    .then((result) => {
      zhCache.set(key, { zh: result.zh, at: Date.now(), unconfirmed: !result.confirmed });
      saveZhCacheSoon();
      return result.zh;
    })
    .finally(() => {
      zhInFlight.delete(key);
    });

  zhInFlight.set(key, request);
  return request;
}

/**
 * Cached names for a batch of titles, without waiting for the network.
 *
 * The renderer calls this right after rendering a page of cards: whatever is
 * already known is returned synchronously from the cache, and the rest is queued
 * in the background. Newly resolved names arrive through `onZhNameResolved`.
 */
export function cachedZhNames(titles: readonly string[]): Record<string, string> {
  loadZhCache();
  const out: Record<string, string> = {};
  for (const title of titles) {
    const cached = zhCached(title);
    if (cached.hit && cached.zh) out[title] = cached.zh;
  }
  return out;
}

/** Cap on how many lookups one page of cards may queue. */
const MAX_BATCH = 30;

/**
 * Queue background lookups for a page of titles.
 *
 * Returns immediately; resolved names are pushed to `onZhNameResolved`. Titles
 * already cached (hit or miss) cost nothing.
 */
export function queueZhNames(titles: readonly string[]): void {
  loadZhCache();
  const seen = new Set<string>();
  let queued = 0;
  for (const title of titles) {
    if (queued >= MAX_BATCH) break;
    const key = compact(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (zhCached(title).hit) continue;
    queued += 1;
    void resolveZhName(title).then((zh) => {
      if (zh) notifyZhResolved(title, zh);
    });
  }
}

type ZhListener = (payload: { title: string; zh: string }) => void;
const zhListeners = new Set<ZhListener>();

/** Subscribe to names resolved in the background (main-process side). */
export function onZhNameResolved(listener: ZhListener): () => void {
  zhListeners.add(listener);
  return () => {
    zhListeners.delete(listener);
  };
}

function notifyZhResolved(title: string, zh: string): void {
  for (const listener of zhListeners) listener({ title, zh });
}

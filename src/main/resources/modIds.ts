/**
 * Persistent map from a resource project to the modId(s) its jar actually declares.
 *
 * Why this exists: the upstream APIs identify a mod by *their* project id
 * (`P7dR8mSH`, `238222`), while an installed jar identifies itself by the loader's
 * modId (`fabric-api`, `jei`). Nothing in the API response connects the two, so
 * "is Create already installed?" cannot be answered exactly for a jar that was
 * installed by some other launcher.
 *
 * The link is learned instead of guessed: every time this launcher installs a jar
 * it reads that jar's modIds and records them here. From then on the association is
 * exact for that project. Until a project has been installed once, callers fall
 * back to a slug/title heuristic (see `guessProjectModIds`).
 *
 * Entries are keyed `source:projectId` and capped, because the file is only a cache.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';

type MapFile = Record<string, string[]>;

const MAX_ENTRIES = 2000;

let cache: MapFile | null = null;
let saveTimer: NodeJS.Timeout | undefined;

function filePath(): string {
  return join(app.getPath('userData'), 'cache', 'mod-ids.json');
}

function load(): MapFile {
  if (cache) return cache;
  cache = {};
  try {
    const file = filePath();
    if (!existsSync(file)) return cache;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
          cache[key] = value as string[];
        }
      }
    }
  } catch {
    // A corrupt cache is not worth reporting; the worst case is a heuristic guess.
  }
  return cache;
}

function saveSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      const data = load();
      const keys = Object.keys(data);
      if (keys.length > MAX_ENTRIES) {
        for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete data[key];
      }
      const file = filePath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data), 'utf8');
    } catch {
      // Cache writes are best-effort.
    }
  }, 1500);
  // Never hold the process open just to flush a cache.
  saveTimer.unref?.();
}

/** modIds already learned for a project, or an empty array. */
export function knownProjectModIds(source: string, projectId: string): string[] {
  return load()[`${source}:${projectId}`] ?? [];
}

/** Record that installing `projectId` produced a jar declaring `ids`. */
export function rememberProjectModIds(source: string, projectId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const data = load();
  const key = `${source}:${projectId}`;
  const merged = [...new Set([...(data[key] ?? []), ...ids])];
  if (merged.length === data[key]?.length && (data[key] ?? []).every((v) => merged.includes(v))) {
    return;
  }
  data[key] = merged;
  saveSoon();
}

/** Lower-case, strip separators — modIds and slugs differ in `-`/`_`/case only. */
export function normalizeModKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Best-effort modId candidates for a project, used only before the association has
 * been learned.
 *
 * Modrinth's slug is usually the modId (`create`, `jei`, `fabric-api`), and many
 * Forge mods use their title without spaces, so both are tried.
 */
export function guessProjectModIds(slug: string, title: string): string[] {
  const out = new Set<string>();
  if (slug) out.add(slug);
  const fromTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (fromTitle) out.add(fromTitle);
  return [...out];
}

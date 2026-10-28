import { useEffect, useState } from 'react';
import type { DownloadProgress } from '@shared/types';

/**
 * Global download state shared by the floating bar, the resource page and the
 * download manager.
 *
 * Lives at module level so it survives page navigation (a download started on the
 * resource page keeps its state when the user moves to 版本管理).
 */

export interface ActiveDownload {
  kind: 'install' | 'repair';
  id: string;
  progress: DownloadProgress;
  /** Smoothed transfer rate in bytes/second (0 until the first sample). */
  speed: number;
  /** Wall-clock start time, for the elapsed counter. */
  startedAt: number;
}

/** A finished task, kept for the manager page's history list. */
export interface DownloadHistoryEntry {
  id: string;
  kind: ActiveDownload['kind'];
  ok: boolean;
  /** Failure message when `ok` is false. */
  error?: string;
  finishedAt: number;
  durationMs: number;
  /** Bytes transferred, when the task reported them. */
  bytes: number;
}

const MAX_HISTORY = 20;

let current: ActiveDownload | null = null;
let history: DownloadHistoryEntry[] = [];
const listeners = new Set<() => void>();

/** Speed sampling state: rate over a short window, smoothed to avoid jitter. */
let sampleAt = 0;
let sampleBytes = 0;

function emit(): void {
  for (const l of listeners) l();
}

export function startDownload(kind: ActiveDownload['kind'], id: string): void {
  current = {
    kind,
    id,
    progress: { progress: 0, totalBytes: 0, downloadedBytes: 0, task: '准备中…' },
    speed: 0,
    startedAt: Date.now(),
  };
  sampleAt = Date.now();
  sampleBytes = 0;
  emit();
}

/**
 * Feed a progress event. Speed is derived here rather than in the main process so
 * every stage (libraries, assets, modpacks) gets a number without extra plumbing.
 */
export function updateDownload(progress: DownloadProgress): void {
  if (!current) return;

  const now = Date.now();
  const elapsed = now - sampleAt;
  let speed = current.speed;

  // Re-sample every ~500ms: a shorter window is noisy, a longer one feels laggy.
  if (elapsed >= 500) {
    const delta = progress.downloadedBytes - sampleBytes;
    // Ignore negative deltas (a retry resets the counter) — keeping the previous
    // rate is friendlier than briefly showing 0.
    const instant = delta > 0 ? (delta / elapsed) * 1000 : 0;
    speed = instant > 0 ? (current.speed > 0 ? current.speed * 0.4 + instant * 0.6 : instant) : 0;
    sampleAt = now;
    sampleBytes = progress.downloadedBytes;
  }

  current = { ...current, progress, speed };
  emit();
}

function pushHistory(entry: DownloadHistoryEntry): void {
  history = [entry, ...history].slice(0, MAX_HISTORY);
}

/** Task reported an error. */
export function failDownload(message: string): void {
  if (!current) return;
  pushHistory({
    id: current.id,
    kind: current.kind,
    ok: false,
    error: message,
    finishedAt: Date.now(),
    durationMs: Date.now() - current.startedAt,
    bytes: current.progress.downloadedBytes,
  });
  current = null;
  emit();
}

/** User cancelled the task: drop it without recording a success or failure. */
export function cancelDownload(): void {
  if (!current) return;
  current = null;
  emit();
}

export function endDownload(): void {
  if (!current) return;
  pushHistory({
    id: current.id,
    kind: current.kind,
    ok: true,
    finishedAt: Date.now(),
    durationMs: Date.now() - current.startedAt,
    bytes: current.progress.downloadedBytes,
  });
  current = null;
  emit();
}

export function clearHistory(): void {
  history = [];
  emit();
}

/** Whether a download is currently active (used to disable install/repair buttons). */
export function isDownloading(): boolean {
  return current !== null;
}

export function getActiveDownload(): ActiveDownload | null {
  return current;
}

export function getDownloadHistory(): DownloadHistoryEntry[] {
  return history;
}

/**
 * React hook that tracks the global active download and history.
 * Returns both so the manager page and the floating bar can share one subscription.
 */
export function useDownloadState(): {
  active: ActiveDownload | null;
  history: DownloadHistoryEntry[];
} {
  const [state, setState] = useState(() => ({ active: current, history: [...history] }));
  useEffect(() => {
    const cb = (): void => setState({ active: current, history: [...history] });
    listeners.add(cb);
    cb();
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return state;
}

/** Back-compat hook used by the app shell for the floating progress bar. */
export function useActiveDownload(): ActiveDownload | null {
  return useDownloadState().active;
}

/**
 * Boolean variant for callers that only need "is something downloading?" — e.g. the
 * indicator dot on the resource page. Progress ticks replace `current` up to five
 * times a second; subscribing to the whole object there would re-render a page with
 * hundreds of cards that often. A boolean state value bails out of re-rendering
 * whenever it did not change.
 */
export function useIsDownloading(): boolean {
  const [downloading, setDownloading] = useState(() => current !== null);
  useEffect(() => {
    const cb = (): void => setDownloading(current !== null);
    listeners.add(cb);
    // Sync once: a task may have started or finished between render and subscribe.
    cb();
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return downloading;
}

/**
 * Just the identity of the running task, for pages that only need "which version
 * is being installed/repairing" (button labels, disabled states). Progress ticks
 * keep `current` fresh but the identity rarely changes, so the state update is
 * skipped when nothing changed and the page does not re-render five times a second.
 */
export function useDownloadTarget(): { kind: ActiveDownload['kind']; id: string } | null {
  const snapshot = (): { kind: ActiveDownload['kind']; id: string } | null =>
    current ? { kind: current.kind, id: current.id } : null;

  const [target, setTarget] = useState(snapshot);
  useEffect(() => {
    const cb = (): void =>
      setTarget((prev) => {
        const next = snapshot();
        if (prev === null || next === null) return prev === next ? prev : next;
        return prev.kind === next.kind && prev.id === next.id ? prev : next;
      });
    listeners.add(cb);
    cb();
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return target;
}

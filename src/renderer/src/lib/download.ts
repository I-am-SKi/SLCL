import { useEffect, useState } from 'react';
import type { DownloadProgress } from '@shared/types';

export interface ActiveDownload {
  kind: 'install' | 'repair';
  id: string;
  progress: DownloadProgress;
}

let current: ActiveDownload | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function startDownload(kind: ActiveDownload['kind'], id: string): void {
  current = {
    kind,
    id,
    progress: { progress: 0, totalBytes: 0, downloadedBytes: 0, task: '准备中…' },
  };
  emit();
}

export function updateDownload(progress: DownloadProgress): void {
  if (!current) return;
  current = { ...current, progress };
  emit();
}

export function endDownload(): void {
  current = null;
  emit();
}

/** Whether a download is currently active (used to disable install/repair buttons). */
export function isDownloading(): boolean {
  return current !== null;
}

/**
 * React hook that tracks the global active download. State lives at module level,
 * so it survives page navigation (fixes "download shows complete when switching pages").
 */
export function useActiveDownload(): ActiveDownload | null {
  const [d, setD] = useState<ActiveDownload | null>(current);
  useEffect(() => {
    const cb = (): void => setD(current);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return d;
}

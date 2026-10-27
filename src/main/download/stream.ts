import { createWriteStream } from 'fs';
import { once } from 'events';

/**
 * Download a URL to a file with stall protection.
 *
 * Minecraft's CDN (and BMCLAPI) sometimes accepts a connection then stops sending
 * bytes while keeping the socket open. A plain `fetch` + `pipeline` would wait
 * forever — the classic "install hangs on the last few files" symptom. Here we
 * abort when no bytes arrive for `stallMs`, and abort when no response headers
 * arrive within `headerMs`, so the caller can retry another source.
 */
export interface StallDownloadOptions {
  /** Upstream cancel signal (launcher "cancel download"). */
  signal?: AbortSignal;
  /** Abort when no bytes arrive for this long. Default 45s. */
  stallMs?: number;
  /** Abort when no response headers arrive within this long. Default 30s. */
  headerMs?: number;
  /** Error message used when the upstream `signal` fires. */
  cancelMessage?: string;
}

export async function downloadWithStall(
  url: string,
  dest: string,
  opts: StallDownloadOptions = {},
): Promise<void> {
  const stallMs = opts.stallMs ?? 45000;
  const headerMs = opts.headerMs ?? 30000;
  const cancelMessage = opts.cancelMessage ?? '已取消';
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) throw new Error(cancelMessage);
    opts.signal.addEventListener('abort', onAbort);
  }

  const headerTimer = setTimeout(() => controller.abort(new Error('连接超时')), headerMs);
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error('下载停滞')), stallMs);
  };

  let ws: ReturnType<typeof createWriteStream> | null = null;
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(headerTimer);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    armStall();
    ws = createWriteStream(dest);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        armStall();
        if (!ws.write(Buffer.from(value))) await once(ws, 'drain');
      }
    } finally {
      reader.releaseLock();
    }
    ws.end();
    await once(ws, 'finish');
  } catch (e) {
    if (opts.signal?.aborted) throw new Error(cancelMessage);
    ws?.destroy();
    throw e;
  } finally {
    clearTimeout(headerTimer);
    if (stallTimer) clearTimeout(stallTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

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
  /** Abort when no bytes arrive for this long. Default 20s. */
  stallMs?: number;
  /** Abort when no response headers arrive within this long. Default 15s. */
  headerMs?: number;
  /** Error message used when the upstream `signal` fires. */
  cancelMessage?: string;
  /** Extra request headers (the resource API needs the registered User-Agent). */
  headers?: Record<string, string>;
  /**
   * Called after every chunk with the number of bytes just received.
   *
   * Without this the caller can only report progress when a whole file finishes,
   * which makes the UI freeze during a large download — the "stuck at one number"
   * symptom. The callback is invoked per chunk (a few KB to a few MB), so callers
   * should keep the work inside it cheap.
   */
  onBytes?: (delta: number) => void;
}

export async function downloadWithStall(
  url: string,
  dest: string,
  opts: StallDownloadOptions = {},
): Promise<void> {
  const stallMs = opts.stallMs ?? 20000;
  const headerMs = opts.headerMs ?? 15000;
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
  // Declared outside the try so the catch block can report how many bytes arrived
  // when the connection dies mid-transfer.
  let received = 0;
  let expectedTotal = NaN;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: opts.headers });
    clearTimeout(headerTimer);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    armStall();
    ws = createWriteStream(dest);
    const reader = res.body.getReader();
    // A server that closes the connection early ends the stream *normally*
    // (`done: true`), so without this the partial file would look like a
    // successful download. That is how a 768 KB fragment of a mod ended up in a
    // player's mods folder and broke the game.
    const expected = Number(res.headers.get('content-length') ?? '');
    expectedTotal = expected;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        armStall();
        received += value.length;
        opts.onBytes?.(value.length);
        if (!ws.write(Buffer.from(value))) await once(ws, 'drain');
      }
    } finally {
      reader.releaseLock();
    }
    if (Number.isFinite(expected) && expected > 0 && received !== expected) {
      throw new Error(`连接提前关闭（已收到 ${received}/${expected} 字节）`);
    }
    ws.end();
    await once(ws, 'finish');
  } catch (e) {
    if (opts.signal?.aborted) throw new Error(cancelMessage);
    ws?.destroy();
    // Undici reports an early-closed body as a bare "terminated", which means
    // nothing to a user and hides that bytes are missing. Rewrite it with the
    // counts we tracked.
    const message = e instanceof Error ? e.message : String(e);
    const isTruncated = /terminated|aborted|ECONNRESET|premature/i.test(message);
    if (isTruncated) {
      if (Number.isFinite(expectedTotal) && expectedTotal > 0) {
        throw new Error(`连接提前关闭（已收到 ${received}/${expectedTotal} 字节）`);
      }
      throw new Error('连接提前关闭，文件未下载完整');
    }
    throw e;
  } finally {
    clearTimeout(headerTimer);
    if (stallTimer) clearTimeout(stallTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

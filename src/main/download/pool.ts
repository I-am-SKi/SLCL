/**
 * Bounded-concurrency helpers shared by the download stages.
 *
 * The version installer keeps its own pool because it also tracks byte counts per
 * item; the resource (modpack) flows only need "run these N downloads, at most K
 * at a time, report progress often but not on every chunk".
 */

export const CANCEL_MESSAGE = '已取消';

export interface RunPoolOptions {
  /** Stop handing out new items once this fires (user cancelled). */
  signal?: AbortSignal;
  /** Maximum parallel workers. Defaults to 8. */
  concurrency?: number;
  /** Message used when `signal` aborts; defaults to `CANCEL_MESSAGE`. */
  cancelMessage?: string;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 *
 * A worker that throws rejects the whole pool (fail fast). Callers that tolerate
 * individual failures — a single unavailable mod must not abort a modpack — have
 * to catch inside `worker`.
 */
export async function runPool<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  opts: RunPoolOptions = {},
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(opts.concurrency ?? 8, items.length));
  const cancelled = (): boolean => opts.signal?.aborted === true;
  let next = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      if (cancelled()) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => run()));
  if (cancelled()) throw new Error(opts.cancelMessage ?? CANCEL_MESSAGE);
}

export interface Throttle {
  /** Fire now, or schedule the next call after the interval. */
  emit(force?: boolean): void;
  /** Drop a scheduled call (task finished). */
  stop(): void;
}

/**
 * Coalesce progress callbacks.
 *
 * The main process streams bytes per network chunk; with several files in flight
 * that is hundreds of IPC messages per second. The renderer cannot keep up and
 * the transfer itself slows down, so progress is throttled to ~5/s.
 */
export function createThrottle(fn: () => void, intervalMs = 200): Throttle {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;

  const fire = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    last = Date.now();
    fn();
  };

  return {
    emit(force = false): void {
      if (force) {
        fire();
        return;
      }
      const now = Date.now();
      const wait = intervalMs - (now - last);
      if (wait <= 0) {
        fire();
        return;
      }
      if (!timer) timer = setTimeout(fire, wait);
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

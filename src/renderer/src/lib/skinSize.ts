/**
 * Skin size helpers shared by the launcher UI.
 *
 * Minecraft only accepts two skin resolutions: 64×64 (modern) and 64×32 (legacy).
 * A 128×128 "HD" skin cannot be uploaded to a Microsoft account *and* cannot be
 * served to an offline account either — the client resizes the texture grid from
 * the image dimensions, so a 128×128 file silently fails and the player stays on
 * Steve. Both paths therefore have to reject it before anything is written.
 *
 * Main-process counterparts: `isUploadableSkinSize` / `assertUploadableSkin` in
 * `src/main/auth/index.ts`.
 */
import { loadSkinPngUrl } from './skinImage';

export interface SkinSize {
  width: number;
  height: number;
}

/** Whether the client can actually render a skin of this size. */
export function isSupportedSkinSize(width: number, height: number): boolean {
  return width === 64 && (height === 64 || height === 32);
}

/** Human-readable explanation for an unsupported size. */
export function unsupportedSkinSizeMessage(size: SkinSize): string {
  return (
    `Minecraft 客户端只接受 64×64 或 64×32 的皮肤，这款是 ${size.width}×${size.height}，` +
    `无法用于正版上传，也无法用于离线启动。`
  );
}

const cache = new Map<string, SkinSize | null>();
const MAX_ENTRIES = 200;
/** In-flight measurements, so a re-render cannot trigger a second decode. */
const pending = new Map<string, Promise<SkinSize | null>>();

/**
 * Natural pixel size of a skin image.
 *
 * Reuses `loadSkinPngUrl`'s blob cache, so for library cards (which already render
 * through it) this costs no extra network request. Resolves to null when the image
 * cannot be loaded — callers must treat that as "unknown", never as "supported".
 */
export function measureSkinSize(src: string): Promise<SkinSize | null> {
  const hit = cache.get(src);
  if (hit !== undefined) return Promise.resolve(hit);

  const existing = pending.get(src);
  if (existing) return existing;

  const request = (async (): Promise<SkinSize | null> => {
    try {
      const url = await loadSkinPngUrl(src);
      return await new Promise<SkinSize | null>((resolve) => {
        const img = new Image();
        img.onload = (): void => {
          const size =
            img.naturalWidth > 0 && img.naturalHeight > 0
              ? { width: img.naturalWidth, height: img.naturalHeight }
              : null;
          resolve(size);
        };
        img.onerror = (): void => resolve(null);
        img.src = url;
      });
    } catch {
      return null;
    }
  })()
    .then((size) => {
      if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(src, size);
      return size;
    })
    .finally(() => {
      pending.delete(src);
    });

  pending.set(src, request);
  return request;
}

/**
 * Read a PNG's dimensions from raw bytes (IHDR chunk at offsets 16..23).
 *
 * Used for a just-picked local file, where the bytes are already in memory as a
 * data URL — no image decode and no cache entry needed.
 */
export function pngSizeFromDataUrl(dataUrl: string): SkinSize | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    if (binary.length < 24) return null;
    const bytes = new Uint8Array(24);
    for (let i = 0; i < 24; i += 1) bytes[i] = binary.charCodeAt(i);
    // PNG signature.
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
    const view = new DataView(bytes.buffer);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  } catch {
    return null;
  }
}

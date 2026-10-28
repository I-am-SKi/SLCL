/**
 * Skin image loader.
 *
 * Two server-side quirks make the obvious `<img src={url}>` approach wrong:
 *
 * 1. **Content negotiation.** The site picks the response format from `Accept`.
 *    The browser's default wildcard yields a lossy **AVIF** re-encode, and AVIF's
 *    chroma subsampling wrecks flat pixel-art colours — an exact `rgb(204,36,6)`
 *    comes back as `rgb(197,37,11)`, mid-tones drift by up to 23 per channel.
 *    Requesting `Accept: image/png` asks for the original bytes.
 *
 * 2. **Missing `Vary: Accept`.** The response says `cache-control: public` but does
 *    not declare that it varies by `Accept`. So once *any* request caches the AVIF
 *    variant, every later request for that URL is served the AVIF from the HTTP
 *    cache — including requests that explicitly ask for PNG. `cache: 'no-store'`
 *    is therefore required; it is what actually makes the format stick.
 *
 * Verified against the raw PNG bytes: with both measures the canvas matches the
 * source file pixel-for-pixel; without `no-store` it silently reverts to AVIF.
 *
 * Results are memoised per URL; the library has ~20 skins of a few KB each.
 */

const MAX_ENTRIES = 200;
const cache = new Map<string, string>();

/** Fetch a skin as its original PNG bytes and return a blob URL for it. */
export async function loadSkinPngUrl(src: string): Promise<string> {
  // Locally-produced skins (chosen in the launcher, or cached from Mojang) are
  // already lossless data URLs — passing them through the network path would only
  // add a large key to the cache.
  if (src.startsWith('data:') || src.startsWith('blob:')) return src;

  const hit = cache.get(src);
  if (hit) return hit;

  const res = await fetch(src, {
    headers: { Accept: 'image/png' },
    // Essential — see the note above about the missing Vary header.
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`皮肤加载失败 (${res.status})`);

  const blob = await res.blob();
  // Guard: if the server ever ignores Accept, the colours would silently drift
  // again. Fail loudly so the caller can fall back instead of showing a wrong skin.
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (!isPng) throw new Error('服务器未返回 PNG');

  const url = URL.createObjectURL(blob);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const oldUrl = cache.get(oldest);
      cache.delete(oldest);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
    }
  }
  cache.set(src, url);
  return url;
}

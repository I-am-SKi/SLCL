import { useEffect, useRef, type JSX } from 'react';
import { loadSkinPngUrl } from '../lib/skinImage';

/**
 * Renders the front face of a Minecraft skin's head, with the base layer and the
 * hat/hair layer composited exactly like the game does.
 *
 * Coordinates live on Minecraft's canonical 64x64 UV grid, but skins are often
 * published at higher resolutions (128x128 "HD" skins are common in the team
 * library), so every coordinate is multiplied by `naturalWidth / 64`.
 *
 *   base head face  (8, 8)  8x8
 *   hat overlay     (40, 8) 8x8   (absent on legacy 64x32 skins)
 *
 * The image is fetched through `loadSkinPngUrl`, which forces the server to serve
 * the original PNG. Loading the URL directly yields a lossy AVIF re-encode and
 * visibly wrong colours — see that module for the measurements.
 */
const UV_GRID = 64;
const HEAD_X = 8;
const HEAD_Y = 8;
const HAT_X = 40;
const HEAD_SIZE = 8;

export default function SkinHead({
  skin,
  size = 64,
}: {
  skin: string;
  size?: number;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = size;
    canvas.height = size;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    if (!skin) return;

    // `cancelled` guards against a stale image winning the race after the
    // component re-renders with a different skin.
    let cancelled = false;

    const draw = (src: string): void => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = (): void => {
        if (cancelled) return;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w <= 0 || h <= 0) return;

        const scale = w / UV_GRID;
        const srcSize = HEAD_SIZE * scale;

        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, HEAD_X * scale, HEAD_Y * scale, srcSize, srcSize, 0, 0, size, size);

        // The hat layer only exists on modern skins (>= 64 units tall on the grid),
        // which excludes legacy 64x32 skins where the lower half is absent.
        if (h / scale >= UV_GRID) {
          ctx.drawImage(img, HAT_X * scale, HEAD_Y * scale, srcSize, srcSize, 0, 0, size, size);
        }
      };
      img.src = src;
    };

    loadSkinPngUrl(skin)
      .then((blobUrl) => {
        if (!cancelled) draw(blobUrl);
      })
      .catch(() => {
        // Direct URL fallback: colours may drift, but showing something beats a
        // blank avatar when the explicit fetch is blocked.
        if (!cancelled) draw(skin);
      });

    return () => {
      cancelled = true;
    };
  }, [skin, size]);

  return <canvas ref={canvasRef} className="skin-head" style={{ width: size, height: size }} />;
}

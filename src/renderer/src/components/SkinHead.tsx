import { useEffect, useRef, type JSX } from 'react';

/**
 * Renders the front face of a Minecraft skin's head with the double-layer
 * (base head + hat overlay) composited — like the in-game avatar.
 *
 * Skin UV layout (64x64): base head face at (8,8) 8x8, hat overlay at (40,8) 8x8.
 * Legacy 64x32 skins have no overlay, so we skip it when height < 64.
 */
export default function SkinHead({ skin, size = 64 }: { skin: string; size?: number }): JSX.Element {
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
    const img = new Image();
    img.onload = (): void => {
      // Base head face.
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, size, size);
      // Hat overlay (only present on 64x64 skins).
      if (img.naturalHeight >= 64 && img.naturalWidth >= 64) {
        ctx.drawImage(img, 40, 8, 8, 8, 0, 0, size, size);
      }
    };
    img.src = skin;
  }, [skin, size]);

  return <canvas ref={canvasRef} className="skin-head" style={{ width: size, height: size }} />;
}

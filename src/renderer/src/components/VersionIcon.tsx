import type { JSX } from 'react';
import type { LocalMinecraftVersion } from '@shared/types';

/**
 * Minecraft-style pixel-art icons for installed versions.
 *
 * Each icon is drawn on a 16x16 grid with `shapeRendering="crispEdges"`, so it
 * scales up cleanly and matches the in-game inventory look:
 *   - vanilla      -> grass block
 *   - forge/neoforge -> anvil
 *   - fabric/quilt -> 3D wool render (public/fabric.png)
 *   - old alpha/beta -> cobblestone
 *   - snapshot     -> command block
 *   - April Fools  -> gold block
 */
export type VersionIconKind = 'vanilla' | 'forge' | 'fabric' | 'old' | 'snapshot' | 'april-fools' | 'unknown';

/** Known April Fools releases - these are served as `type: snapshot` by Mojang. */
const APRIL_FOOLS = new Set([
  '15w14a',
  '1.rv-pre1',
  '3d shareware v1.34',
  '20w14infinite',
  '22w13oneblockatatime',
  '23w13a_or_b',
  '24w14potato',
  '25w14craftmine',
  '1.21.9.1-fools',
]);

/** Pick the icon variant for an installed version. */
export function versionIconKind(v: LocalMinecraftVersion): VersionIconKind {
  const id = v.id.toLowerCase().trim();
  const mc = v.minecraftVersion.toLowerCase().trim();
  const type = (v.type || '').toLowerCase();

  if (APRIL_FOOLS.has(id) || APRIL_FOOLS.has(mc)) return 'april-fools';
  if (v.loader === 'forge' || v.loader === 'neoforge') return 'forge';
  if (v.loader === 'fabric' || v.loader === 'quilt') return 'fabric';
  if (type.startsWith('old')) return 'old';
  if (type === 'snapshot' || type === 'snapshot_pre' || /\d\dw\d\d[a-z]$/.test(mc)) return 'snapshot';
  if (type === 'release' || /^1\.\d+/.test(mc)) return 'vanilla';
  return 'unknown';
}

/** Human-readable label for the icon variant (used as the tooltip badge). */
export function versionIconLabel(kind: VersionIconKind): string {
  switch (kind) {
    case 'vanilla':
      return '原版';
    case 'forge':
      return 'Anvil / Forge';
    case 'fabric':
      return 'Wool / Fabric';
    case 'old':
      return 'Cobblestone / 远古版';
    case 'snapshot':
      return 'Command Block / 预览版';
    case 'april-fools':
      return 'Gold Block / 愚人节版';
    default:
      return '未知版本';
  }
}

function GrassBlock(): JSX.Element {
  return (
    <>
      <rect width="16" height="16" fill="#8a5a30" />
      <rect y="0" width="16" height="4" fill="#5d9c3c" />
      <rect y="4" width="16" height="1" fill="#457a2b" />
      {/* grass highlights */}
      <rect x="1" y="1" width="3" height="1" fill="#71b54a" />
      <rect x="7" y="1" width="4" height="1" fill="#71b54a" />
      <rect x="12" y="2" width="3" height="1" fill="#71b54a" />
      <rect x="3" y="2" width="2" height="1" fill="#4c8a30" />
      <rect x="10" y="3" width="3" height="1" fill="#4c8a30" />
      {/* dirt speckles */}
      <rect x="2" y="6" width="3" height="2" fill="#734824" />
      <rect x="8" y="7" width="2" height="2" fill="#9c6b3c" />
      <rect x="12" y="6" width="2" height="2" fill="#734824" />
      <rect x="4" y="10" width="2" height="2" fill="#9c6b3c" />
      <rect x="10" y="11" width="3" height="2" fill="#734824" />
      <rect x="1" y="13" width="3" height="2" fill="#734824" />
      <rect x="6" y="13" width="2" height="2" fill="#9c6b3c" />
      <rect x="13" y="12" width="2" height="3" fill="#9c6b3c" />
    </>
  );
}

function Cobblestone(): JSX.Element {
  return (
    <>
      <rect width="16" height="16" fill="#7d7d7d" />
      <rect x="0" y="0" width="7" height="4" fill="#8e8e8e" />
      <rect x="7" y="0" width="9" height="3" fill="#6b6b6b" />
      <rect x="0" y="4" width="4" height="5" fill="#6b6b6b" />
      <rect x="4" y="4" width="7" height="3" fill="#999999" />
      <rect x="11" y="3" width="5" height="6" fill="#848484" />
      <rect x="0" y="9" width="8" height="3" fill="#8e8e8e" />
      <rect x="8" y="9" width="4" height="4" fill="#5f5f5f" />
      <rect x="12" y="9" width="4" height="3" fill="#8e8e8e" />
      <rect x="0" y="12" width="5" height="4" fill="#5f5f5f" />
      <rect x="5" y="12" width="7" height="4" fill="#999999" />
      <rect x="12" y="12" width="4" height="4" fill="#6b6b6b" />
      {/* mortar grooves */}
      <rect x="0" y="4" width="16" height="1" fill="#4f4f4f" />
      <rect x="0" y="9" width="16" height="1" fill="#4f4f4f" />
      <rect x="0" y="12" width="16" height="1" fill="#4f4f4f" />
    </>
  );
}

function Anvil(): JSX.Element {
  return (
    <>
      <rect width="16" height="16" fill="transparent" />
      {/* top face */}
      <rect x="3" y="3" width="11" height="2" fill="#5c5c5c" />
      <rect x="2" y="4" width="2" height="2" fill="#4a4a4a" />
      <rect x="4" y="5" width="8" height="1" fill="#3a3a3a" />
      {/* shoulder */}
      <rect x="5" y="6" width="6" height="1" fill="#454545" />
      {/* neck */}
      <rect x="6" y="7" width="4" height="3" fill="#3d3d3d" />
      <rect x="6" y="7" width="1" height="3" fill="#2c2c2c" />
      {/* base */}
      <rect x="4" y="10" width="8" height="2" fill="#4a4a4a" />
      <rect x="3" y="12" width="10" height="2" fill="#333333" />
      {/* highlights */}
      <rect x="3" y="3" width="5" height="1" fill="#787878" />
      <rect x="4" y="10" width="4" height="1" fill="#666666" />
    </>
  );
}

function CommandBlock(): JSX.Element {
  return (
    <>
      <rect width="16" height="16" fill="#4f3421" />
      {/* metal frame */}
      <rect x="1" y="1" width="14" height="14" fill="#b0763f" />
      <rect x="1" y="1" width="14" height="1" fill="#d59a5b" />
      <rect x="1" y="14" width="14" height="1" fill="#8a5729" />
      {/* inner panel */}
      <rect x="3" y="3" width="10" height="10" fill="#c98a4b" />
      <rect x="3" y="3" width="10" height="1" fill="#e0a86a" />
      {/* circuit dots */}
      <rect x="5" y="5" width="2" height="2" fill="#6b4423" />
      <rect x="9" y="5" width="2" height="2" fill="#6b4423" />
      <rect x="7" y="7" width="2" height="2" fill="#f0c48a" />
      <rect x="5" y="9" width="2" height="2" fill="#6b4423" />
      <rect x="9" y="9" width="2" height="2" fill="#6b4423" />
      <rect x="7" y="3" width="2" height="1" fill="#6b4423" />
    </>
  );
}

function GoldBlock(): JSX.Element {
  return (
    <>
      <rect width="16" height="16" fill="#f2cf3f" />
      <rect x="0" y="0" width="16" height="2" fill="#ffe97b" />
      <rect x="0" y="14" width="16" height="2" fill="#cf9f1d" />
      <rect x="0" y="0" width="2" height="16" fill="#ffe06a" />
      <rect x="14" y="0" width="2" height="16" fill="#d8a824" />
      {/* shine */}
      <rect x="4" y="3" width="3" height="1" fill="#fff3a8" />
      <rect x="3" y="4" width="2" height="2" fill="#fff3a8" />
      <rect x="10" y="7" width="3" height="1" fill="#e0b62b" />
      <rect x="5" y="10" width="2" height="2" fill="#e0b62b" />
      <rect x="9" y="11" width="4" height="1" fill="#e0b62b" />
      <rect x="6" y="6" width="4" height="1" fill="#fde25c" />
    </>
  );
}

function UnknownBlock(): JSX.Element {
  return (
    <>
      <rect width="16" height="16" fill="#1b1b1b" />
      {[0, 2, 4, 6, 8, 10, 12, 14].map((y) =>
        [0, 2, 4, 6, 8, 10, 12, 14].map((x) =>
          (x / 2 + y / 2) % 2 === 0 ? <rect key={`${x}-${y}`} x={x} y={y} width="2" height="2" fill="#d92bd9" /> : null,
        ),
      )}
    </>
  );
}

/**
 * Version icon for an installed version.
 *
 * Most variants are hand-drawn 16脳16 pixel art (crisp, inventory-like). Fabric
 * uses a supplied 3D render (`public/fabric.png`) instead, which already looks
 * correct at any size and is used for both Fabric and Quilt versions.
 */
export default function VersionIcon({
  kind,
  size = 32,
}: {
  kind: VersionIconKind;
  size?: number;
}): JSX.Element {
  if (kind === 'fabric') {
    return (
      <img
        className="version-icon version-icon-img"
        src="fabric.png"
        width={size}
        height={size}
        alt={versionIconLabel(kind)}
        draggable={false}
      />
    );
  }

  return (
    <svg
      className="version-icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label={versionIconLabel(kind)}
    >
      {kind === 'vanilla' && <GrassBlock />}
      {kind === 'forge' && <Anvil />}
      {kind === 'old' && <Cobblestone />}
      {kind === 'snapshot' && <CommandBlock />}
      {kind === 'april-fools' && <GoldBlock />}
      {kind === 'unknown' && <UnknownBlock />}
    </svg>
  );
}

import { useEffect, useState, type JSX } from 'react';

/**
 * Launch splash.
 *
 * Plays once per app start, before the main shell is revealed:
 *   0.00s  the launcher icon scales up from 0.6 while fading in, over a soft
 *          accent glow that expands with it
 *   0.39s  the "SLCL" wordmark rises into place
 *   0.66s  the "SLATT CLIENT" subtitle fades in
 *   1.17s  hold, then the whole overlay fades out and scales up slightly
 *   ~1.50s unmounted, main UI takes over
 *
 * The overlay sits above the app and blocks interaction while visible. It is
 * removed from the DOM once done (not just hidden) so it can never intercept
 * clicks afterwards.
 *
 * `prefers-reduced-motion` removes it immediately: the splash is decorative, so
 * users who ask for less motion get none.
 */

/** Total on-screen time. The CSS keyframes in global.css are scaled to match. */
const TOTAL_MS = 1500;
/** When the exit fade begins; the remainder is the fade-out. */
const FADE_START_MS = 1170;

export function Splash(): JSX.Element | null {
  const [phase, setPhase] = useState<'playing' | 'leaving' | 'done'>('playing');

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhase('done');
      return;
    }

    const fadeTimer = setTimeout(() => setPhase('leaving'), FADE_START_MS);
    const doneTimer = setTimeout(() => setPhase('done'), TOTAL_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, []);

  if (phase === 'done') return null;

  return (
    <div className={`splash${phase === 'leaving' ? ' leaving' : ''}`} aria-hidden="true">
      <div className="splash-inner">
        <div className="splash-glow" />
        <img className="splash-logo" src="logo.png" alt="" />
        <div className="splash-name">SLCL</div>
        <div className="splash-sub">SLATT CLIENT</div>
      </div>
    </div>
  );
}

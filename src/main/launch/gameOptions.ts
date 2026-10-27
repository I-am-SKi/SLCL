import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Minecraft shows the "Welcome to Minecraft" accessibility onboarding screen on a
 * fresh game directory (or when `options.txt` is missing). That screen narrates
 * "Press Enter to enable the narrator", which users experience as the game
 * "starting in narrator mode" — and because SLCL isolates every version in its own
 * folder, *every* newly installed version hits it.
 *
 * Writing `onboardAccessibility:false` marks the onboarding as completed so the
 * screen never appears; `narrator:0` keeps the narrator off. Existing user choices
 * are preserved: we only reset `narrator` when onboarding was never completed,
 * which means the value came from that first-launch screen rather than intent.
 */
const ONBOARD_KEY = 'onboardAccessibility';

function keyOf(line: string): string | null {
  const idx = line.indexOf(':');
  if (idx <= 0) return null;
  return line.slice(0, idx).trim();
}

/**
 * Ensure the game directory has an options.txt that skips the narrator onboarding.
 * Never throws — a failure here must not block launching the game.
 */
export function ensureGameOptions(gameDir: string): void {
  try {
    const file = join(gameDir, 'options.txt');
    mkdirSync(gameDir, { recursive: true });

    if (!existsSync(file)) {
      writeFileSync(file, `${ONBOARD_KEY}:false\nnarrator:0\n`, 'utf8');
      return;
    }

    const text = readFileSync(file, 'utf8');
    // Preserve the file's dominant line ending.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    // Trailing empty string from a final newline: drop it, re-add below.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    let hadOnboard = false;
    let narratorIndex = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const key = keyOf(lines[i]);
      if (key === ONBOARD_KEY) hadOnboard = true;
      else if (key === 'narrator') narratorIndex = i;
    }

    let changed = false;
    if (!hadOnboard) {
      lines.push(`${ONBOARD_KEY}:false`);
      changed = true;
    }

    if (narratorIndex < 0) {
      lines.push('narrator:0');
      changed = true;
    } else if (!hadOnboard) {
      // Onboarding never completed => the value came from the first-launch screen.
      const current = lines[narratorIndex].slice(lines[narratorIndex].indexOf(':') + 1).trim();
      if (current !== '0') {
        lines[narratorIndex] = 'narrator:0';
        changed = true;
      }
    }

    if (changed) writeFileSync(file, lines.join(eol) + eol, 'utf8');
  } catch {
    /* best-effort */
  }
}

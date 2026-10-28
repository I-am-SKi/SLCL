/**
 * SLATT team-account state shared between App (startup restore), the home page
 * (membership badge) and the 更多 page (login form + skin library).
 *
 * Mirrors the `appearance.ts` pattern: a module singleton plus subscribers, so
 * every surface sees the same login without prop-drilling.
 */
import type { SlattSession } from '@shared/types';

let current: SlattSession | null = null;
/** Distinguishes "still checking" from "checked, not signed in". */
let ready = false;
const listeners = new Set<(s: SlattSession | null) => void>();

function emit(): void {
  for (const l of listeners) l(current);
}

export function getSlattSession(): SlattSession | null {
  return current;
}

export function isSlattReady(): boolean {
  return ready;
}

export function setSlattSession(session: SlattSession | null): void {
  current = session;
  ready = true;
  emit();
}

export function subscribeSlatt(listener: (s: SlattSession | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Validate the stored token once per app start. Failures are swallowed on
 * purpose: a network problem must not surface as an error toast on the home page,
 * and the user simply stays signed out until the next attempt.
 */
export async function restoreSlatt(): Promise<SlattSession | null> {
  try {
    const session = await window.slcl.slatt.restore();
    setSlattSession(session);
    return session;
  } catch {
    setSlattSession(null);
    return null;
  }
}

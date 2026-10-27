/**
 * Appearance state (color mode + accent theme + custom background) shared between
 * App (which renders the background layer and the `data-*` attributes) and the
 * 更多 page (which edits it). Keeping it in a module singleton means both stay in
 * sync without prop-drilling, and the launcher persists the values to settings.
 */
export type ColorMode = 'dark' | 'light';

export interface Appearance {
  colorMode: ColorMode;
  theme: string;
  backgroundImage: string;
  backgroundOpacity: number;
}

let current: Appearance = {
  colorMode: 'dark',
  theme: 'emerald',
  backgroundImage: '',
  backgroundOpacity: 0.35,
};
const listeners = new Set<(a: Appearance) => void>();

const THEME_IDS = new Set(['emerald', 'ocean', 'sunset', 'sakura', 'violet', 'lime', 'red', 'indigo']);

function emit(): void {
  for (const l of listeners) l(current);
}

/** Push the palette onto <html> so the CSS variables switch instantly. */
function applyToDom(): void {
  const root = document.documentElement;
  const mode = current.colorMode === 'light' ? 'light' : 'dark';
  root.setAttribute('data-mode', mode);
  root.setAttribute('data-theme', THEME_IDS.has(current.theme) ? current.theme : 'emerald');
  // Mirror to localStorage so `main.tsx` can apply the mode before first paint.
  try {
    localStorage.setItem('slcl-color-mode', mode);
  } catch {
    /* ignore quota/availability errors */
  }
}

export function getAppearance(): Appearance {
  return current;
}

/** Update appearance and immediately reflect it in the DOM. */
export function setAppearance(partial: Partial<Appearance>): Appearance {
  current = { ...current, ...partial };
  if (current.colorMode !== 'light') current.colorMode = 'dark';
  applyToDom();
  emit();
  return current;
}

export function subscribeAppearance(listener: (a: Appearance) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read persisted appearance and apply it once at startup. */
export async function initAppearance(): Promise<Appearance> {
  try {
    const s = await window.slcl.settings.get();
    return setAppearance({
      colorMode: s.colorMode === 'light' ? 'light' : 'dark',
      theme: s.theme || 'emerald',
      backgroundImage: s.backgroundImage ?? '',
      backgroundOpacity: typeof s.backgroundOpacity === 'number' ? s.backgroundOpacity : 0.35,
    });
  } catch {
    return setAppearance({});
  }
}

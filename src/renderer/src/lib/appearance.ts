/**
 * Appearance state (color mode + accent theme + custom background) shared between
 * App (which renders the background layer and the `data-*` attributes) and the
 * 更多 page (which edits it). Keeping it in a module singleton means both stay in
 * sync without prop-drilling, and the launcher persists the values to settings.
 */
import { THEME_IDS as THEME_IDS_LIST } from './themes';

export type ColorMode = 'dark' | 'light';

/** Title bar label mode: the shipped logo + "SLCL", or a user-supplied text. */
export type TitlebarMode = 'default' | 'custom';

export interface Appearance {
  colorMode: ColorMode;
  theme: string;
  backgroundImage: string;
  backgroundOpacity: number;
  titlebarMode: TitlebarMode;
  /** Only meaningful when `titlebarMode === 'custom'`; blank means "no title". */
  titlebarText: string;
  /** Independent of the text: the logo can be hidden while keeping a title. */
  titlebarIcon: boolean;
}

let current: Appearance = {
  colorMode: 'dark',
  theme: 'emerald',
  backgroundImage: '',
  backgroundOpacity: 0.35,
  titlebarMode: 'default',
  titlebarText: '',
  titlebarIcon: true,
};
const listeners = new Set<(a: Appearance) => void>();

// Derived from THEMES so a new theme can never be forgotten here — an id missing
// from this set would silently fall back to emerald when applied.
const THEME_IDS = new Set(THEME_IDS_LIST);

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
      titlebarMode: s.titlebarMode === 'custom' ? 'custom' : 'default',
      titlebarText: typeof s.titlebarText === 'string' ? s.titlebarText : '',
      // Missing on configs written before the toggle existed: default to showing it.
      titlebarIcon: typeof s.titlebarIcon === 'boolean' ? s.titlebarIcon : true,
    });
  } catch {
    return setAppearance({});
  }
}

/**
 * Launcher color themes. Each id maps to a set of CSS variables defined under
 * `:root[data-theme='<id>']` (dark) and `:root[data-mode='light'][data-theme='<id>']`
 * (light) in global.css — only the accent triad changes, so the look stays minimal
 * and the theme colour is unambiguous.
 *
 * Ordered by hue, sweeping the colour wheel: red → orange → yellow → green → cyan
 * → blue → violet → magenta → pink. The picker renders this array as-is, so the
 * order here *is* the order users see — keep it monotonic in hue when adding one.
 *
 * The colours are not picked by eye. They were chosen so that the closest pair of
 * themes stays perceptually distinct (CIE Lab ΔE): 26 in dark mode and 18 in light
 * mode, with every light-mode accent keeping white text at WCAG AA (≥ 4.5:1) on a
 * filled button. Adding a theme without re-checking those numbers will reintroduce
 * the "these two look the same" problem.
 */
export interface ThemeDef {
  id: string;
  name: string;
  /** Swatch colour in dark mode. */
  color: string;
  /** Swatch colour in light mode (deeper, to match the applied accent). */
  colorLight: string;
}

export const THEMES: ThemeDef[] = [
  { id: 'red', name: '朱红', color: '#eb1414', colorLight: '#a10c0c' },
  { id: 'sunset', name: '日落橙', color: '#f68331', colorLight: '#c15508' },
  { id: 'yellow', name: '明黄', color: '#d3ab0d', colorLight: '#8e7306' },
  { id: 'lime', name: '青柠', color: '#93e01f', colorLight: '#52820a' },
  { id: 'green', name: '森绿', color: '#2bb62b', colorLight: '#108410' },
  { id: 'emerald', name: '翡翠绿', color: '#1ce3ae', colorLight: '#0c8665' },
  { id: 'teal', name: '碧青', color: '#19c2c8', colorLight: '#0c8286' },
  { id: 'ocean', name: '海洋蓝', color: '#2cb0f2', colorLight: '#0977ae' },
  { id: 'blue', name: '蔚蓝', color: '#0f53c7', colorLight: '#083a91' },
  { id: 'indigo', name: '靛蓝', color: '#434fef', colorLight: '#0f1bc7' },
  { id: 'violet', name: '紫罗兰', color: '#4f11df', colorLight: '#350a99' },
  { id: 'purple', name: '紫水晶', color: '#b44def', colorLight: '#7d0ebe' },
  { id: 'fuchsia', name: '洋红', color: '#ed12ed', colorLight: '#900990' },
  { id: 'sakura', name: '樱花粉', color: '#ee3ab2', colorLight: '#b60c7d' },
  { id: 'rose', name: '玫红', color: '#da1054', colorLight: '#990a3a' },
];

/** Every valid theme id, for validating persisted settings. */
export const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

export function themeName(id: string): string {
  return THEMES.find((t) => t.id === id)?.name ?? '翡翠绿';
}

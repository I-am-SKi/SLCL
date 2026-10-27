/**
 * Launcher color themes. Each id maps to a set of CSS variables defined under
 * `:root[data-theme='<id>']` (dark) and `:root[data-mode='light'][data-theme='<id>']`
 * (light) in global.css — only the accent triad changes, so the look stays minimal
 * and the theme colour is unambiguous.
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
  { id: 'emerald', name: '翡翠绿', color: '#22d3a5', colorLight: '#047857' },
  { id: 'ocean', name: '海洋蓝', color: '#38bdf8', colorLight: '#0369a1' },
  { id: 'sunset', name: '日落橙', color: '#f97316', colorLight: '#c2410c' },
  { id: 'sakura', name: '樱花粉', color: '#ec4899', colorLight: '#be185d' },
  { id: 'violet', name: '紫罗兰', color: '#8b5cf6', colorLight: '#6d28d9' },
  { id: 'lime', name: '青柠', color: '#84cc16', colorLight: '#4d7c0f' },
  { id: 'red', name: '朱红', color: '#ef4444', colorLight: '#b91c1c' },
  { id: 'indigo', name: '靛蓝', color: '#818cf8', colorLight: '#4338ca' },
];

export function themeName(id: string): string {
  return THEMES.find((t) => t.id === id)?.name ?? '翡翠绿';
}

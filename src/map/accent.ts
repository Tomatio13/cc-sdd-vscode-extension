// The work map's accent palettes. The rest of this extension's views are
// monochrome, so the default keeps the map grey until something runs.
export type AccentName = 'mono' | 'teal' | 'amber';

export const ACCENT_NAMES: readonly AccentName[] = ['mono', 'teal', 'amber'];

export interface AccentColors {
  accent: string;
  active: string;
}

/** Fallbacks used when the webview cannot read the editor's CSS variables. */
export const ACCENT_PALETTES: Record<
  AccentName,
  { dark: AccentColors; light: AccentColors }
> = {
  mono: {
    dark: { accent: '#9ba1ab', active: '#ebe6dc' },
    light: { accent: '#5f6570', active: '#1f2228' },
  },
  teal: {
    dark: { accent: '#62c7ba', active: '#a5e6dc' },
    light: { accent: '#1c8c81', active: '#136a62' },
  },
  amber: {
    dark: { accent: '#e1ac6e', active: '#f0c595' },
    light: { accent: '#b8762a', active: '#8f560f' },
  },
};

export const isAccentName = (value: unknown): value is AccentName =>
  typeof value === 'string' && (ACCENT_NAMES as readonly string[]).includes(value);

/** An unknown value, including the former `vscode` and `blue`, falls back to `mono`. */
export const accentColors = (
  name: string | undefined,
  theme: 'dark' | 'light',
): AccentColors => ACCENT_PALETTES[isAccentName(name) ? name : 'mono'][theme];

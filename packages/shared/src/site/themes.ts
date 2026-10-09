/**
 * Thèmes du site communautaire.
 *
 * Un thème fixe une palette, des polices, des arrondis et la disposition de la
 * navigation (en-tête ou barre latérale) : la disposition ne se règle pas à
 * part, elle vient avec le thème. Le propriétaire ajuste ensuite l'accent, les
 * polices, les arrondis et le fond ; le CSS libre passe par-dessus.
 *
 * Les jetons sont exposés en variables CSS (`--site-…`) par le rendu serveur,
 * et lus tels quels par l'aperçu de l'éditeur.
 */

export type SiteNavLayout = 'top' | 'side';

export interface SiteThemeTokens {
  dark: boolean;
  navLayout: SiteNavLayout;
  /** Surfaces translucides avec flou d'arrière-plan. */
  glass: boolean;
  /** Halo coloré autour des éléments d'accent. */
  glow: boolean;
  bg: string;
  surface: string;
  surfaceStrong: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  font: SiteFont;
  headingFont: SiteFont;
  radius: number;
}

export const SITE_FONTS = [
  'Inter',
  'Space Grotesk',
  'Outfit',
  'Manrope',
  'DM Sans',
  'Poppins',
  'Nunito',
  'Merriweather',
  'Fraunces',
  'Source Serif 4',
  'JetBrains Mono',
  'Orbitron',
  'Cinzel',
  'Press Start 2P',
] as const;
export type SiteFont = (typeof SITE_FONTS)[number];

export const SITE_BACKGROUNDS = ['plain', 'gradient', 'banner'] as const;
export type SiteBackground = (typeof SITE_BACKGROUNDS)[number];

export const SITE_THEMES = {
  verre: {
    dark: true, navLayout: 'top', glass: true, glow: false,
    bg: '#0b0d12', surface: 'rgba(255,255,255,0.045)', surfaceStrong: 'rgba(255,255,255,0.08)',
    text: '#e9ebf1', muted: '#9aa2b1', border: 'rgba(255,255,255,0.09)', accent: '#7c6cff',
    font: 'Inter', headingFont: 'Space Grotesk', radius: 18,
  },
  neon: {
    dark: true, navLayout: 'top', glass: true, glow: true,
    bg: '#07070d', surface: 'rgba(22,22,40,0.72)', surfaceStrong: 'rgba(34,34,60,0.85)',
    text: '#f1f1ff', muted: '#a3a6c4', border: 'rgba(120,130,255,0.22)', accent: '#00e1ff',
    font: 'Outfit', headingFont: 'Orbitron', radius: 14,
  },
  clair: {
    dark: false, navLayout: 'top', glass: false, glow: false,
    bg: '#f6f7f9', surface: '#ffffff', surfaceStrong: '#eef0f4',
    text: '#14161b', muted: '#5a6170', border: '#e1e4ea', accent: '#5865f2',
    font: 'Inter', headingFont: 'Inter', radius: 14,
  },
  documentation: {
    dark: false, navLayout: 'side', glass: false, glow: false,
    bg: '#ffffff', surface: '#f8f9fb', surfaceStrong: '#eff1f5',
    text: '#111318', muted: '#5d6472', border: '#e5e7ec', accent: '#2563eb',
    font: 'Inter', headingFont: 'Inter', radius: 10,
  },
  nuit: {
    dark: true, navLayout: 'side', glass: false, glow: false,
    bg: '#0e1116', surface: '#151a21', surfaceStrong: '#1c232c',
    text: '#e6e9ef', muted: '#8f99a8', border: '#242c37', accent: '#22c55e',
    font: 'Inter', headingFont: 'Manrope', radius: 10,
  },
  papier: {
    dark: false, navLayout: 'top', glass: false, glow: false,
    bg: '#fbf8f3', surface: '#ffffff', surfaceStrong: '#f3eee5',
    text: '#1d1a16', muted: '#6b6257', border: '#e8e0d3', accent: '#b4530a',
    font: 'Source Serif 4', headingFont: 'Fraunces', radius: 6,
  },
  arcade: {
    dark: true, navLayout: 'top', glass: false, glow: true,
    bg: '#120b1f', surface: '#1c1230', surfaceStrong: '#281a44',
    text: '#fdf6ff', muted: '#b9a8d6', border: '#3a2763', accent: '#ff4fa3',
    font: 'DM Sans', headingFont: 'Press Start 2P', radius: 4,
  },
  royaume: {
    dark: true, navLayout: 'side', glass: false, glow: false,
    bg: '#14110d', surface: '#1d1913', surfaceStrong: '#27211a',
    text: '#efe6d6', muted: '#b0a28a', border: '#3a3126', accent: '#d4a64a',
    font: 'Merriweather', headingFont: 'Cinzel', radius: 6,
  },
} as const satisfies Record<string, SiteThemeTokens>;

export type SiteThemeKey = keyof typeof SITE_THEMES;
export const SITE_THEME_KEYS = Object.keys(SITE_THEMES) as SiteThemeKey[];
export const DEFAULT_SITE_THEME: SiteThemeKey = 'verre';

export function isSiteThemeKey(value: unknown): value is SiteThemeKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SITE_THEMES, value);
}

/** Réglages du propriétaire par-dessus le thème. Champ absent = valeur du thème. */
export interface SiteThemeSettings {
  accent?: string;
  font?: SiteFont;
  headingFont?: SiteFont;
  radius?: number;
  background?: SiteBackground;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeSiteThemeSettings(input: unknown): SiteThemeSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: SiteThemeSettings = {};
  if (typeof raw.accent === 'string' && HEX.test(raw.accent)) out.accent = raw.accent.toLowerCase();
  if (typeof raw.font === 'string' && (SITE_FONTS as readonly string[]).includes(raw.font)) out.font = raw.font as SiteFont;
  if (typeof raw.headingFont === 'string' && (SITE_FONTS as readonly string[]).includes(raw.headingFont)) out.headingFont = raw.headingFont as SiteFont;
  if (typeof raw.radius === 'number' && Number.isFinite(raw.radius)) out.radius = Math.min(28, Math.max(0, Math.round(raw.radius)));
  if (typeof raw.background === 'string' && (SITE_BACKGROUNDS as readonly string[]).includes(raw.background)) out.background = raw.background as SiteBackground;
  return out;
}

export interface ResolvedSiteTheme extends SiteThemeTokens {
  key: SiteThemeKey;
  background: SiteBackground;
  /** Couleur du texte posé sur l'accent, choisie pour le contraste. */
  onAccent: string;
}

export function resolveSiteTheme(themeKey: unknown, settings: unknown): ResolvedSiteTheme {
  const key = isSiteThemeKey(themeKey) ? themeKey : DEFAULT_SITE_THEME;
  const base: SiteThemeTokens = SITE_THEMES[key];
  const s = normalizeSiteThemeSettings(settings);
  const accent = s.accent ?? base.accent;
  return {
    ...base,
    key,
    accent,
    font: s.font ?? base.font,
    headingFont: s.headingFont ?? base.headingFont,
    radius: s.radius ?? base.radius,
    background: s.background ?? 'gradient',
    onAccent: readableOn(accent),
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Luminance relative WCAG d'une couleur `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  return 0.2126 * channel(parseInt(m[1], 16)) + 0.7152 * channel(parseInt(m[2], 16)) + 0.0722 * channel(parseInt(m[3], 16));
}

/** Noir ou blanc, selon ce qui contraste le mieux avec le fond donné. */
export function readableOn(hex: string): string {
  const l = relativeLuminance(hex);
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastBlack = (l + 0.05) / 0.05;
  return contrastBlack >= contrastWhite ? '#0b0b0f' : '#ffffff';
}

/** URL Google Fonts couvrant les deux polices du thème résolu. */
export function siteFontStylesheetUrl(theme: Pick<SiteThemeTokens, 'font' | 'headingFont'>): string {
  const families = [...new Set([theme.font, theme.headingFont])].map((family) => {
    const name = family.replace(/ /g, '+');
    // Les polices d'affichage n'existent qu'en une graisse.
    return family === 'Press Start 2P' ? `family=${name}` : `family=${name}:wght@400;500;600;700`;
  });
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}

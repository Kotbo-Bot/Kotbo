/**
 * Thèmes du site communautaire.
 *
 * Esprit des thèmes de serveurs de jeu (Azuriom et consorts) : barre de
 * navigation pleine, bannière d'accueil sur l'image du serveur, cartes sobres,
 * pied de page en colonnes. Pas d'effet verre ni de halo.
 *
 * Chaque thème porte une palette claire et une palette sombre. Le propriétaire
 * choisit le mode par défaut (clair, sombre, ou celui du système du visiteur) ;
 * le visiteur peut basculer depuis la barre du site. La disposition de la
 * navigation (barre en haut ou latérale) vient avec le thème.
 *
 * Les jetons sont exposés en variables CSS (`--site-…`) par le rendu serveur,
 * et lus tels quels par l'aperçu de l'éditeur.
 */

export type SiteNavLayout = 'top' | 'side';

export const SITE_COLOR_MODES = ['auto', 'light', 'dark'] as const;
export type SiteColorMode = (typeof SITE_COLOR_MODES)[number];

export interface SitePalette {
  bg: string;
  surface: string;
  surfaceStrong: string;
  text: string;
  muted: string;
  border: string;
  /** Barre de navigation. */
  header: string;
  headerText: string;
  /** Pied de page. */
  footer: string;
  footerText: string;
}

export interface SiteThemeTokens {
  navLayout: SiteNavLayout;
  mode: SiteColorMode;
  light: SitePalette;
  dark: SitePalette;
  accent: string;
  font: SiteFont;
  headingFont: SiteFont;
  radius: number;
}

export const SITE_FONTS = [
  'Open Sans',
  'Montserrat',
  'Rubik',
  'Lato',
  'Roboto',
  'Barlow',
  'Inter',
  'Nunito',
  'Poppins',
  'Merriweather',
  'Source Serif 4',
  'Fraunces',
  'Cinzel',
  'JetBrains Mono',
  'Press Start 2P',
  // Polices des premiers thèmes, gardées pour les réglages déjà enregistrés.
  'Space Grotesk',
  'Outfit',
  'Manrope',
  'DM Sans',
  'Orbitron',
] as const;
export type SiteFont = (typeof SITE_FONTS)[number];

export const SITE_BACKGROUNDS = ['plain', 'banner'] as const;
export type SiteBackground = (typeof SITE_BACKGROUNDS)[number];

const NEUTRAL_LIGHT: SitePalette = {
  bg: '#f3f5f8',
  surface: '#ffffff',
  surfaceStrong: '#eceff3',
  text: '#1c232c',
  muted: '#5e6875',
  border: '#dce1e7',
  header: '#ffffff',
  headerText: '#1c232c',
  footer: '#1c232c',
  footerText: '#b9c0ca',
};

const NEUTRAL_DARK: SitePalette = {
  bg: '#13171d',
  surface: '#1a1f27',
  surfaceStrong: '#232a33',
  text: '#e6e9ee',
  muted: '#98a1ad',
  border: '#2b333d',
  header: '#0f1318',
  headerText: '#e6e9ee',
  footer: '#0c0f13',
  footerText: '#8e97a3',
};

export const SITE_THEMES = {
  /** Thème de base : clair ou sombre selon le visiteur, accent bleu. */
  azur: {
    navLayout: 'top', mode: 'auto', accent: '#2f7de1', font: 'Open Sans', headingFont: 'Montserrat', radius: 8,
    light: NEUTRAL_LIGHT,
    dark: NEUTRAL_DARK,
  },
  /** Gris anthracite et orange, carré. */
  carbone: {
    navLayout: 'top', mode: 'dark', accent: '#f97316', font: 'Rubik', headingFont: 'Rubik', radius: 4,
    light: { ...NEUTRAL_LIGHT, bg: '#f2f2f2', surfaceStrong: '#e9e9e9', text: '#1d1d1d', muted: '#606060', border: '#dadada', headerText: '#1d1d1d', footer: '#1d1d1d' },
    dark: {
      bg: '#141414', surface: '#1c1c1c', surfaceStrong: '#262626', text: '#ececec', muted: '#9b9b9b', border: '#2e2e2e',
      header: '#0f0f0f', headerText: '#ececec', footer: '#0b0b0b', footerText: '#8a8a8a',
    },
  },
  /** Nuit bleutée, accent turquoise. */
  aurore: {
    navLayout: 'top', mode: 'dark', accent: '#14b8a6', font: 'Lato', headingFont: 'Montserrat', radius: 10,
    light: { ...NEUTRAL_LIGHT, bg: '#f1f6f7', surfaceStrong: '#e6eff1', border: '#d6e3e6' },
    dark: {
      bg: '#0d141d', surface: '#131c27', surfaceStrong: '#1b2633', text: '#e3ecf2', muted: '#8fa2b3', border: '#223040',
      header: '#0a1118', headerText: '#e3ecf2', footer: '#080d13', footerText: '#7f93a4',
    },
  },
  /** Compétition : rouge vif, coins nets, titres serrés. */
  braise: {
    navLayout: 'top', mode: 'dark', accent: '#e5383b', font: 'Roboto', headingFont: 'Barlow', radius: 4,
    light: { ...NEUTRAL_LIGHT, bg: '#f5f3f3', surfaceStrong: '#efeaea', border: '#e2dada' },
    dark: {
      bg: '#121012', surface: '#1b181b', surfaceStrong: '#252125', text: '#efe9ea', muted: '#a39a9c', border: '#2f292c',
      header: '#0d0b0d', headerText: '#efe9ea', footer: '#0a090a', footerText: '#928a8c',
    },
  },
  /** Survie et aventure : vert, clair par défaut. */
  foret: {
    navLayout: 'top', mode: 'light', accent: '#2f9e44', font: 'Lato', headingFont: 'Rubik', radius: 8,
    light: { ...NEUTRAL_LIGHT, bg: '#f3f6f2', surfaceStrong: '#e8eee6', text: '#1d261c', muted: '#5c6a59', border: '#d8e1d5', headerText: '#1d261c', footer: '#1d261c', footerText: '#b7c2b4' },
    dark: {
      bg: '#111611', surface: '#181f18', surfaceStrong: '#212a20', text: '#e5ece3', muted: '#94a291', border: '#283226',
      header: '#0d120d', headerText: '#e5ece3', footer: '#0a0e0a', footerText: '#8a9787',
    },
  },
  /** Jeu de rôle médiéval : or et parchemin. */
  royaume: {
    navLayout: 'top', mode: 'dark', accent: '#c9973f', font: 'Merriweather', headingFont: 'Cinzel', radius: 4,
    light: {
      bg: '#f6f1e7', surface: '#fffdf8', surfaceStrong: '#efe6d6', text: '#2a2218', muted: '#6e6150', border: '#e1d5c0',
      header: '#2a2218', headerText: '#f3ead9', footer: '#2a2218', footerText: '#cbbda5',
    },
    dark: {
      bg: '#15120e', surface: '#1e1a14', surfaceStrong: '#28221a', text: '#eee4d2', muted: '#ad9f88', border: '#382f24',
      header: '#100d0a', headerText: '#eee4d2', footer: '#0d0b08', footerText: '#9c8e78',
    },
  },
  /** Journal et études : papier, typographie à empattements. */
  papier: {
    navLayout: 'top', mode: 'light', accent: '#b4530a', font: 'Source Serif 4', headingFont: 'Fraunces', radius: 4,
    light: {
      bg: '#fbf8f3', surface: '#ffffff', surfaceStrong: '#f3eee5', text: '#1d1a16', muted: '#6b6257', border: '#e8e0d3',
      header: '#fbf8f3', headerText: '#1d1a16', footer: '#f3eee5', footerText: '#6b6257',
    },
    dark: {
      bg: '#17150f', surface: '#1f1c15', surfaceStrong: '#29251c', text: '#ece5d8', muted: '#a89d8b', border: '#363024',
      header: '#17150f', headerText: '#ece5d8', footer: '#120f0b', footerText: '#988d7b',
    },
  },
  /** Documentation : menu latéral, pensé pour un gros wiki. */
  documentation: {
    navLayout: 'side', mode: 'auto', accent: '#2563eb', font: 'Inter', headingFont: 'Inter', radius: 6,
    light: { ...NEUTRAL_LIGHT, bg: '#ffffff', surface: '#f8f9fb', surfaceStrong: '#eff1f5', border: '#e5e7ec', footer: '#f8f9fb', footerText: '#5e6875' },
    dark: { ...NEUTRAL_DARK, bg: '#0f1217', surface: '#151a21', surfaceStrong: '#1c232c', header: '#0f1217', footer: '#0f1217' },
  },
} as const satisfies Record<string, SiteThemeTokens>;

export type SiteThemeKey = keyof typeof SITE_THEMES;
export const SITE_THEME_KEYS = Object.keys(SITE_THEMES) as SiteThemeKey[];
export const DEFAULT_SITE_THEME: SiteThemeKey = 'azur';

/** Thèmes de la première version, ramenés à leur équivalent le plus proche. */
export const LEGACY_SITE_THEMES: Record<string, { key: SiteThemeKey; mode: SiteColorMode }> = {
  verre: { key: 'azur', mode: 'auto' },
  clair: { key: 'azur', mode: 'light' },
  neon: { key: 'aurore', mode: 'dark' },
  nuit: { key: 'documentation', mode: 'dark' },
  arcade: { key: 'braise', mode: 'dark' },
};

export function isSiteThemeKey(value: unknown): value is SiteThemeKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SITE_THEMES, value);
}

/** Clé de thème actuelle pour une valeur reçue (ancien nom compris), ou nulle. */
export function canonicalSiteTheme(value: unknown): SiteThemeKey | null {
  if (isSiteThemeKey(value)) return value;
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_SITE_THEMES, value)) return LEGACY_SITE_THEMES[value].key;
  return null;
}

/** Réglages du propriétaire par-dessus le thème. Champ absent = valeur du thème. */
export interface SiteThemeSettings {
  accent?: string;
  font?: SiteFont;
  headingFont?: SiteFont;
  radius?: number;
  background?: SiteBackground;
  mode?: SiteColorMode;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeSiteThemeSettings(input: unknown): SiteThemeSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: SiteThemeSettings = {};
  if (typeof raw.accent === 'string' && HEX.test(raw.accent)) out.accent = raw.accent.toLowerCase();
  if (typeof raw.font === 'string' && (SITE_FONTS as readonly string[]).includes(raw.font)) out.font = raw.font as SiteFont;
  if (typeof raw.headingFont === 'string' && (SITE_FONTS as readonly string[]).includes(raw.headingFont)) out.headingFont = raw.headingFont as SiteFont;
  if (typeof raw.radius === 'number' && Number.isFinite(raw.radius)) out.radius = Math.min(24, Math.max(0, Math.round(raw.radius)));
  if (typeof raw.background === 'string' && (SITE_BACKGROUNDS as readonly string[]).includes(raw.background)) out.background = raw.background as SiteBackground;
  if (typeof raw.mode === 'string' && (SITE_COLOR_MODES as readonly string[]).includes(raw.mode)) out.mode = raw.mode as SiteColorMode;
  return out;
}

export interface ResolvedSiteTheme extends SiteThemeTokens {
  key: SiteThemeKey;
  background: SiteBackground;
  /** Couleur du texte posé sur l'accent, choisie pour le contraste. */
  onAccent: string;
  /** Palette affichée avant tout choix du visiteur (claire si le mode suit le système). */
  initial: SitePalette;
}

export function resolveSiteTheme(themeKey: unknown, settings: unknown): ResolvedSiteTheme {
  const legacy = typeof themeKey === 'string' && !isSiteThemeKey(themeKey) ? LEGACY_SITE_THEMES[themeKey] : undefined;
  const key = canonicalSiteTheme(themeKey) ?? DEFAULT_SITE_THEME;
  const base: SiteThemeTokens = SITE_THEMES[key];
  const s = normalizeSiteThemeSettings(settings);
  const accent = s.accent ?? base.accent;
  const mode = s.mode ?? legacy?.mode ?? base.mode;
  return {
    ...base,
    key,
    mode,
    accent,
    font: s.font ?? base.font,
    headingFont: s.headingFont ?? base.headingFont,
    radius: s.radius ?? base.radius,
    background: s.background ?? 'plain',
    onAccent: readableOn(accent),
    initial: mode === 'dark' ? base.dark : base.light,
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

/** Variables CSS d'une palette, sans accolades. */
export function sitePaletteVars(p: SitePalette): string {
  return [
    `--site-bg:${p.bg}`,
    `--site-surface:${p.surface}`,
    `--site-surface-strong:${p.surfaceStrong}`,
    `--site-text:${p.text}`,
    `--site-muted:${p.muted}`,
    `--site-border:${p.border}`,
    `--site-header:${p.header}`,
    `--site-header-text:${p.headerText}`,
    `--site-footer:${p.footer}`,
    `--site-footer-text:${p.footerText}`,
  ].join(';');
}

/**
 * Feuille des couleurs : palette par défaut sur `:root`, l'autre sous
 * `[data-mode]` (choix du visiteur) et, en mode automatique, selon le système.
 */
export function siteThemeColorCss(t: ResolvedSiteTheme, root = ':root'): string {
  const light = sitePaletteVars(t.light);
  const dark = sitePaletteVars(t.dark);
  if (t.mode === 'dark') {
    return `${root}{${dark};color-scheme:dark}${root}[data-mode="light"]{${light};color-scheme:light}`;
  }
  const forced = `${root}[data-mode="dark"]{${dark};color-scheme:dark}`;
  if (t.mode === 'light') return `${root}{${light};color-scheme:light}${forced}`;
  return `${root}{${light};color-scheme:light}${forced}@media (prefers-color-scheme: dark){${root}:not([data-mode="light"]){${dark};color-scheme:dark}}`;
}

/** URL Google Fonts couvrant les deux polices du thème résolu. */
export function siteFontStylesheetUrl(theme: Pick<SiteThemeTokens, 'font' | 'headingFont'>): string {
  const families = [...new Set([theme.font, theme.headingFont])].map((family) => {
    const name = family.replace(/ /g, '+');
    // Google Fonts refuse toute la requête si une graisse demandée n'existe pas.
    if (family === 'Press Start 2P') return `family=${name}`;
    if (family === 'Lato' || family === 'Merriweather') return `family=${name}:wght@400;700`;
    return `family=${name}:wght@400;500;600;700`;
  });
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}

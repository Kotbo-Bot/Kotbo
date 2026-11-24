// ============================================================================
// HABILLAGE DES PAGES PUBLIQUES D'UN SERVEUR
// Un seul thème par serveur, appliqué à tous les classements, clans et
// giveaways publics. Même règle que les formulaires : tout ce qui sort d'ici
// est servi tel quel à des visiteurs anonymes.
// ============================================================================

import { sanitizeCustomCss, sanitizeFormTheme } from './formCustomization.js';

/** Polices embarquées dans le bundle du dashboard : aucun appel à un tiers. */
export const PUBLIC_THEME_FONTS = ['Inter', 'Outfit', 'Manrope', 'JetBrains Mono'] as const;

export const PUBLIC_THEME_BACKGROUNDS = ['plain', 'grid', 'glow'] as const;
export const PUBLIC_THEME_DENSITIES = ['comfortable', 'compact'] as const;

export type PublicTheme = {
  bannerUrl?: string;
  logoUrl?: string;
  accentColor?: string;
  backgroundColor?: string;
  cardColor?: string;
  textColor?: string;
  fontFamily?: string;
  borderRadius?: number;
  glass?: boolean;
  /** Texte d'accueil affiché sous le titre de chaque page. */
  welcomeText?: string;
  background?: (typeof PUBLIC_THEME_BACKGROUNDS)[number];
  density?: (typeof PUBLIC_THEME_DENSITIES)[number];
  /** Remplace le nom du serveur dans l'en-tête. */
  siteTitle?: string;
  customCss?: string;
};

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Ne garde que les clés connues, avec des valeurs contraintes. `null` = thème par défaut. */
export function sanitizePublicTheme(input: unknown): PublicTheme | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  // Couleurs, URLs https, rayon, verre, texte : mêmes règles que les formulaires.
  const theme: PublicTheme = { ...(sanitizeFormTheme(raw) ?? {}) };
  delete (theme as Record<string, unknown>).confirmationText;

  // La liste de polices des formulaires est plus large que ce que le dashboard embarque.
  const font = pick(raw.fontFamily, PUBLIC_THEME_FONTS);
  if (font) theme.fontFamily = font;
  else delete theme.fontFamily;

  const background = pick(raw.background, PUBLIC_THEME_BACKGROUNDS);
  if (background) theme.background = background;
  const density = pick(raw.density, PUBLIC_THEME_DENSITIES);
  if (density) theme.density = density;

  if (typeof raw.siteTitle === 'string') {
    const title = raw.siteTitle.trim().slice(0, 80);
    if (title) theme.siteTitle = title;
  }
  const css = sanitizeCustomCss(raw.customCss);
  if (css) theme.customCss = css;

  return Object.keys(theme).length > 0 ? theme : null;
}

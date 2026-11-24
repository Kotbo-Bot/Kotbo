/**
 * Habillage des pages publiques d'un serveur (classements, clans, giveaways...).
 *
 * Le thème est validé côté API (`sanitizePublicTheme`) ; ici on ne fait que le
 * traduire en variables CSS posées sur la racine de la page. Le dashboard
 * s'appuie entièrement sur des variables : redéfinir `--color-*` sur
 * `.pub-root` re-teinte donc tous les composants du sous-arbre, sans CSS par page.
 */

export const PUBLIC_FONTS = ['Inter', 'Outfit', 'Manrope', 'JetBrains Mono'] as const;
export const PUBLIC_BACKGROUNDS = ['plain', 'grid', 'glow'] as const;
export const PUBLIC_DENSITIES = ['comfortable', 'compact'] as const;

export interface PublicTheme {
  bannerUrl?: string;
  logoUrl?: string;
  accentColor?: string;
  backgroundColor?: string;
  cardColor?: string;
  textColor?: string;
  fontFamily?: string;
  borderRadius?: number;
  glass?: boolean;
  welcomeText?: string;
  background?: (typeof PUBLIC_BACKGROUNDS)[number];
  density?: (typeof PUBLIC_DENSITIES)[number];
  siteTitle?: string;
  customCss?: string;
}

/** Texte lisible posé sur une couleur d'accent : blanc ou presque noir selon la luminance. */
export function readableOn(color: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(color.trim())?.[1];
  if (!hex) return '#ffffff'; // shortcut: rgb()/hsl() non analysés, blanc par défaut.
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.6 ? '#09090b' : '#ffffff';
}

/** Variables CSS du thème, à poser en `style` sur la racine `.pub-root`. */
export function publicThemeStyle(theme: PublicTheme | null | undefined): string {
  if (!theme) return '';
  const v: string[] = [];
  const set = (names: string[], value: string) => names.forEach((n) => v.push(`${n}:${value}`));

  if (theme.accentColor) {
    set(['--color-primary', '--primary-color'], theme.accentColor);
    set(['--color-on-primary', '--on-primary-color'], readableOn(theme.accentColor));
    set(['--color-primary-container'], `color-mix(in srgb, ${theme.accentColor} 18%, var(--color-surface))`);
    set(['--color-on-primary-container'], theme.accentColor);
  }
  if (theme.backgroundColor) set(['--color-surface', '--color-background'], theme.backgroundColor);
  if (theme.cardColor) {
    set(['--color-surface-container-lowest', '--color-surface-container-low'], theme.cardColor);
    set(['--color-surface-container'], `color-mix(in srgb, ${theme.cardColor} 90%, var(--color-on-surface))`);
    set(['--color-surface-container-high'], `color-mix(in srgb, ${theme.cardColor} 82%, var(--color-on-surface))`);
  }
  if (theme.textColor) {
    set(['--color-on-surface', '--color-on-background'], theme.textColor);
    set(['--color-on-surface-variant'], `color-mix(in srgb, ${theme.textColor} 62%, var(--color-surface))`);
  }
  if (theme.borderRadius !== undefined) v.push(`--pub-radius:${theme.borderRadius}px`);
  if (theme.fontFamily) v.push(`--pub-font:'${theme.fontFamily}', system-ui, sans-serif`);
  return v.join(';');
}

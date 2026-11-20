import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, Path2D, type SKRSContext2D } from '@napi-rs/canvas';
import { logger } from '../../utils/logger.js';

// ============================================================================
// CARTES D'APERÇU OPEN GRAPH
//
// Une vignette carree de 512 px par lien partageable, affichee en miniature a
// cote du texte de l'embed : elle ne repete pas le titre en grand, elle donne
// l'identite (icone du serveur ou logo), le type de page et une donnee cle.
//
// Elle reprend les cartes du dashboard (cf. apps/dashboard/src/app.css) :
// surfaces zinc, filet, indigo, Outfit pour les titres et Inter pour le texte,
// sans halo, degrade ni trame.
//
// Deux regles structurent ce module :
//
//  1. **Rendu deterministe.** Une meme carte rend toujours les memes octets, ce
//     qui rend l'ETag stable et evite que les CDN gardent deux versions.
//  2. **Aucune donnee privee.** Une carte est servie sans authentification :
//     ce qui n'est pas deja public sur la page ne doit pas y figurer. Les
//     ressources protegees (transcriptions, preuves) n'y laissent que leur nature.
// ============================================================================

/** Vignette carree : Discord l'affiche en miniature a cote du texte, pas en banniere. */
export const OG_CARD_SIZE = 512;
const W = OG_CARD_SIZE;
const H = OG_CARD_SIZE;

/** Theme sombre du dashboard, recopie de apps/dashboard/src/app.css. */
const UI = {
  background: '#09090b',
  card: '#18181b',
  cardRaised: '#27272a',
  border: '#27272a',
  borderStrong: '#3f3f46',
  text: '#fafafa',
  textSecondary: '#d4d4d8',
  textMuted: '#a1a1aa',
  textFaint: '#71717a',
} as const;

/**
 * Version du dessin des cartes, portee par l'URL de l'image et par l'ETag.
 * Les URL et ETag ne dependent sinon que des donnees : apres un changement de
 * dessin, le proxy d'images de Discord et les CDN garderaient l'ancienne carte.
 * A incrementer a chaque changement visible du rendu.
 */
export const OG_CARD_VERSION = 6;

/** Indigo du dashboard en theme sombre : accent par defaut des cartes et barre de l'embed. */
export const OG_ACCENT = '#818cf8';

export interface OgPodiumEntry {
  rank?: number;
  name: string;
  score: string;
  highlight?: boolean;
}

/** Bandeau d'illustration a droite de la carte. */
export type OgCardArt =
  | { type: 'none' }
  /** Silhouette de conversation, contenu masque : ressource protegee. */
  | { type: 'redactedChat'; rows?: number }
  /** Apercu des intitules de questions d'un formulaire public. */
  | { type: 'questions'; items: string[]; more?: number }
  /** Compte a rebours d'un giveaway. */
  | { type: 'countdown'; label: string; value: string; ended?: boolean }
  /** Podium d'un classement ou position d'un membre par rapport au classement. */
  | { type: 'podium'; label?: string; entries: OgPodiumEntry[] }
  /** Menu du dashboard : la page ouverte, surlignee parmi ses voisines, et un bouton. */
  | { type: 'sections'; label: string; items: string[]; active: number; cta: string };

export interface OgCardSpec {
  /** Cle de cache et graine du PRNG : doit identifier la carte de facon stable. */
  cacheKey: string;
  /** Pastille au-dessus du titre (type de ressource). */
  kicker: string;
  title: string;
  subtitle?: string;
  /** Nom du serveur, affiche dans l'en-tete avec son icone. */
  guildName?: string;
  guildIconUrl?: string;
  /** Couleur d'accent (#rrggbb). Par defaut : l'indigo du dashboard. */
  accent?: string;
  /** Jusqu'a trois tuiles de chiffres cles. */
  stats?: { value: string; label: string }[];
  /** Pastilles d'etat (« Ouvert », « Connexion requise »...). */
  badges?: string[];
  art?: OgCardArt;
  /** Mention en bas a droite (date, statut...). */
  footerRight?: string;
}

// ---------------------------------------------------------------------------
// Polices
//
// Une famille par graisse : @napi-rs/canvas choisit mal entre plusieurs
// graisses enregistrees sous un meme nom. DejaVu Sans reste en repli pour les
// caracteres hors du sous-ensemble latin (cf. assets/og-fonts/NOTICE.md).
// ---------------------------------------------------------------------------
const FONT_DIR = fileURLToPath(new URL('../../../assets/og-fonts/', import.meta.url));
const FONTS = {
  title: ['outfit-latin-700-normal.woff2', 'Kotbo OG Outfit'],
  text: ['inter-latin-400-normal.woff2', 'Kotbo OG Inter'],
  medium: ['inter-latin-500-normal.woff2', 'Kotbo OG Inter Medium'],
  semibold: ['inter-latin-600-normal.woff2', 'Kotbo OG Inter SemiBold'],
} as const;
type FontRole = keyof typeof FONTS;

let fontsReady = false;

function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  (GlobalFonts as { loadSystemFonts?: () => void }).loadSystemFonts?.();
  for (const [file, family] of Object.values(FONTS)) {
    try {
      GlobalFonts.registerFromPath(`${FONT_DIR}${file}`, family);
    } catch (err) {
      logger.warn('OpenGraph', `Police ${file} illisible`, err);
    }
  }
}

function font(size: number, role: FontRole): string {
  return `${size}px "${FONTS[role][1]}", "DejaVu Sans", Arial, sans-serif`;
}

// ---------------------------------------------------------------------------
// Cache memoire
//
// Les CDN des reseaux sociaux rechargent une meme carte en rafale (une requete
// par client qui affiche l'embed). Un LRU de quelques dizaines d'entrees suffit
// a absorber ces rafales ; au-dela, l'en-tete Cache-Control fait le travail.
// Redis n'est volontairement pas utilise : ces PNG pesent ~150 Ko piece et
// n'ont aucun interet a survivre au process.
// ---------------------------------------------------------------------------
const MAX_CACHED_CARDS = 64;
const cardCache = new Map<string, Buffer>();

function readCache(key: string): Buffer | null {
  const hit = cardCache.get(key);
  if (!hit) return null;
  // Reinsertion = eviction approximativement LRU, comme dans utils/cache.ts.
  cardCache.delete(key);
  cardCache.set(key, hit);
  return hit;
}

function writeCache(key: string, value: Buffer): void {
  cardCache.delete(key);
  cardCache.set(key, value);
  while (cardCache.size > MAX_CACHED_CARDS) {
    const oldest = cardCache.keys().next().value as string | undefined;
    if (!oldest) break;
    cardCache.delete(oldest);
  }
}

/** Vide le cache des cartes devenues obsoletes (formulaire renomme, giveaway clos...). */
export function invalidateOgCard(cacheKeyPrefix: string): void {
  for (const key of [...cardCache.keys()]) {
    if (key.startsWith(cacheKeyPrefix)) cardCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Utilitaires de rendu
// ---------------------------------------------------------------------------

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill?: string | CanvasGradient,
  stroke?: string,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Tronque un texte a la largeur disponible, avec la police deja posee sur le contexte. */
function fitText(ctx: SKRSContext2D, value: string, maxWidth: number): string {
  let text = value.replace(/\s+/g, ' ').trim();
  if (ctx.measureText(text).width <= maxWidth) return text;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

/** Decoupe un texte en lignes tenant dans `maxWidth`, au plus `maxLines`. */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && current) lines.push(current);

  // Le texte tronque doit rester lisible : on ellipse caractere par caractere
  // plutot que de laisser la derniere ligne deborder du cadre.
  if (lines.length === maxLines && lines.join(' ').length < normalized.length) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}…`;
  }

  return lines;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized.slice(0, 6);
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int)) return [129, 140, 248];
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Accent lisible sur le fond sombre.
 *
 * L'accent d'un formulaire est choisi par le serveur pour son propre theme : un
 * bleu nuit ou un noir y sont legitimes mais disparaitraient ici. On le melange
 * au blanc jusqu'a ce qu'il se detache, sans changer sa teinte.
 */
function readableAccent(hex: string): string {
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  let rgb = hexToRgb(hex);
  for (let i = 0; i < 6 && luminance(rgb) < 0.2; i++) {
    rgb = rgb.map((c) => Math.round(c + (255 - c) * 0.3)) as [number, number, number];
  }
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Normalise une couleur venue de la base vers un `#rrggbb` sur lequel on peut compter. */
export function normalizeAccent(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase();
  }
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]]
      .map((c) => Math.min(255, Number.parseInt(c, 10)).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return fallback;
}

// Le « K » du logo (motion/src/ui.tsx sur la landing), dans son repere 160 x 160.
const LOGO_GLYPH = [
  'M72 60 h0 a7 7 0 0 1 7 7 v66 a7 7 0 0 1 -14 0 v-66 a7 7 0 0 1 7 -7 Z',
  'M79 85 C 95 85, 120 70, 120 70 C 120 70, 125 80, 110 95 C 100 105, 79 110, 79 110 Z',
  'M79 115 C 95 115, 125 130, 125 130 C 125 130, 120 145, 105 140 C 95 135, 79 125, 79 125 Z',
];

function drawLogo(ctx: SKRSContext2D, x: number, y: number, size: number) {
  const scale = size / 160;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  roundRect(ctx, 0, 0, 160, 160, 40, '#00264d');
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.7)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.translate(-20, -20);
  ctx.fillStyle = '#ffffff';
  for (const d of LOGO_GLYPH) ctx.fill(new Path2D(d));
  ctx.beginPath();
  ctx.arc(135, 100, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

async function drawGuildAvatar(
  ctx: SKRSContext2D,
  url: string | undefined,
  x: number,
  y: number,
  size: number,
  fallbackName: string,
) {
  ctx.save();
  roundRect(ctx, x, y, size, size, size * 0.28);
  ctx.clip();

  let drawn = false;
  if (url) {
    try {
      const img = await loadImage(url);
      ctx.drawImage(img, x, y, size, size);
      drawn = true;
    } catch {
      // Icone indisponible (serveur sans avatar, CDN en erreur) : on retombe
      // sur l'initiale plutot que de laisser un trou dans la carte.
    }
  }

  if (!drawn) {
    ctx.fillStyle = UI.cardRaised;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = UI.textSecondary;
    ctx.font = font(Math.round(size * 0.45), 'semibold');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((fallbackName.trim()[0] ?? 'K').toUpperCase(), x + size / 2, y + size / 2 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

// Vignette carree : une carte du dashboard (surface zinc, filet, coins larges),
// pas une affiche. Pastille du type, titre, puis UNE donnee qui dit pourquoi on
// clique, dans une tuile comme celles de l'accueil.
const PAD = 40;
const CARD_INSET = 14;
const TILE_H = 104;

/** Pastille teintee de l'accent, comme les badges du dashboard ; renvoie sa largeur. */
function drawPill(ctx: SKRSContext2D, label: string, x: number, y: number, accent: string, maxWidth: number): number {
  ctx.font = font(20, 'semibold');
  const text = fitText(ctx, label, maxWidth - 32);
  const width = ctx.measureText(text).width + 32;
  roundRect(ctx, x, y, width, 40, 20, hexToRgba(accent, 0.16), hexToRgba(accent, 0.4));
  ctx.fillStyle = accent;
  ctx.fillText(text, x + 16, y + 27);
  return width;
}

/**
 * La donnee unique de la vignette. Aucune n'est inventee : elle vient de la
 * specification, deja limitee a ce qui est public sur la page.
 */
function keyFigure(spec: OgCardSpec): { label: string; value: string } | null {
  if (spec.stats?.length) return spec.stats[0];
  const art = spec.art;
  switch (art?.type) {
    case 'countdown':
      return { label: art.label, value: art.value };
    case 'podium': {
      const top = art.entries.find((entry) => entry.highlight) ?? art.entries[0];
      return top ? { label: `#${top.rank ?? 1} ${top.name}`, value: top.score } : null;
    }
    case 'questions':
      return { label: 'Questions', value: String(art.items.length + (art.more ?? 0)) };
    default:
      return null;
  }
}

export async function renderOgCard(spec: OgCardSpec): Promise<Buffer> {
  const cached = readCache(spec.cacheKey);
  if (cached) return cached;

  ensureFonts();
  const accent = readableAccent(normalizeAccent(spec.accent, OG_ACCENT));
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = UI.background;
  ctx.fillRect(0, 0, W, H);
  roundRect(ctx, CARD_INSET, CARD_INSET, W - CARD_INSET * 2, H - CARD_INSET * 2, 36, UI.card, UI.border);

  // Identite : l'icone du serveur quand la page est la sienne, le logo sinon.
  const top = CARD_INSET + 28;
  if (spec.guildName) await drawGuildAvatar(ctx, spec.guildIconUrl, PAD, top, 64, spec.guildName);
  else drawLogo(ctx, PAD, top, 64);
  drawPill(ctx, spec.kicker, PAD + 80, top + 12, accent, W - PAD * 2 - 80);

  // Titre : au plus trois lignes, la vignette n'a pas la place d'un paragraphe.
  ctx.fillStyle = UI.text;
  ctx.font = font(46, 'title');
  const lines = wrapText(ctx, spec.title, W - PAD * 2, 3);
  let y = top + 64 + 62;
  for (const line of lines) {
    ctx.fillText(line, PAD, y);
    y += 54;
  }

  // Bas de carte : la donnee cle, sinon les pastilles d'etat.
  const figure = keyFigure(spec);
  const bottom = H - CARD_INSET - 28;
  if (figure) {
    const tileY = bottom - TILE_H;
    roundRect(ctx, PAD, tileY, W - PAD * 2, TILE_H, 20, UI.cardRaised, UI.borderStrong);
    ctx.fillStyle = UI.textMuted;
    ctx.font = font(19, 'medium');
    ctx.fillText(fitText(ctx, figure.label, W - PAD * 2 - 44), PAD + 22, tileY + 36);
    ctx.fillStyle = accent;
    ctx.font = font(40, 'title');
    ctx.fillText(fitText(ctx, figure.value, W - PAD * 2 - 44), PAD + 22, tileY + 82);
  } else if (spec.badges?.length) {
    let x = PAD;
    for (const badge of spec.badges.slice(0, 2)) {
      ctx.font = font(19, 'semibold');
      const text = fitText(ctx, badge, W - PAD * 2 - 32);
      const w = ctx.measureText(text).width + 32;
      if (x + w > W - PAD) break;
      roundRect(ctx, x, bottom - 40, w, 40, 20, UI.cardRaised, UI.borderStrong);
      ctx.fillStyle = UI.textSecondary;
      ctx.fillText(text, x + 16, bottom - 13);
      x += w + 10;
    }
  }

  const buffer = canvas.toBuffer('image/png');
  writeCache(spec.cacheKey, buffer);
  return buffer;
}

/** Rendu tolerant aux pannes : un embed sans image vaut mieux qu'une 500. */
export async function tryRenderOgCard(spec: OgCardSpec): Promise<Buffer | null> {
  try {
    return await renderOgCard(spec);
  } catch (err) {
    logger.error('OpenGraph', `Rendu de carte impossible pour ${spec.cacheKey}`, err);
    return null;
  }
}

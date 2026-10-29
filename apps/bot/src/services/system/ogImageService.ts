import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, Path2D, type SKRSContext2D } from '@napi-rs/canvas';
import { logger } from '../../utils/logger.js';

// ============================================================================
// CARTES D'APERÇU OPEN GRAPH
//
// Une image 1200x630 par lien partageable. Discord, Slack, Twitter et consorts
// affichent cette image dans l'embed : c'est le seul rendu visuel qu'un lien
// Kotbo obtient hors du dashboard, il doit donc raconter la page a lui seul.
//
// La carte reprend le theme sombre du dashboard (cf. apps/dashboard/src/app.css) :
// surfaces zinc, indigo, Outfit pour les titres et Inter pour le texte, sans
// halo ni libelle en capitales. Un lien partage doit ressembler a la page sur
// laquelle il ouvre.
//
// Deux regles structurent ce module :
//
//  1. **Rendu deterministe.** Les seules variations (largeur des bulles d'une
//     conversation caviardee) sont tirees d'un PRNG seede par l'identifiant de
//     la carte. Une meme URL rend donc toujours les memes octets, ce qui rend
//     l'ETag stable et evite que les CDN des reseaux sociaux gardent deux
//     versions d'une meme carte.
//  2. **Aucune donnee privee.** Une carte est servie sans authentification :
//     ce qui n'est pas deja public sur la page ne doit pas y figurer. Les
//     ressources protegees (transcriptions, preuves) sont rendues
//     « caviardees » - la forme d'une conversation, jamais son contenu.
// ============================================================================

const W = 1200;
const H = 630;

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
export const OG_CARD_VERSION = 5;

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

/** PRNG mulberry32 seede par une chaine : rendu identique d'un appel a l'autre. */
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

// Grille de la carte : en-tete sur un filet, colonne de texte a gauche,
// illustration a droite, tuiles et illustration alignees en bas.
const PAD = 72;
const HEADER_LINE = 124;
const ART_X = 704;
const ART_W = W - PAD - ART_X;
const ART_TOP = 160;
const ART_H = H - 56 - ART_TOP;
const STAT_H = 108;
/** Les tuiles finissent a la meme hauteur que l'illustration, a 56 px du bas. */
const STATS_TOP = H - 56 - STAT_H;

/** Pastille arrondie ; renvoie sa largeur. */
function drawPill(
  ctx: SKRSContext2D,
  label: string,
  x: number,
  y: number,
  colors: { fill: string; stroke?: string; text: string },
): number {
  ctx.font = font(19, 'semibold');
  const text = truncate(label, 32);
  const width = ctx.measureText(text).width + 32;
  roundRect(ctx, x, y, width, 38, 19, colors.fill, colors.stroke);
  ctx.fillStyle = colors.text;
  ctx.fillText(text, x + 16, y + 26);
  return width;
}

/** Tuile de chiffre cle, comme les tuiles de l'accueil du dashboard. */
function drawStat(ctx: SKRSContext2D, x: number, y: number, w: number, value: string, label: string) {
  roundRect(ctx, x, y, w, STAT_H, 16, UI.card, UI.border);
  ctx.fillStyle = UI.textMuted;
  ctx.font = font(18, 'medium');
  ctx.fillText(fitText(ctx, label, w - 44), x + 22, y + 38);
  ctx.fillStyle = UI.text;
  ctx.font = font(40, 'title');
  ctx.fillText(fitText(ctx, value, w - 44), x + 22, y + 84);
}

// ---------------------------------------------------------------------------
// Panneaux d'illustration
// ---------------------------------------------------------------------------

/** Panneau « verre » : fond translucide, contour et halo de la couleur de la page. */
function drawPanel(ctx: SKRSContext2D, accent: string, top = ART_TOP, height = ART_H) {
  ctx.save();
  ctx.shadowColor = hexToRgba(accent, 0.45);
  ctx.shadowBlur = 48;
  roundRect(ctx, ART_X, top, ART_W, height, 24, 'rgba(24, 24, 27, 0.82)');
  ctx.restore();
  roundRect(ctx, ART_X, top, ART_W, height, 24, undefined, hexToRgba(accent, 0.55));
}

/** Fond : degrade teinte de l'accent, halos de lumiere et trame de points. */
function drawBackground(ctx: SKRSContext2D, accent: string) {
  const base = ctx.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, '#12122a');
  base.addColorStop(0.55, '#0b0b14');
  base.addColorStop(1, '#09090b');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  const glow = (x: number, y: number, r: number, color: string, alpha: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexToRgba(color, alpha));
    g.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(W - 120, 120, 620, accent, 0.5);
  glow(120, H - 40, 520, '#00e5ff', 0.22);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  for (let x = 24; x < W; x += 32) {
    for (let y = 24; y < H; y += 32) ctx.fillRect(x, y, 2, 2);
  }
}

function drawPanelLabel(ctx: SKRSContext2D, label: string, top = ART_TOP) {
  ctx.fillStyle = UI.textMuted;
  ctx.font = font(18, 'semibold');
  ctx.fillText(label, ART_X + 28, top + 44);
}

/**
 * Silhouette de conversation caviardee.
 *
 * Les transcriptions ne sont lisibles qu'apres authentification : leur carte
 * d'apercu, elle, est servie a qui possede le lien. On dessine donc la *forme*
 * d'un echange - bulles de largeurs variables, avatars anonymes - sans jamais
 * lire le HTML de la transcription. Le cadenas dit explicitement au lecteur
 * pourquoi il ne voit rien.
 */
function drawRedactedChat(ctx: SKRSContext2D, rand: () => number, accent: string, rows: number) {
  drawPanel(ctx, accent);

  let y = ART_TOP + 48;
  for (let i = 0; i < rows; i++) {
    const mine = rand() > 0.6;
    const avatarX = mine ? ART_X + ART_W - 40 : ART_X + 40;
    ctx.beginPath();
    ctx.arc(avatarX, y, 14, 0, Math.PI * 2);
    ctx.fillStyle = mine ? hexToRgba(accent, 0.35) : UI.borderStrong;
    ctx.fill();

    const bubbleW = 140 + rand() * 150;
    const bubbleX = mine ? avatarX - 26 - bubbleW : avatarX + 26;
    roundRect(ctx, bubbleX, y - 18, bubbleW, 36, 12, mine ? hexToRgba(accent, 0.16) : UI.cardRaised);

    // Deux barres de « texte » par bulle : la longueur varie, le contenu non.
    roundRect(ctx, bubbleX + 14, y - 9, (bubbleW - 28) * (0.6 + rand() * 0.35), 7, 3, 'rgba(250, 250, 250, 0.18)');
    roundRect(ctx, bubbleX + 14, y + 3, (bubbleW - 28) * (0.35 + rand() * 0.4), 7, 3, 'rgba(250, 250, 250, 0.1)');

    y += 54;
    if (y > ART_TOP + ART_H - 60) break;
  }

  // Voile + cadenas : l'illustration doit se lire comme « verrouille ».
  const veil = ctx.createLinearGradient(0, ART_TOP + ART_H * 0.35, 0, ART_TOP + ART_H);
  veil.addColorStop(0, 'rgba(24, 24, 27, 0)');
  veil.addColorStop(1, 'rgba(24, 24, 27, 0.95)');
  roundRect(ctx, ART_X, ART_TOP, ART_W, ART_H, 20, veil);

  const lockY = ART_TOP + ART_H - 62;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(ART_X + ART_W / 2, lockY - 12, 11, Math.PI, 0);
  ctx.stroke();
  roundRect(ctx, ART_X + ART_W / 2 - 17, lockY - 12, 34, 26, 6, accent);
}

/** Trois intitules de questions : ce que le visiteur devra reellement remplir. */
function drawQuestions(ctx: SKRSContext2D, accent: string, items: string[], more: number) {
  drawPanel(ctx, accent);
  drawPanelLabel(ctx, 'Au programme');

  let y = ART_TOP + 96;
  items.slice(0, 3).forEach((item, index) => {
    roundRect(ctx, ART_X + 28, y - 23, 32, 32, 9, hexToRgba(accent, 0.16));
    ctx.fillStyle = accent;
    ctx.font = font(17, 'semibold');
    ctx.textAlign = 'center';
    ctx.fillText(String(index + 1), ART_X + 44, y - 1);
    ctx.textAlign = 'left';

    ctx.fillStyle = UI.text;
    ctx.font = font(20, 'text');
    const lines = wrapText(ctx, item, ART_W - 104, 2);
    lines.forEach((line, lineIndex) => ctx.fillText(line, ART_X + 76, y + lineIndex * 28));
    y += 34 + lines.length * 28;
  });

  if (more > 0) {
    ctx.fillStyle = UI.textMuted;
    ctx.font = font(18, 'text');
    const label = `+ ${more} autre${more > 1 ? 's' : ''} question${more > 1 ? 's' : ''}`;
    ctx.fillText(label, ART_X + 28, Math.min(y + 6, ART_TOP + ART_H - 28));
  }
}

/** Grand compteur : le temps restant est l'information utile d'un giveaway. */
function drawCountdown(ctx: SKRSContext2D, accent: string, label: string, value: string, ended: boolean) {
  const color = ended ? UI.textMuted : accent;
  drawPanel(ctx, accent);

  const center = ART_X + ART_W / 2;
  const middle = ART_TOP + ART_H / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = UI.textMuted;
  ctx.font = font(20, 'semibold');
  ctx.fillText(truncate(label, 28), center, middle - 72);

  ctx.fillStyle = color;
  ctx.font = font(value.length > 8 ? 56 : 76, 'title');
  ctx.fillText(fitText(ctx, value, ART_W - 56), center, middle + 28);

  ctx.fillStyle = UI.textSecondary;
  ctx.font = font(19, 'text');
  ctx.fillText(ended ? 'Tirage terminé' : 'Avant le tirage', center, middle + 80);
  ctx.textAlign = 'left';
}

/** Podium ou extrait cible d'un classement (jusqu'a 4 lignes, rang reel et ligne mise en avant). */
function drawPodium(ctx: SKRSContext2D, accent: string, entries: OgPodiumEntry[], label = 'Podium') {
  drawPanel(ctx, accent);

  if (entries.length === 0) {
    ctx.fillStyle = UI.textMuted;
    ctx.font = font(20, 'text');
    ctx.fillText('Classement en construction', ART_X + 40, ART_TOP + ART_H / 2);
    return;
  }

  drawPanelLabel(ctx, label);
  const medals: Record<number, string> = { 1: '#facc15', 2: '#d4d4d8', 3: '#d97706' };
  const visible = entries.slice(0, 4);
  const compact = visible.length > 3;
  const rowH = compact ? 58 : 64;
  const stepY = compact ? 74 : 84;
  let y = ART_TOP + (compact ? 106 : 118);

  visible.forEach((entry, index) => {
    const rank = entry.rank ?? index + 1;
    const highlighted = Boolean(entry.highlight);
    const rowFill = highlighted
      ? hexToRgba(accent, 0.2)
      : index === 0 && !visible.some((e) => e.highlight)
        ? UI.cardRaised
        : undefined;
    const rowStroke = highlighted ? accent : undefined;
    roundRect(ctx, ART_X + 20, y - 38, ART_W - 40, rowH, 14, rowFill, rowStroke);

    const medalColor = medals[rank];
    ctx.beginPath();
    ctx.arc(ART_X + 56, y - (compact ? 9 : 6), 17, 0, Math.PI * 2);
    ctx.fillStyle = medalColor ?? (highlighted ? accent : UI.borderStrong);
    ctx.fill();
    ctx.fillStyle = medalColor || highlighted ? '#18181b' : UI.textSecondary;
    ctx.font = font(rank >= 100 ? 13 : 16, 'semibold');
    ctx.textAlign = 'center';
    ctx.fillText(String(rank), ART_X + 56, y - (compact ? 3 : 0));
    ctx.textAlign = 'left';

    ctx.fillStyle = highlighted ? UI.text : accent;
    ctx.font = font(18, 'medium');
    ctx.textAlign = 'right';
    const score = truncate(entry.score, 20);
    ctx.fillText(score, ART_X + ART_W - 36, y - (compact ? 2 : -1));
    const scoreWidth = ctx.measureText(score).width;
    ctx.textAlign = 'left';

    ctx.fillStyle = UI.text;
    ctx.font = font(compact ? 20 : 22, 'semibold');
    ctx.fillText(fitText(ctx, entry.name, ART_W - 146 - scoreWidth), ART_X + 88, y - (compact ? 2 : -1));

    y += stepY;
  });
}

/**
 * Grille « bento » des pages d'une famille : la page du lien en grande tuile
 * coloree, ses voisines en tuiles de verre. Ne depend que des libelles de
 * sections, jamais d'une donnee de serveur.
 */
function drawSections(ctx: SKRSContext2D, accent: string, label: string, items: string[], active: number) {
  const gap = 16;
  const tileW = (ART_W - gap) / 2;
  const heroH = 178;
  const smallH = (ART_H - heroH - gap * 2) / 2;

  // Grande tuile : degrade de l'accent, halo, nom de la famille puis de la page.
  ctx.save();
  ctx.shadowColor = hexToRgba(accent, 0.55);
  ctx.shadowBlur = 40;
  const hero = ctx.createLinearGradient(ART_X, ART_TOP, ART_X + ART_W, ART_TOP + heroH);
  hero.addColorStop(0, accent);
  hero.addColorStop(1, hexToRgba(accent, 0.55));
  roundRect(ctx, ART_X, ART_TOP, ART_W, heroH, 26, hero);
  ctx.restore();
  ctx.fillStyle = 'rgba(9, 9, 11, 0.7)';
  ctx.font = font(19, 'semibold');
  ctx.fillText(truncate(label, 30), ART_X + 28, ART_TOP + 46);
  ctx.fillStyle = UI.background;
  ctx.font = font(40, 'title');
  ctx.fillText(fitText(ctx, items[active] ?? label, ART_W - 56), ART_X + 28, ART_TOP + heroH - 38);

  // Tuiles voisines, en grille 2 x 2.
  const others = items.filter((_, index) => index !== active).slice(0, 4);
  others.forEach((item, index) => {
    const x = ART_X + (index % 2) * (tileW + gap);
    const y = ART_TOP + heroH + gap + Math.floor(index / 2) * (smallH + gap);
    roundRect(ctx, x, y, tileW, smallH, 22, 'rgba(24, 24, 27, 0.8)', hexToRgba(accent, 0.4));
    ctx.beginPath();
    ctx.arc(x + 28, y + 22, 6, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.fillStyle = UI.text;
    ctx.font = font(20, 'semibold');
    const lines = wrapText(ctx, item, tileW - 48, 2);
    lines.forEach((line, i) => ctx.fillText(line, x + 24, y + smallH - 22 - (lines.length - 1 - i) * 25));
  });
}

/** Gros bouton de la colonne de texte : dit ou mene le lien (l'image entiere est cliquable). */
function drawCta(ctx: SKRSContext2D, accent: string, label: string) {
  ctx.font = font(24, 'semibold');
  const w = ctx.measureText(label).width + 96;
  const y = H - 56 - 68;
  ctx.save();
  ctx.shadowColor = hexToRgba(accent, 0.55);
  ctx.shadowBlur = 36;
  roundRect(ctx, PAD, y, w, 68, 34, accent);
  ctx.restore();
  ctx.fillStyle = UI.background;
  ctx.fillText(label, PAD + 36, y + 44);
  ctx.font = font(30, 'semibold');
  ctx.fillText('→', PAD + w - 52, y + 45);
}

// ---------------------------------------------------------------------------
// Rendu principal
// ---------------------------------------------------------------------------

/**
 * En-tete facon barre du dashboard : le logo, puis le serveur comme dans le
 * selecteur de serveur (« Kotbo / Atelier Nova »), sur un filet pleine largeur.
 */
async function drawHeader(ctx: SKRSContext2D, spec: OgCardSpec) {
  ctx.fillStyle = UI.textFaint;
  ctx.font = font(20, 'medium');
  ctx.textAlign = 'right';
  ctx.fillText('kotbo.fr', W - PAD, 81);
  ctx.textAlign = 'left';
  const siteWidth = ctx.measureText('kotbo.fr').width;

  drawLogo(ctx, PAD, 48, 48);
  ctx.fillStyle = UI.text;
  ctx.font = font(30, 'title');
  ctx.fillText('Kotbo', PAD + 64, 83);
  let cursor = PAD + 64 + ctx.measureText('Kotbo').width;

  if (spec.guildName) {
    ctx.fillStyle = UI.borderStrong;
    ctx.font = font(30, 'text');
    ctx.fillText('/', cursor + 18, 83);
    cursor += 18 + ctx.measureText('/').width + 18;

    await drawGuildAvatar(ctx, spec.guildIconUrl, cursor, 52, 40, spec.guildName);
    ctx.fillStyle = UI.textSecondary;
    ctx.font = font(24, 'semibold');
    ctx.fillText(fitText(ctx, spec.guildName, W - PAD - siteWidth - 40 - cursor - 54), cursor + 54, 81);
  }

  ctx.fillStyle = UI.border;
  ctx.fillRect(0, HEADER_LINE, W, 1.5);
}

export async function renderOgCard(spec: OgCardSpec): Promise<Buffer> {
  const cached = readCache(spec.cacheKey);
  if (cached) return cached;

  ensureFonts();
  const rand = seededRandom(spec.cacheKey);
  const accent = readableAccent(normalizeAccent(spec.accent, OG_ACCENT));
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, accent);

  await drawHeader(ctx, spec);

  const hasArt = Boolean(spec.art && spec.art.type !== 'none');
  const textWidth = hasArt ? ART_X - PAD - 48 : W - PAD * 2;

  // Pastille du type de ressource, teintee de l'accent, puis les pastilles
  // d'etat sur la meme ligne : la colonne garde sa hauteur pour le titre.
  let pillX = PAD + drawPill(ctx, spec.kicker, PAD, ART_TOP, { fill: accent, text: UI.background }) + 10;
  for (const badge of spec.badges?.slice(0, 2) ?? []) {
    pillX += drawPill(ctx, badge, pillX, ART_TOP, { fill: UI.card, stroke: UI.borderStrong, text: UI.textSecondary }) + 10;
  }

  // Titre.
  ctx.fillStyle = UI.text;
  const bento = spec.art?.type === 'sections';
  ctx.font = font(bento ? 70 : 58, 'title');
  const titleLines = wrapText(ctx, spec.title, textWidth, 2);
  let cursorY = ART_TOP + 38 + 70;
  for (const line of titleLines) {
    ctx.fillText(line, PAD, cursorY);
    cursorY += bento ? 78 : 66;
  }

  // Sous-titre. Avec un titre sur deux lignes, les tuiles de chiffres ne
  // laissent la place qu'a une ligne.
  const hasStats = Boolean(spec.stats?.length);
  if (spec.subtitle) {
    ctx.fillStyle = UI.textMuted;
    ctx.font = font(25, 'text');
    const maxLines = hasStats && titleLines.length > 1 ? 1 : 2;
    for (const line of wrapText(ctx, spec.subtitle, textWidth, maxLines)) {
      ctx.fillText(line, PAD, cursorY + 6);
      cursorY += 36;
    }
  }

  // Tuiles de chiffres cles, posees en bas de la colonne de texte.
  if (hasStats) {
    const stats = spec.stats!.slice(0, 3);
    const gap = 16;
    const tileW = hasArt ? Math.floor((textWidth - gap * (stats.length - 1)) / stats.length) : 220;
    stats.forEach((stat, index) => drawStat(ctx, PAD + index * (tileW + gap), STATS_TOP, tileW, stat.value, stat.label));
  }

  // Illustration.
  switch (spec.art?.type) {
    case 'redactedChat':
      drawRedactedChat(ctx, rand, accent, spec.art.rows ?? 6);
      break;
    case 'questions':
      drawQuestions(ctx, accent, spec.art.items, spec.art.more ?? 0);
      break;
    case 'countdown':
      drawCountdown(ctx, accent, spec.art.label, spec.art.value, spec.art.ended ?? false);
      break;
    case 'podium':
      drawPodium(ctx, accent, spec.art.entries, spec.art.label);
      break;
    case 'sections':
      drawSections(ctx, accent, spec.art.label, spec.art.items, spec.art.active);
      drawCta(ctx, accent, spec.art.cta);
      break;
    default:
      break;
  }

  // Mention en bas a droite, dans la marge sous l'illustration.
  if (spec.footerRight) {
    ctx.fillStyle = UI.textFaint;
    ctx.font = font(18, 'medium');
    ctx.textAlign = 'right';
    ctx.fillText(truncate(spec.footerRight, 60), W - PAD, H - 22);
    ctx.textAlign = 'left';
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

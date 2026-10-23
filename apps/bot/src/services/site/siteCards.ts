/**
 * Cartes partageables du site : images 1200 × 630 qui s'affichent quand un
 * lien du site est collé sur Discord, X, WhatsApp…
 *
 *   /s/<slug>/og.png              carte du serveur (nom, accroche, membres en ligne)
 *   /s/<slug>/u/<membre>/card.png carte d'un membre (niveau, rang, messages, vocal)
 *
 * Une carte de membre n'existe que si son profil public existe (membre
 * présent, profil non masqué) : elle ne dit rien de plus que la page profil.
 *
 * Les images distantes ne viennent que du CDN de Discord ou des images du
 * site lues sur le disque : une bannière saisie à la main ne fait jamais
 * partir de requête du serveur vers une adresse quelconque.
 */

import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { logger } from '../../utils/logger.js';
import { readSiteAsset } from './siteUploads.js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const FONT_DIR = fileURLToPath(new URL('../../../assets/rank-fonts/', import.meta.url));
const TITLE_FONT = 'Kotbo Card Title';
const TEXT_FONT = 'Kotbo Card Text';
let fontsReady = false;

function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  for (const [file, family] of [['poppins.ttf', TITLE_FONT], ['lato.ttf', TEXT_FONT]] as const) {
    try {
      GlobalFonts.registerFromPath(`${FONT_DIR}${file}`, family);
    } catch (err) {
      logger.warn('SiteCards', `Police ${file} illisible :`, err);
    }
  }
}

const font = (size: number, family: 'title' | 'text', weight: 'normal' | 'bold' = 'normal') =>
  `${weight === 'bold' ? 'bold ' : ''}${size}px "${family === 'title' ? TITLE_FONT : TEXT_FONT}", "DejaVu Sans", Arial, sans-serif`;

const COLORS = { bg: '#101216', text: '#f4f5f7', muted: '#a3aab6', online: '#22c55e' };

// ─── Images ─────────────────────────────────────────────────────────────────

const DISCORD_CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//;
const SITE_ASSET = /^\/s\/_\/a\/([a-z0-9]{20,32})\.(webp|gif|png|jpg|avif)$/;

/** Image chargée depuis une source sûre, ou nulle. Jamais d'erreur : la carte se dessine sans. */
export async function loadCardImage(url: string | null | undefined): Promise<Image | null> {
  if (!url) return null;
  try {
    const local = SITE_ASSET.exec(url);
    if (local) {
      const asset = await readSiteAsset(local[1], local[2]);
      return asset ? await loadImage(asset.body) : null;
    }
    if (!DISCORD_CDN.test(url)) return null;
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 8_000_000 ? null : await loadImage(bytes);
  } catch {
    return null;
  }
}

// ─── Dessin ─────────────────────────────────────────────────────────────────

/** Image qui couvre la zone, recadrée au centre. */
function drawCover(ctx: SKRSContext2D, image: Image, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

function drawCircleImage(ctx: SKRSContext2D, image: Image | null, cx: number, cy: number, r: number, fallback: string, accent: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (image) {
    drawCover(ctx, image, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = accent;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(Math.round(r * 0.9), 'title', 'bold');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fallback.slice(0, 1).toUpperCase() || '?', cx, cy + r * 0.05);
  }
  ctx.restore();
}

function ring(ctx: SKRSContext2D, cx: number, cy: number, r: number, color: string, width: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Texte ramené à la largeur donnée, avec points de suspension. */
export function fitText(ctx: Pick<SKRSContext2D, 'measureText'>, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Jusqu'à `maxLines` lignes coupées sur les mots ; la dernière se termine par « … » si besoin. */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) lines[maxLines - 1] = fitText(ctx, `${lines[maxLines - 1]} …`, maxWidth);
  return lines.slice(0, maxLines).map((l) => fitText(ctx, l, maxWidth));
}

function background(ctx: SKRSContext2D, banner: Image | null, accent: string, overlay: number): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  if (banner) {
    drawCover(ctx, banner, 0, 0, CARD_WIDTH, CARD_HEIGHT);
    ctx.fillStyle = `rgba(16, 18, 22, ${overlay})`;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  }
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 12, CARD_HEIGHT);
}

function footer(ctx: SKRSContext2D, url: string, cta: string, accent: string, onAccent: string): void {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(26, 'text');
  ctx.fillText(fitText(ctx, url, 640), 72, 578);
  ctx.font = font(26, 'title', 'bold');
  const label = fitText(ctx, cta, 380);
  const w = ctx.measureText(label).width + 48;
  const x = CARD_WIDTH - 72 - w;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(x, 536, w, 58, 12);
  ctx.fill();
  ctx.fillStyle = onAccent;
  ctx.fillText(label, x + 24, 575);
}

// ─── Cartes ─────────────────────────────────────────────────────────────────

export interface ServerCardInput {
  name: string;
  tagline: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  accent: string;
  onAccent: string;
  /** « 1 234 membres », « 312 en ligne » : déjà formatés dans la langue du visiteur. */
  membersLabel: string | null;
  onlineLabel: string | null;
  url: string;
  cta: string;
}

export async function renderServerCard(input: ServerCardInput): Promise<Buffer> {
  ensureFonts();
  const [icon, banner] = await Promise.all([loadCardImage(input.iconUrl), loadCardImage(input.bannerUrl)]);
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');
  background(ctx, banner, input.accent, 0.74);

  drawCircleImage(ctx, icon, 147, 170, 75, input.name, input.accent);
  ring(ctx, 147, 170, 78, 'rgba(255,255,255,0.9)', 5);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.text;
  ctx.font = font(76, 'title', 'bold');
  ctx.fillText(fitText(ctx, input.name, 1050), 72, 335);

  let y = 335;
  if (input.tagline) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(32, 'text');
    for (const line of wrapText(ctx, input.tagline, 1050, 2)) {
      y += 46;
      ctx.fillText(line, 72, y);
    }
  }

  let x = 72;
  const statsY = Math.max(y + 70, 455);
  ctx.font = font(30, 'title', 'bold');
  if (input.onlineLabel) {
    ctx.fillStyle = COLORS.online;
    ctx.beginPath();
    ctx.arc(x + 9, statsY - 10, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(input.onlineLabel, x + 30, statsY);
    x += 30 + ctx.measureText(input.onlineLabel).width + 40;
  }
  if (input.membersLabel) {
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(input.membersLabel, x, statsY);
  }

  footer(ctx, input.url, input.cta, input.accent, input.onAccent);
  return canvas.toBuffer('image/png');
}

export interface MemberCardInput {
  serverName: string;
  serverIconUrl: string | null;
  bannerUrl: string | null;
  accent: string;
  onAccent: string;
  displayName: string;
  avatarUrl: string | null;
  /** « @pseudo · membre depuis mars 2024 ». */
  meta: string;
  /** Jusqu'à quatre chiffres, déjà formatés : `{ value: '34', label: 'Niveau' }`. */
  stats: Array<{ value: string; label: string }>;
  url: string;
  cta: string;
}

export async function renderMemberCard(input: MemberCardInput): Promise<Buffer> {
  ensureFonts();
  const [serverIcon, banner, avatarImage] = await Promise.all([loadCardImage(input.serverIconUrl), loadCardImage(input.bannerUrl), loadCardImage(input.avatarUrl)]);
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');
  background(ctx, banner, input.accent, 0.84);

  // Serveur, en haut à gauche.
  drawCircleImage(ctx, serverIcon, 94, 70, 22, input.serverName, input.accent);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(26, 'text');
  ctx.fillText(fitText(ctx, input.serverName, 900), 128, 72);

  // Avatar du membre, cerclé de la couleur du site.
  drawCircleImage(ctx, avatarImage, 190, 300, 110, input.displayName, input.accent);
  ring(ctx, 190, 300, 116, input.accent, 8);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.text;
  ctx.font = font(64, 'title', 'bold');
  ctx.fillText(fitText(ctx, input.displayName, 790), 350, 262);
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(28, 'text');
  ctx.fillText(fitText(ctx, input.meta, 790), 350, 308);

  const stats = input.stats.slice(0, 4);
  const colWidth = stats.length ? Math.min(220, 790 / stats.length) : 0;
  stats.forEach((stat, i) => {
    const x = 350 + i * colWidth;
    ctx.fillStyle = COLORS.text;
    ctx.font = font(48, 'title', 'bold');
    ctx.fillText(fitText(ctx, stat.value, colWidth - 20), x, 404);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(22, 'text');
    ctx.fillText(fitText(ctx, stat.label, colWidth - 20), x, 440);
  });

  footer(ctx, input.url, input.cta, input.accent, input.onAccent);
  return canvas.toBuffer('image/png');
}

// ─── Cache ──────────────────────────────────────────────────────────────────

const CARD_TTL_MS = 10 * 60_000;
const CARD_CACHE_MAX = 300;
const cardCache = new Map<string, { at: number; png: Buffer }>();
const inFlight = new Map<string, Promise<Buffer>>();

/** Carte servie depuis le cache mémoire (dix minutes), dessinée une seule fois en cas de rafale. */
export async function cachedCard(key: string, draw: () => Promise<Buffer>): Promise<Buffer> {
  const hit = cardCache.get(key);
  if (hit && Date.now() - hit.at < CARD_TTL_MS) return hit.png;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = draw()
    .then((png) => {
      if (cardCache.size >= CARD_CACHE_MAX) {
        const oldest = cardCache.keys().next().value;
        if (oldest !== undefined) cardCache.delete(oldest);
      }
      cardCache.set(key, { at: Date.now(), png });
      return png;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * Visuels générés depuis le serveur Discord : fonds de section prêts à
 * l'emploi quand le serveur n'a pas d'images à lui. Couleur d'accent du site,
 * icône et bannière du serveur recomposées en quatre fonds 1600 × 900.
 *
 * Chaque visuel est rangé dans les images du site (déduplication par
 * empreinte : régénérer les mêmes ne coûte rien). Les images distantes ne
 * viennent que du CDN de Discord, comme pour les cartes partageables.
 */

import type { Guild } from 'discord.js';
import { createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { resolveSiteTheme } from '@kotbo/shared';
import { logger } from '../../utils/logger.js';
import { storeSiteAsset } from './siteUploads.js';

const WIDTH = 1600;
const HEIGHT = 900;

export type SiteVisualKind = 'banner' | 'glow' | 'mesh' | 'pattern' | 'blur';

export interface SiteVisual {
  kind: SiteVisualKind;
  url: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#5865f2';
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

const rgba = ([r, g, b]: [number, number, number], alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

/** Teinte voisine, pour qu'un fond à une seule couleur ne soit pas plat. */
function shiftHue([r, g, b]: [number, number, number], degrees: number): [number, number, number] {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const m = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(m[0] * r + m[1] * g + m[2] * b), clamp(m[3] * r + m[4] * g + m[5] * b), clamp(m[6] * r + m[7] * g + m[8] * b)];
}

function blob(ctx: SKRSContext2D, x: number, y: number, radius: number, color: [number, number, number], alpha: number) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, rgba(color, alpha));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

/** Couleur moyenne d'une image : l'image réduite à un pixel. */
function averageColor(image: Image): [number, number, number] {
  const canvas = createCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function drawGlow(ctx: SKRSContext2D, accent: [number, number, number], second: [number, number, number]) {
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  blob(ctx, WIDTH * 0.2, HEIGHT * 0.25, WIDTH * 0.6, accent, 0.75);
  blob(ctx, WIDTH * 0.85, HEIGHT * 0.8, WIDTH * 0.55, second, 0.6);
}

function drawMesh(ctx: SKRSContext2D, accent: [number, number, number], second: [number, number, number]) {
  const base = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  base.addColorStop(0, rgba(accent, 1));
  base.addColorStop(1, rgba(shiftHue(accent, 40).map((c) => c * 0.35) as [number, number, number], 1));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  blob(ctx, WIDTH * 0.75, HEIGHT * 0.2, WIDTH * 0.5, second, 0.7);
  blob(ctx, WIDTH * 0.15, HEIGHT * 0.9, WIDTH * 0.45, shiftHue(accent, -50), 0.6);
  blob(ctx, WIDTH * 0.5, HEIGHT * 0.5, WIDTH * 0.35, [255, 255, 255], 0.08);
}

function drawPattern(ctx: SKRSContext2D, accent: [number, number, number], icon: Image) {
  const base = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  base.addColorStop(0, rgba(accent, 1));
  base.addColorStop(1, rgba(accent.map((c) => c * 0.4) as [number, number, number], 1));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const size = 110;
  const gap = 70;
  ctx.globalAlpha = 0.12;
  for (let row = 0, y = -size / 2; y < HEIGHT + size; row += 1, y += size + gap / 2) {
    // Rangées décalées d'une demi-case : un motif, pas une grille.
    for (let x = row % 2 ? -(size + gap) / 2 : 0; x < WIDTH + size; x += size + gap) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(icon, x, y, size, size);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

/** Icône étalée sur tout le fond et floutée : réduite à quelques pixels puis agrandie en lissant. */
function drawBlur(ctx: SKRSContext2D, icon: Image) {
  const tiny = createCanvas(16, 9);
  tiny.getContext('2d').drawImage(icon, 0, icon.height * 0.2, icon.width, icon.height * 0.6, 0, 0, 16, 9);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tiny, 0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

async function render(draw: (ctx: SKRSContext2D) => void): Promise<Uint8Array> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  draw(canvas.getContext('2d'));
  return new Uint8Array(await canvas.encode('png'));
}

/**
 * Génère et range les visuels du serveur. La bannière Discord, quand il y en
 * a une, est proposée telle quelle (image du CDN de Discord, en HTTPS).
 */
export async function generateSiteVisuals(
  guild: Guild | undefined,
  site: { id: string; guildId: string; theme: string; themeSettings: unknown },
  userId: string,
): Promise<SiteVisual[]> {
  const accent = hexToRgb(resolveSiteTheme(site.theme, site.themeSettings).accent);
  const iconUrl = guild?.iconURL({ extension: 'png', size: 512 });
  const icon = iconUrl ? await loadImage(iconUrl).catch(() => null) : null;
  const second = icon ? averageColor(icon) : shiftHue(accent, 60);

  const jobs: Array<[SiteVisualKind, (ctx: SKRSContext2D) => void]> = [
    ['glow', (ctx) => drawGlow(ctx, accent, second)],
    ['mesh', (ctx) => drawMesh(ctx, accent, second)],
  ];
  if (icon) {
    jobs.push(['pattern', (ctx) => drawPattern(ctx, accent, icon)]);
    jobs.push(['blur', (ctx) => drawBlur(ctx, icon)]);
  }

  const visuals: SiteVisual[] = [];
  const banner = guild?.bannerURL({ extension: 'png', size: 2048 });
  if (banner) visuals.push({ kind: 'banner', url: banner });
  for (const [kind, draw] of jobs) {
    try {
      const stored = await storeSiteAsset(site, { bytes: await render(draw), fileName: `visuel-${kind}.png`, uploadedById: userId });
      if (stored.ok) visuals.push({ kind, url: stored.asset.url });
    } catch (err) {
      logger.warn('SiteVisuals', `Visuel ${kind} impossible pour ${site.guildId} :`, err);
    }
  }
  return visuals;
}

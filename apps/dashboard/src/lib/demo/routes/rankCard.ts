/**
 * La carte `/rank` de la personne connectée, préférence et aperçu.
 *
 * Côté bot, l'aperçu est une image rendue par `renderRankCard`
 * (`services/progression/levelingService.ts`) avec les décors de
 * `rankCardDecor.ts`. La démo n'a pas de serveur pour la dessiner : le même
 * tracé est rejoué ici sur un canvas du navigateur, mêmes positions, mêmes
 * catalogues (`@kotbo/shared`). Toute retouche du rendu côté bot se reporte ici.
 */
import {
  DEFAULT_LEVEL_CURVE,
  DEFAULT_RANK_CARD_CUSTOMIZATION,
  RANK_CARD_BADGE_ICONS,
  RANK_CARD_HEIGHT,
  RANK_CARD_TIER_COLORS,
  RANK_CARD_WIDTH,
  getRankCardAchievement,
  getRankCardBackground,
  getRankCardFont,
  levelFromXp,
  normalizeRankCardCustomization,
  rankCardEmojiCodePoint,
  rankCardFontStack,
  xpForLevel,
  type RankCardAchievementTier,
  type RankCardBadgeIconId,
  type RankCardCustomization,
} from '@kotbo/shared';
import { route } from '../backend';
import { demoDb } from '../db';
import { DAY, ME, MEMBERS, ago } from '../fixtures';

const RANK_CARD = 'rank-card';

/** Succès de la personne de démo : de quoi essayer titres, badges et décors réservés. */
const UNLOCKED = [
  { id: 'supporter_1', unlockedAt: ago(80 * DAY) },
  { id: 'gift_giver', unlockedAt: ago(45 * DAY) },
  { id: 'reputation_50', unlockedAt: ago(20 * DAY) },
  { id: 'starboard_10', unlockedAt: ago(9 * DAY) },
  { id: 'tester', unlockedAt: ago(120 * DAY), grantedByStaff: true },
];

const METRICS = {
  staff: 0,
  supporterMonths: 3,
  giftsOffered: 1,
  maxLevel: levelFromXp(ME.xp, DEFAULT_LEVEL_CURVE),
  firstPlaces: 0,
  reputation: 57,
  starboard: 12,
  questsClaimed: 31,
  referrals: 0,
  manual: 0,
};

const unlockedIds = () => new Set(UNLOCKED.map((entry) => entry.id));

function current(): RankCardCustomization {
  return normalizeRankCardCustomization(demoDb.get(RANK_CARD, () => DEFAULT_RANK_CARD_CUSTOMIZATION), unlockedIds());
}

// ── Rendu ──────────────────────────────────────────────────────────────

const LABELS = {
  fr: {
    level: (level: number) => `Niveau ${level}`,
    rank: (rank: number) => `${rank}${rank === 1 ? 'er' : 'e'} du serveur`,
    remaining: (xp: string, next: number) => `Encore ${xp} XP pour le niveau ${next}`,
    numberLocale: 'fr-FR',
  },
  en: {
    level: (level: number) => `Level ${level}`,
    rank: (rank: number) => `#${rank} on this server`,
    remaining: (xp: string, next: number) => `${xp} XP to level ${next}`,
    numberLocale: 'en-US',
  },
};

const GOLD = ['#fde68a', '#f59e0b', '#b45309'];
const PRISM = ['#f472b6', '#facc15', '#34d399', '#22d3ee', '#a78bfa', '#f472b6'];
const ASSETS = import.meta.env.BASE_URL ?? '/';

type Ctx = CanvasRenderingContext2D;

function gradient(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, colors: string[]): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  colors.forEach((color, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), color));
  return g;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const images = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string): Promise<HTMLImageElement | null> {
  let pending = images.get(url);
  if (!pending) {
    pending = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    images.set(url, pending);
  }
  return pending;
}

function disc(ctx: Ctx, cx: number, cy: number, r: number, fill: string | CanvasGradient): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawPattern(ctx: Ctx, patternId: string, W: number, H: number): void {
  if (patternId === 'none') return;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 22);
  ctx.clip();
  ctx.lineWidth = 1;
  if (patternId === 'grid') {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.beginPath();
    for (let x = 28; x < W; x += 28) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = 28; y < H; y += 28) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();
  } else if (patternId === 'dots') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    for (let row = 0, y = 11; y < H; row++, y += 22) {
      for (let x = row % 2 ? 22 : 11; x < W; x += 22) { ctx.beginPath(); ctx.arc(x, y, 1.3, 0, Math.PI * 2); ctx.fill(); }
    }
  } else if (patternId === 'diagonal') {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.beginPath();
    for (let x = -H; x < W; x += 16) { ctx.moveTo(x, 0); ctx.lineTo(x + H, H); }
    ctx.stroke();
  } else if (patternId === 'hexagons') {
    const radius = 20, stepX = Math.sqrt(3) * radius, stepY = 1.5 * radius;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.beginPath();
    for (let row = 0; row * stepY < H + radius; row++) {
      for (let col = -1; col * stepX < W + stepX; col++) {
        const cx = col * stepX + (row % 2 ? stepX / 2 : 0), cy = row * stepY;
        for (let side = 0; side <= 6; side++) {
          const a = Math.PI / 6 + (side * Math.PI) / 3;
          if (side === 0) ctx.moveTo(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
          else ctx.lineTo(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
        }
      }
    }
    ctx.stroke();
  } else if (patternId === 'stars') {
    const random = seededRandom(7);
    for (let i = 0; i < 110; i++) {
      ctx.fillStyle = `rgba(255, 255, 255, ${(0.08 + random() * 0.27).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(random() * W, random() * H, 0.6 + random() * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    for (let group = 0; group < 4; group++) {
      const ox = (group + 0.5) * (W / 4) + (random() - 0.5) * 80, oy = 40 + random() * (H - 80);
      const points = Array.from({ length: 4 }, () => [ox + (random() - 0.5) * 120, oy + (random() - 0.5) * 90]);
      ctx.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
      for (const [x, y] of points) { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill(); }
    }
  } else if (patternId === 'circuit') {
    const random = seededRandom(23);
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
    for (let y = 18; y < H; y += 34) {
      for (let x = 10; x < W; x += 60) {
        if (random() < 0.45) continue;
        const run = 18 + random() * 26, bend = (random() < 0.5 ? -1 : 1) * (8 + random() * 10);
        const endX = x + run + Math.abs(bend), endY = y + bend;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + run, y); ctx.lineTo(endX, endY); ctx.stroke();
        for (const [px, py] of [[x, y], [endX, endY]]) { ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill(); }
      }
    }
  }
  ctx.restore();
}

type Frame = { cx: number; cy: number; radius: number; accentStart: string; accentEnd: string; backdrop: string };

function drawFrameBase(ctx: Ctx, frameId: string, f: Frame): void {
  const { cx, cy, radius, accentStart, accentEnd, backdrop } = f;
  const accent = gradient(ctx, cx - radius, cy - radius, cx + radius, cy + radius, [accentStart, accentEnd]);
  switch (frameId) {
    case 'double':
      ctx.save(); ctx.globalAlpha = 0.55; ctx.lineWidth = 2; ctx.strokeStyle = accent;
      ctx.beginPath(); ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      disc(ctx, cx, cy, radius + 4, accent);
      break;
    case 'dashed': {
      const segments = 18, span = ((Math.PI * 2) / segments) * 0.62;
      ctx.save(); ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.strokeStyle = accent;
      for (let i = 0; i < segments; i++) {
        const start = (i * Math.PI * 2) / segments - Math.PI / 2;
        ctx.beginPath(); ctx.arc(cx, cy, radius + 5, start, start + span); ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'glow':
      ctx.save(); ctx.shadowColor = accentEnd; ctx.shadowBlur = 26; disc(ctx, cx, cy, radius + 4, accent); ctx.restore();
      break;
    case 'laurel':
      disc(ctx, cx, cy, radius + 4, gradient(ctx, cx, cy - radius, cx, cy + radius, GOLD));
      break;
    case 'radar':
      ctx.save(); ctx.strokeStyle = accent; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5;
      for (const offset of [11, 18]) { ctx.beginPath(); ctx.arc(cx, cy, radius + offset, 0, Math.PI * 2); ctx.stroke(); }
      ctx.globalAlpha = 1; ctx.lineWidth = 3; ctx.lineCap = 'round';
      for (let q = 0; q < 4; q++) {
        const a = (q * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (radius + 7), cy + Math.sin(a) * (radius + 7));
        ctx.lineTo(cx + Math.cos(a) * (radius + 21), cy + Math.sin(a) * (radius + 21));
        ctx.stroke();
      }
      ctx.restore();
      disc(ctx, cx, cy, radius + 4, accent);
      break;
    case 'prism': {
      const conic = ctx.createConicGradient(0, cx, cy);
      PRISM.forEach((color, i) => conic.addColorStop(i / (PRISM.length - 1), color));
      disc(ctx, cx, cy, radius + 6, conic);
      break;
    }
    default:
      disc(ctx, cx, cy, radius + 4, accent);
  }
  disc(ctx, cx, cy, radius + 1, backdrop);
}

function drawFrameOverlay(ctx: Ctx, frameId: string, f: Frame): void {
  const { cx, cy, radius, backdrop } = f;
  if (frameId === 'laurel') {
    const leaf = radius + 14, tilt = 0.45;
    ctx.save();
    ctx.fillStyle = gradient(ctx, cx, cy - leaf, cx, cy + leaf, GOLD);
    ctx.strokeStyle = backdrop;
    ctx.lineWidth = 1.5;
    for (let deg = 120; deg <= 240; deg += 20) {
      const left = (deg * Math.PI) / 180, right = Math.PI - left;
      for (const [a, rot] of [[left, left + Math.PI / 2 + tilt], [right, right + Math.PI / 2 - tilt]]) {
        ctx.beginPath(); ctx.ellipse(cx + leaf * Math.cos(a), cy + leaf * Math.sin(a), 8, 3.4, rot, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  } else if (frameId === 'crown') {
    const scale = 40 / 24;
    ctx.save();
    ctx.translate(cx - 12 * scale, cy - radius + 8 - 22 * scale);
    ctx.scale(scale, scale);
    const path = new Path2D(RANK_CARD_BADGE_ICONS.crown);
    ctx.lineJoin = 'round'; ctx.lineWidth = 3 / scale; ctx.strokeStyle = backdrop; ctx.stroke(path);
    ctx.fillStyle = gradient(ctx, 0, 5, 0, 22, GOLD); ctx.fill(path, 'evenodd');
    ctx.restore();
  }
}

function drawBar(ctx: Ctx, styleId: string, x: number, y: number, w: number, h: number, progress: number, a: string, b: string): void {
  const track = 'rgba(255, 255, 255, 0.06)';
  if (styleId === 'segmented') {
    const segments = 24, gap = 4, sw = (w - gap * (segments - 1)) / segments, filled = Math.round(progress * segments);
    const fill = gradient(ctx, x, 0, x + w, 0, [a, b]);
    for (let i = 0; i < segments; i++) {
      ctx.beginPath(); ctx.roundRect(x + i * (sw + gap), y, sw, h, 4); ctx.fillStyle = i < filled ? fill : track; ctx.fill();
    }
    return;
  }
  ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fillStyle = track; ctx.fill();
  if (progress <= 0) return;
  const fw = Math.max(h, w * progress);
  ctx.beginPath(); ctx.roundRect(x, y, fw, h, h / 2); ctx.fillStyle = gradient(ctx, x, 0, x + fw, 0, [a, b]); ctx.fill();
  if (styleId === 'striped') {
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, fw, h, h / 2); ctx.clip();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    for (let s = x - h; s < x + fw; s += 14) {
      ctx.beginPath(); ctx.moveTo(s, y + h); ctx.lineTo(s + h, y); ctx.lineTo(s + h + 7, y); ctx.lineTo(s + 7, y + h); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
}

const tierText = (tier: RankCardAchievementTier) => RANK_CARD_TIER_COLORS[tier][0];

async function drawBadges(ctx: Ctx, badges: string[], startX: number, cy: number): Promise<void> {
  const R = 15;
  let cx = startX + R;
  for (const id of badges) {
    const achievement = getRankCardAchievement(id);
    if (!achievement) continue;
    const colors = RANK_CARD_TIER_COLORS[achievement.tier];
    const image = achievement.image ? await loadImage(`${ASSETS}rank-badges/${achievement.image}.png`) : null;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = gradient(ctx, cx - R, cy - R, cx + R, cy + R, colors); ctx.stroke();
    const size = R * (image ? 1.35 : 1.2);
    if (image) {
      ctx.drawImage(image, cx - size / 2, cy - size / 2, size, size);
    } else {
      const scale = size / 24;
      ctx.translate(cx - size / 2, cy - size / 2);
      ctx.scale(scale, scale);
      ctx.fillStyle = gradient(ctx, 0, 0, 24, 24, colors);
      ctx.fill(new Path2D(RANK_CARD_BADGE_ICONS[achievement.icon as RankCardBadgeIconId]), 'evenodd');
    }
    ctx.restore();
    cx += R * 2 + 10;
  }
}

function fit(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  const chars = [...text];
  while (chars.length > 1) {
    chars.pop();
    const candidate = `${chars.join('')}…`;
    if (ctx.measureText(candidate).width <= max) return candidate;
  }
  return '…';
}

async function renderPreview(custom: RankCardCustomization, locale: 'fr' | 'en'): Promise<Blob | null> {
  const W = RANK_CARD_WIDTH, H = RANK_CARD_HEIGHT;
  const labels = LABELS[locale];
  const preset = getRankCardBackground(custom.backgroundId);
  const accentStart = preset.accentBar[0].color;
  const accentEnd = preset.accentBar[preset.accentBar.length - 1].color;
  const font = getRankCardFont(custom.fontId);
  const fontStack = rankCardFontStack(font);
  if (font.family) await document.fonts.load(`bold 30px "${font.family}"`).catch(() => undefined);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  for (const stop of preset.gradient) bg.addColorStop(stop.offset, stop.color);
  ctx.beginPath(); ctx.roundRect(0, 0, W, H, 16); ctx.fillStyle = bg; ctx.fill();
  drawPattern(ctx, custom.patternId, W, H);

  // La démo n'a pas d'avatar Discord : le disque prend la couleur d'accent, comme `/rank` quand l'avatar ne charge pas.
  const frame: Frame = { cx: 115, cy: 130, radius: 62, accentStart, accentEnd, backdrop: preset.avatarBackdrop };
  drawFrameBase(ctx, custom.frameId, frame);
  disc(ctx, frame.cx, frame.cy, frame.radius, accentStart);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 54px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ME.displayName.charAt(0).toUpperCase(), frame.cx, frame.cy + 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  drawFrameOverlay(ctx, custom.frameId, frame);
  disc(ctx, frame.cx + 45, frame.cy + 45, 14, preset.avatarBackdrop);
  disc(ctx, frame.cx + 45, frame.cy + 45, 10, '#3ba55d');

  const xp = ME.xp;
  const level = levelFromXp(xp, DEFAULT_LEVEL_CURVE);
  const rank = [...MEMBERS].sort((a, b) => b.xp - a.xp).findIndex((p) => p.id === ME.id) + 1;
  const rightX = W - 45;
  const levelText = labels.level(level);
  const rankText = labels.rank(rank);
  ctx.font = 'bold 26px sans-serif';
  const levelW = ctx.measureText(levelText).width;
  ctx.font = '16px sans-serif';
  const rankW = ctx.measureText(rankText).width;
  const rightLeft = rightX - Math.max(levelW, rankW);

  const nameX = 210;
  const identityMaxW = rightLeft - nameX - 24;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 30px ${fontStack}`;
  ctx.fillText(fit(ctx, ME.displayName, identityMaxW), nameX, 80);

  const title = custom.titleId ? getRankCardAchievement(custom.titleId) : null;
  const tag = title ? title.title[locale] : `@${ME.username}`;
  ctx.fillStyle = title ? tierText(title.tier) : '#8b949e';
  ctx.font = title ? 'bold 17px sans-serif' : '17px sans-serif';
  const emojiBand = custom.emojis.length ? 16 + custom.emojis.length * 26 + (custom.emojis.length - 1) * 8 : 0;
  const fittedTag = fit(ctx, tag, identityMaxW - emojiBand);
  ctx.fillText(fittedTag, nameX, 106);
  let emojiX = nameX + ctx.measureText(fittedTag).width + 16;
  for (const emoji of custom.emojis) {
    const codePoint = rankCardEmojiCodePoint(emoji);
    const image = codePoint ? await loadImage(`${ASSETS}rank-emojis/${codePoint}.png`) : null;
    if (!image) continue;
    ctx.drawImage(image, emojiX, 99 - 13, 26, 26);
    emojiX += 34;
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText(levelText, rightX, 76);
  ctx.fillStyle = '#8b949e';
  ctx.font = '16px sans-serif';
  ctx.fillText(rankText, rightX, 104);

  const prev = xpForLevel(level - 1, DEFAULT_LEVEL_CURVE);
  const next = xpForLevel(level, DEFAULT_LEVEL_CURVE);
  const span = Math.max(1, next - prev);
  const inLevel = Math.min(Math.max(0, xp - prev), span);
  ctx.font = '14px sans-serif';
  ctx.fillText(`${inLevel.toLocaleString(labels.numberLocale)} / ${span.toLocaleString(labels.numberLocale)} XP`, rightX, 155);
  ctx.textAlign = 'left';

  await drawBadges(ctx, custom.badges, nameX, 140);
  drawBar(ctx, custom.barStyleId, nameX, 175, W - nameX - 45, 22, Math.min(1, inLevel / span), accentStart, accentEnd);

  const remaining = next - xp;
  if (remaining > 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '14px sans-serif';
    ctx.fillText(labels.remaining(remaining.toLocaleString(labels.numberLocale), level + 1), nameX, 175 + 22 + 30);
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function registerRankCardRoutes(): void {
  route('GET', '/api/user/rank-card', () => ({
    customization: current(),
    achievements: { unlocked: UNLOCKED, metrics: METRICS },
  }));

  route('PUT', '/api/user/rank-card', ({ body }) => ({
    customization: demoDb.set(RANK_CARD, normalizeRankCardCustomization(body, unlockedIds())),
  }));

  route('POST', '/api/user/rank-card/preview', async ({ body }) => {
    const blob = await renderPreview(normalizeRankCardCustomization(body, unlockedIds()), body?.locale === 'en' ? 'en' : 'fr');
    if (!blob) return new Response(null, { status: 500 });
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'X-Rank-Card-Preview': 'real' },
    });
  });
}

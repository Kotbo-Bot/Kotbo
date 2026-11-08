/**
 * Calibration des seuils Kotbo Vision : mesure la distance entre une image et ses
 * rediffusions typiques (recompression, bordure, recadrage, miroir, texte
 * ajouté), et entre images sans rapport. Les seuils de imageForensics.ts
 * doivent séparer les deux populations.
 *
 *   bun run scripts/calibrate-vision.ts
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { analyzeImage, compareFingerprints, compareWindows, computeWindowHashes, hammingDistance, windowShapesFor } from '../src/services/moderation/imageForensics.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Image « capture d'arnaque » : fond, bandeau, cartes, texte, logo. */
function makeScene(seed: number, template = false): Buffer {
  const r = rng(seed);
  const canvas = createCanvas(720, 900);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 720, 900);
  g.addColorStop(0, `hsl(${template ? 220 : r() * 360}, 60%, ${20 + r() * 30}%)`);
  g.addColorStop(1, `hsl(${template ? 260 : r() * 360}, 60%, ${20 + r() * 40}%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 720, 900);
  ctx.fillStyle = `hsl(${r() * 360}, 70%, 55%)`;
  ctx.fillRect(0, 0, 720, 90 + r() * 60);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `hsla(${r() * 360}, 60%, ${40 + r() * 40}%, 0.9)`;
    ctx.fillRect(r() * 600, 150 + r() * 650, 80 + r() * 300, 40 + r() * 200);
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText(`BONUS ${Math.floor(r() * 9000)}$`, 40 + r() * 100, 260 + r() * 400);
  ctx.font = '28px sans-serif';
  for (let i = 0; i < 8; i++) ctx.fillText(`withdrawal ${Math.floor(r() * 1e6)}`, 30 + r() * 200, 120 + i * 95);
  ctx.beginPath();
  ctx.arc(100 + r() * 500, 150 + r() * 600, 30 + r() * 80, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${r() * 360}, 80%, 60%)`;
  ctx.fill();
  return canvas.toBuffer('image/png');
}

async function transform(buf: Buffer, kind: string): Promise<Buffer> {
  const img = await loadImage(buf);
  const w = img.width;
  const h = img.height;
  switch (kind) {
    case 'jpeg50': {
      const c = createCanvas(w, h);
      c.getContext('2d').drawImage(img, 0, 0);
      return c.encode('jpeg', 50);
    }
    case 'resize60': {
      const c = createCanvas(Math.round(w * 0.6), Math.round(h * 0.6));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.encode('jpeg', 75);
    }
    case 'border': {
      const c = createCanvas(w + 160, h + 240);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 80, 120);
      return c.encode('jpeg', 80);
    }
    case 'crop8': {
      const dx = Math.round(w * 0.08);
      const dy = Math.round(h * 0.08);
      const c = createCanvas(w - 2 * dx, h - 2 * dy);
      c.getContext('2d').drawImage(img, -dx, -dy);
      return c.encode('jpeg', 80);
    }
    case 'zoom15': {
      const dx = Math.round(w * 0.12);
      const dy = Math.round(h * 0.12);
      const c = createCanvas(w, h);
      c.getContext('2d').drawImage(img, dx, dy, w - 2 * dx, h - 2 * dy, 0, 0, w, h);
      return c.encode('jpeg', 80);
    }
    case 'mirror': {
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      return c.encode('jpeg', 80);
    }
    case 'caption': {
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = '#ff0';
      ctx.font = 'bold 40px sans-serif';
      ctx.fillText('CLAIM NOW !!!', 60, h - 60);
      return c.encode('jpeg', 80);
    }
    case 'bright': {
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.filter = 'brightness(130%) contrast(85%)';
      ctx.drawImage(img, 0, 0);
      return c.encode('jpeg', 80);
    }
    case 'rotate3': {
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.translate(w / 2, h / 2);
      ctx.rotate((3 * Math.PI) / 180);
      ctx.drawImage(img, -w / 2, -h / 2);
      return c.encode('jpeg', 80);
    }
    case 'combo': {
      // Recadrage + légende + recompression forte + réduction.
      const dx = Math.round(w * 0.05);
      const c = createCanvas(Math.round((w - 2 * dx) * 0.7), Math.round((h - 2 * dx) * 0.7));
      const ctx = c.getContext('2d');
      ctx.drawImage(img, dx, dx, w - 2 * dx, h - 2 * dx, 0, 0, c.width, c.height);
      ctx.fillStyle = '#0f0';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText('FREE', 20, 40);
      return c.encode('jpeg', 45);
    }
    case 'embedded': {
      // L'image posée dans une capture plus large (interface autour).
      const c = createCanvas(Math.round(w * 1.25), Math.round(h * 1.25));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#313338';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#dbdee1';
      ctx.font = '22px sans-serif';
      for (let i = 0; i < 8; i++) ctx.fillText('message de discussion ' + i, 12, 30 + i * 28);
      ctx.drawImage(img, Math.round(w * 0.2), Math.round(h * 0.22), w, h);
      return c.encode('jpeg', 80);
    }
    case 'phone': {
      // Le visuel posé dans une capture verticale de téléphone (fil Discord).
      const c = createCanvas(720, 1600);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#313338';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#dbdee1';
      ctx.font = '26px sans-serif';
      for (let i = 0; i < 12; i++) ctx.fillText(`quelqu'un a écrit un message ${i}`, 20, 40 + i * 34);
      const dw = 560;
      ctx.drawImage(img, 90, 470, dw, Math.round((h * dw) / w));
      for (let i = 0; i < 6; i++) ctx.fillText('réponse ' + i, 20, 1250 + i * 34);
      return c.encode('jpeg', 80);
    }
    default:
      return buf;
  }
}

const KINDS = ['jpeg50', 'resize60', 'border', 'crop8', 'zoom15', 'mirror', 'caption', 'bright', 'rotate3', 'combo', 'embedded', 'phone'];
const N = 30;

const originals = await Promise.all(Array.from({ length: N }, (_, i) => analyzeImage(makeScene(i + 1))));
const templated = await Promise.all(Array.from({ length: 10 }, (_, i) => analyzeImage(makeScene(1000 + i, true))));

const same: Record<string, number[]> = {};
const v1Hits: Record<string, number> = {};
const sameVerdicts: Record<string, Record<string, number>> = {};
for (let i = 0; i < N; i++) {
  const base = makeScene(i + 1);
  for (const kind of KINDS) {
    const t = await analyzeImage(await transform(base, kind));
    let c = compareFingerprints(t!.fingerprint, originals[i]!.fingerprint);
    // Comme en production : les fenêtres en second recours.
    if (!c.verdict) c = compareWindows(computeWindowHashes(t!.gray, windowShapesFor([originals[i]!.fingerprint.rawAspect])), originals[i]!.fingerprint);
    (same[kind] ??= []).push(c.distance);
    // Ancien moteur : dHash brut, seuil 8.
    if (hammingDistance(t!.phash, originals[i]!.phash) <= 8) v1Hits[kind] = (v1Hits[kind] ?? 0) + 1;
    (sameVerdicts[kind] ??= {})[c.verdict ?? 'none'] = ((sameVerdicts[kind] ??= {})[c.verdict ?? 'none'] ?? 0) + 1;
  }
}

const diff: number[] = [];
const diffVerdicts: Record<string, number> = {};
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    let c = compareFingerprints(originals[i]!.fingerprint, originals[j]!.fingerprint);
    if (!c.verdict) c = compareWindows(computeWindowHashes(originals[i]!.gray, windowShapesFor([originals[j]!.fingerprint.rawAspect])), originals[j]!.fingerprint);
    if (!c.verdict) c = compareWindows(computeWindowHashes(originals[j]!.gray, windowShapesFor([originals[i]!.fingerprint.rawAspect])), originals[i]!.fingerprint);
    diff.push(c.distance);
    diffVerdicts[c.verdict ?? 'none'] = (diffVerdicts[c.verdict ?? 'none'] ?? 0) + 1;
  }
}
const tpl: number[] = [];
const tplVerdicts: Record<string, number> = {};
for (let i = 0; i < templated.length; i++) {
  for (let j = i + 1; j < templated.length; j++) {
    let c = compareFingerprints(templated[i]!.fingerprint, templated[j]!.fingerprint);
    if (!c.verdict) c = compareWindows(computeWindowHashes(templated[i]!.gray, windowShapesFor([templated[j]!.fingerprint.rawAspect])), templated[j]!.fingerprint);
    tpl.push(c.distance);
    tplVerdicts[c.verdict ?? 'none'] = (tplVerdicts[c.verdict ?? 'none'] ?? 0) + 1;
  }
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `min ${s[0].toFixed(1)}  p50 ${s[Math.floor(s.length / 2)].toFixed(1)}  p90 ${s[Math.floor(s.length * 0.9)].toFixed(1)}  max ${s[s.length - 1].toFixed(1)}`;
};
for (const kind of KINDS) console.log(`même image / ${kind.padEnd(8)} ${stats(same[kind])}  ${JSON.stringify(sameVerdicts[kind])}  v1: ${v1Hits[kind] ?? 0}/${N}`);
console.log(`sans rapport          ${stats(diff)}  ${JSON.stringify(diffVerdicts)}`);
console.log(`même gabarit          ${stats(tpl)}  ${JSON.stringify(tplVerdicts)}`);

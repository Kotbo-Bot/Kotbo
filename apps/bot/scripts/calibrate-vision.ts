/**
 * Calibration des seuils Kotbo Vision : mesure la distance entre une image et ses
 * rediffusions typiques (recompression, bordure, recadrage, miroir, texte
 * ajouté), et entre images sans rapport. Les seuils de imageForensics.ts
 * doivent séparer les deux populations. La dernière partie mesure les fausses
 * détections sur des images saines (captures de discussion, pages de texte,
 * mèmes, jeux) face à des arnaques de même mise en page : aucune ne doit sortir
 * CERTAIN ni porter de code QR.
 *
 *   bun run scripts/calibrate-vision.ts
 */
import { createCanvas, Image, loadImage } from '@napi-rs/canvas';
import { analyzeImage, compareFingerprints, compareWindows, computeWindowHashes, hammingDistance, signatureSimilarity, windowShapesFor } from '../src/services/moderation/imageForensics.js';

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

// ── Images saines face à des arnaques de même mise en page ──────────────────

const WORDS = 'salut les gens vous allez bien on joue ce soir quelqu un a vu le dernier patch je crois que oui non mdr trop bien free nitro claim bonus withdraw code promo team serveur regles merci beaucoup'.split(' ');
const sentence = (r: () => number, n: number) => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');

function chat(seed: number, dark: boolean, withImage = false): Buffer {
  const r = rng(seed);
  const w = [720, 1080, 900][Math.floor(r() * 3)];
  const h = 500 + Math.floor(r() * 1000);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = dark ? '#313338' : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  let y = 20 + r() * 30;
  while (y < h - 40) {
    ctx.fillStyle = `hsl(${r() * 360}, 60%, 55%)`;
    ctx.beginPath();
    ctx.arc(36, y + 20, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(sentence(r, 1), 72, y + 14);
    ctx.fillStyle = dark ? '#dbdee1' : '#2e3338';
    ctx.font = '20px sans-serif';
    const lines = 1 + Math.floor(r() * 3);
    for (let i = 0; i < lines; i++) ctx.fillText(sentence(r, 3 + Math.floor(r() * 9)), 72, y + 40 + i * 26);
    y += 50 + lines * 26;
    if (withImage && r() < 0.3) {
      ctx.fillStyle = `hsl(${r() * 360}, 50%, 45%)`;
      ctx.fillRect(72, y, 300, 180);
      y += 200;
    }
  }
  return c.toBuffer('image/png');
}

function doc(seed: number): Buffer {
  const r = rng(seed);
  const c = createCanvas(800, 1000);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 800, 1000);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(sentence(r, 4), 50, 80);
  ctx.font = '22px sans-serif';
  for (let y = 140; y < 960; y += 32) {
    if (r() < 0.12) continue;
    ctx.fillText(sentence(r, 6 + Math.floor(r() * 6)), 50, y);
  }
  return c.toBuffer('image/png');
}

function photo(seed: number, w = 800, h = 600): Buffer {
  const r = rng(seed);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = `hsl(${r() * 360}, 40%, ${20 + r() * 50}%)`;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 25; i++) {
    const x = r() * w;
    const y = r() * h;
    const rad = 40 + r() * 260;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `hsla(${r() * 360}, 60%, ${20 + r() * 60}%, 0.8)`);
    g.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  return c.toBuffer('image/png');
}

function meme(seed: number): Buffer {
  const r = rng(seed);
  const c = createCanvas(700, 760);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 700, 760);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText(sentence(r, 5), 20, 50);
  ctx.fillText(sentence(r, 4), 20, 100);
  const p = photo(seed + 5000, 700, 620);
  // collé tel quel
  const img = new Image();
  img.src = p;
  ctx.drawImage(img, 0, 140);
  return c.toBuffer('image/png');
}

function game(seed: number): Buffer {
  const r = rng(seed);
  const c = createCanvas(1280, 720);
  const ctx = c.getContext('2d');
  const img = new Image();
  img.src = photo(seed + 9000, 1280, 720);
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(20, 640, 400, 60);
  ctx.fillStyle = '#e33';
  ctx.fillRect(30, 650, 100 + r() * 280, 16);
  ctx.fillStyle = '#39f';
  ctx.fillRect(30, 674, 100 + r() * 280, 16);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(1060, 20, 200, 200);
  ctx.fillStyle = '#fff';
  ctx.font = '22px sans-serif';
  ctx.fillText(`${Math.floor(r() * 99)} / 100`, 600, 40);
  return c.toBuffer('image/png');
}

/** Arnaque en capture : carte sombre façon casino, gros montant, bouton. */
function scamCasino(seed: number): Buffer {
  const r = rng(seed);
  const c = createCanvas(720, 1280);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1c24';
  ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = '#262a36';
  ctx.fillRect(40, 200 + r() * 100, 640, 500);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 60px sans-serif';
  ctx.fillText(`$${Math.floor(r() * 9000)}.00`, 200, 420 + r() * 80);
  ctx.font = '26px sans-serif';
  ctx.fillText('Your withdrawal was successful', 140, 520 + r() * 60);
  ctx.fillStyle = `hsl(${120 + r() * 40}, 70%, 45%)`;
  ctx.fillRect(160, 760 + r() * 100, 400, 80);
  ctx.fillStyle = '#9aa';
  for (let i = 0; i < 5; i++) ctx.fillText(sentence(r, 5), 60, 960 + i * 50);
  return c.toBuffer('image/png');
}

/** Arnaque en capture de tweet : fond blanc, avatar, texte, visuel. */
function scamTweet(seed: number): Buffer {
  const r = rng(seed);
  const c = createCanvas(900, 1000);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 900, 1000);
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(70, 70, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText('MrBeast', 130, 60);
  ctx.font = '26px sans-serif';
  for (let i = 0; i < 4; i++) ctx.fillText(sentence(r, 8), 40, 170 + i * 40);
  const img = new Image();
  img.src = photo(seed + 777, 820, 560);
  ctx.drawImage(img, 40, 360);
  return c.toBuffer('image/png');
}



const scams = await Promise.all([
  ...Array.from({ length: 20 }, (_, i) => scamCasino(100 + i)),
  ...Array.from({ length: 20 }, (_, i) => scamTweet(200 + i)),
  ...Array.from({ length: 20 }, (_, i) => chat(300 + i, true)),
  ...Array.from({ length: 15 }, (_, i) => doc(400 + i)),
].map((b) => analyzeImage(b)));
const scamShapes = windowShapesFor(scams.map((s) => s!.fingerprint.rawAspect), 2);
const benign: Record<string, (seed: number) => Buffer> = {
  'discussion sombre': (i) => chat(i, true, true),
  'discussion claire': (i) => chat(i, false, true),
  'page de texte': doc,
  photo,
  'mème': meme,
  jeu: game,
};
for (const [kind, make] of Object.entries(benign)) {
  const verdicts: Record<string, number> = {};
  const sims: number[] = [];
  let qr = 0;
  for (let i = 0; i < 40; i++) {
    const img = (await analyzeImage(make(5000 + i)))!;
    if (img.qr.detected) qr++;
    let verdict: string = 'none';
    for (const scam of scams) {
      sims.push(signatureSimilarity(img.fingerprint.signature!, scam!.fingerprint.signature!));
      const c = compareFingerprints(img.fingerprint, scam!.fingerprint);
      if (c.verdict === 'CERTAIN') verdict = 'CERTAIN';
      else if (c.verdict && verdict === 'none') verdict = 'UNCERTAIN';
    }
    if (verdict === 'none') {
      const windows = computeWindowHashes(img.gray, scamShapes, 3);
      if (scams.some((scam) => compareWindows(windows, scam!.fingerprint).verdict)) verdict = 'UNCERTAIN';
    }
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
  }
  console.log(`saine / ${kind.padEnd(18)} ${JSON.stringify(verdicts)}  signature max ${Math.max(...sims).toFixed(2)}  QR ${qr}/40`);
}

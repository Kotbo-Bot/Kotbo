/**
 * imageForensics.ts - Analyse d'image pour la modération.
 *
 * Deux capacités, toutes deux locales (aucun appel réseau, aucune image
 * transmise à un tiers) :
 *
 *  1. Empreinte perceptuelle (dHash). Le SHA-256 des octets casse dès qu'un
 *     pixel change ou que l'image est recompressée - ce que font justement les
 *     campagnes qui rediffusent une capture d'arnaque. Le dHash compare la
 *     structure de l'image et survit au recadrage léger, au rééchantillonnage
 *     et au changement de qualité JPEG.
 *
 *  2. Détection de code QR. Le phishing par QR de connexion Discord (faire
 *     scanner un code qui autorise la session de l'attaquant) est une campagne
 *     massive qu'aucun filtre de lien n'attrape, puisqu'il n'y a pas de lien.
 *     On ne décode pas le contenu : repérer la présence des motifs de
 *     repérage suffit à décider qu'un compte sans historique n'a rien à faire
 *     à poster ça.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { logger } from '../../utils/logger.js';

export type GrayscaleImage = {
  data: Uint8Array;
  width: number;
  height: number;
};

/** Au-delà, l'image est réduite : la précision gagnée ne vaut pas le coût. */
const MAX_ANALYSIS_WIDTH = 512;

/**
 * Décode une image en niveaux de gris.
 * Retourne null si le format est illisible - un fichier corrompu ou exotique
 * ne doit pas faire échouer la modération du message.
 */
export async function toGrayscale(buffer: Buffer): Promise<GrayscaleImage | null> {
  try {
    const image = await loadImage(buffer);
    const scale = Math.min(1, MAX_ANALYSIS_WIDTH / image.width);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // Luminance perçue (Rec. 601), suffisante et bien moins chère qu'une
      // conversion colorimétrique exacte.
      gray[p] = (data[i] * 77 + data[i + 1] * 151 + data[i + 2] * 28) >> 8;
    }

    return { data: gray, width, height };
  } catch (err) {
    logger.debug('ImageForensics', `Décodage impossible: ${String(err)}`);
    return null;
  }
}

/** Rééchantillonne en niveaux de gris par moyenne de blocs (box filter). */
function resizeGray(image: GrayscaleImage, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));

      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1 && sy < image.height; sy++) {
        for (let sx = x0; sx < x1 && sx < image.width; sx++) {
          sum += image.data[sy * image.width + sx];
          count++;
        }
      }
      out[y * width + x] = count === 0 ? 0 : Math.round(sum / count);
    }
  }
  return out;
}

/**
 * Empreinte perceptuelle 64 bits (dHash), rendue en hexadécimal.
 *
 * Principe : réduire à 9×8, puis comparer chaque pixel à son voisin de droite.
 * Ce sont les *variations* qui sont encodées, pas les valeurs absolues, ce qui
 * rend l'empreinte insensible à la luminosité et au contraste global.
 */
export function perceptualHash(image: GrayscaleImage): string {
  const width = 9;
  const height = 8;
  const small = resizeGray(image, width, height);

  let hex = '';
  let bits = 0;
  let acc = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = small[y * width + x];
      const right = small[y * width + x + 1];
      acc = (acc << 1) | (left > right ? 1 : 0);
      bits++;
      if (bits === 4) {
        hex += acc.toString(16);
        bits = 0;
        acc = 0;
      }
    }
  }

  return hex;
}

/** Nombre de bits différents entre deux empreintes hexadécimales. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let diff = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    if (Number.isNaN(diff)) return Number.MAX_SAFE_INTEGER;
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

/**
 * Distance maximale entre deux empreintes considérées comme la même image.
 * 8 bits sur 64 tolère la recompression et un léger recadrage sans confondre
 * deux images sans rapport.
 */
export const PHASH_MATCH_THRESHOLD = 8;

export function isPerceptualMatch(a: string, b: string, threshold = PHASH_MATCH_THRESHOLD): boolean {
  return hammingDistance(a, b) <= threshold;
}

// ─── Détection de code QR ───────────────────────────────────────────────────────

/**
 * Seuil global d'Otsu : sépare l'image en deux classes de luminance.
 *
 * La valeur retournée est la *dernière* de la classe sombre : la binarisation
 * doit donc tester `valeur <= seuil`. Sur une image purement bimodale (0/255),
 * comme un QR de synthèse, Otsu retourne 0 et un test strict exclurait tous les
 * pixels noirs.
 */
function otsuThreshold(data: Uint8Array): number {
  const histogram = new Array(256).fill(0);
  for (const value of data) histogram[value]++;

  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  return threshold;
}

/**
 * Un motif de repérage QR se projette, sur toute ligne qui le traverse, en une
 * suite sombre-clair-sombre-clair-sombre de proportions 1:1:3:1:1.
 */
function matchesFinderRatio(counts: number[]): boolean {
  const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  if (total < 7) return false;

  const moduleSize = total / 7;
  // Tolérance large : perspective, anticrénelage et compression déforment les
  // proportions. Un motif trop strict ne détecterait que les QR parfaits.
  const tolerance = moduleSize * 0.6;

  return (
    Math.abs(moduleSize - counts[0]) < tolerance &&
    Math.abs(moduleSize - counts[1]) < tolerance &&
    Math.abs(moduleSize * 3 - counts[2]) < tolerance * 3 &&
    Math.abs(moduleSize - counts[3]) < tolerance &&
    Math.abs(moduleSize - counts[4]) < tolerance
  );
}

export type QrDetection = {
  detected: boolean;
  /** Nombre de motifs de repérage distincts trouvés (un QR complet en a 3). */
  patterns: number;
};

/**
 * Détecte la présence probable d'un code QR.
 *
 * On balaie les lignes à la recherche de la signature 1:1:3:1:1, puis on
 * regroupe les candidats proches : un vrai motif produit des détections sur
 * plusieurs lignes consécutives, là où le bruit en produit une isolée.
 *
 * On exige deux motifs distincts plutôt que trois : un QR partiellement
 * recadré ou incrusté dans un visuel en perd souvent un.
 */
export function detectQrCode(image: GrayscaleImage): QrDetection {
  const { data, width, height } = image;
  if (width < 40 || height < 40) return { detected: false, patterns: 0 };

  const threshold = otsuThreshold(data);
  const candidates: { x: number; y: number; size: number }[] = [];

  // Une ligne sur deux : un motif de repérage fait au moins quelques pixels de
  // haut, il ne peut pas passer entre les mailles.
  for (let y = 0; y < height; y += 2) {
    const counts = [0, 0, 0, 0, 0];
    let state = 0;
    const rowStart = y * width;

    for (let x = 0; x < width; x++) {
      const isDark = data[rowStart + x] <= threshold;

      if (isDark === (state % 2 === 0)) {
        // Toujours dans la même bande.
        counts[state]++;
        continue;
      }

      if (state === 4) {
        if (matchesFinderRatio(counts)) {
          const total = counts.reduce((s, c) => s + c, 0);
          candidates.push({ x: x - total / 2, y, size: total });
        }
        // Glisse la fenêtre de deux bandes pour chercher un motif chevauchant.
        counts[0] = counts[2];
        counts[1] = counts[3];
        counts[2] = counts[4];
        counts[3] = 1;
        counts[4] = 0;
        state = 3;
        continue;
      }

      state++;
      counts[state] = 1;
    }

    if (state === 4 && matchesFinderRatio(counts)) {
      const total = counts.reduce((s, c) => s + c, 0);
      candidates.push({ x: width - total / 2, y, size: total });
    }
  }

  if (candidates.length === 0) return { detected: false, patterns: 0 };

  // Regroupe les candidats en motifs : même abscisse à un module près, lignes
  // proches. Un motif isolé sur une seule ligne est du bruit.
  type Cluster = { x: number; y: number; size: number; hits: number };
  const clusters: Cluster[] = [];

  for (const candidate of candidates) {
    const cluster = clusters.find(
      (c) =>
        Math.abs(c.x - candidate.x) < candidate.size / 2 &&
        Math.abs(c.y - candidate.y) < candidate.size * 1.5 &&
        Math.abs(c.size - candidate.size) < candidate.size / 2
    );

    if (cluster) {
      cluster.x = (cluster.x * cluster.hits + candidate.x) / (cluster.hits + 1);
      cluster.y = candidate.y;
      cluster.hits++;
    } else {
      clusters.push({ ...candidate, hits: 1 });
    }
  }

  const solid = clusters.filter((c) => c.hits >= 3);
  return { detected: solid.length >= 2, patterns: solid.length };
}

// ─── Empreinte Kotbo Vision v2 ─────────────────────────────────────────────────────
//
// Un dHash seul, calculé sur l'image brute, rate l'essentiel des rediffusions
// réelles : la capture rognée d'une bande noire, zoomée, retournée, ou posée
// dans un cadre. L'empreinte v2 combine trois hash complémentaires et les
// calcule sur plusieurs vues de l'image :
//
//  - dHash horizontal et vertical : gradients, robustes à la recompression ;
//  - pHash (DCT) : basses fréquences, robuste au flou, au bruit et aux
//    retouches de couleur, là où le dHash décroche ;
//  - vues : image débarrassée de ses bords uniformes, son centre (zoom ou
//    recadrage), son miroir (retournement horizontal, courant pour échapper
//    aux filtres), et l'image brute pour les entrées v1 qui n'ont qu'un dHash.
//
// Deux images sont comparées vue contre vue ; la meilleure paire décide.

/** Hash 64 bits rangé en deux mots de 32 bits, pour un popcount rapide. */
type Hash64 = [number, number];

type ViewHashes = { dh: Hash64; dv: Hash64; ph: Hash64 };

/**
 * Vues d'une image, chacune résumée par trois hash :
 *  - raw : l'image telle quelle (sert aussi aux entrées v1, dHash seul) ;
 *  - full : débarrassée de ses bords uniformes ;
 *  - mirror : full retournée horizontalement ;
 *  - c6, c12, c20 : centre de raw, rogné de 6, 12 et 20 % par côté (un zoom
 *    ou un recadrage s'applique à l'image brute, pas à sa version rognée).
 */
const VIEW_NAMES = ['raw', 'full', 'mirror', 'c6', 'c12', 'c20'] as const;
type ViewName = (typeof VIEW_NAMES)[number];
const CENTER_VIEWS = [['c6', 0.06], ['c12', 0.12], ['c20', 0.2]] as const;

export type ParsedFingerprint = {
  /** Largeur / hauteur de l'image débarrassée de ses bords. */
  aspect: number;
  /** Largeur / hauteur de l'image brute, forme cherchée par les fenêtres. */
  rawAspect: number;
  /** Image quasi unie : ses hash sont dégénérés, seule l'égalité exacte compte. */
  flat: boolean;
  views: Record<ViewName, ViewHashes>;
};

function hexToHash(hex: string): Hash64 | null {
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  return [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8), 16) >>> 0];
}

function hashToHex(h: Hash64): string {
  return h[0].toString(16).padStart(8, '0') + h[1].toString(16).padStart(8, '0');
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

function distance64(a: Hash64, b: Hash64): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

function bitsToHash(bits: boolean[]): Hash64 {
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 32; i++) hi = ((hi << 1) | (bits[i] ? 1 : 0)) >>> 0;
  for (let i = 32; i < 64; i++) lo = ((lo << 1) | (bits[i] ? 1 : 0)) >>> 0;
  return [hi, lo];
}

function crop(image: GrayscaleImage, x0: number, y0: number, x1: number, y1: number): GrayscaleImage {
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    data.set(image.data.subarray((y0 + y) * image.width + x0, (y0 + y) * image.width + x0 + width), y * width);
  }
  return { data, width, height };
}

function mirror(image: GrayscaleImage): GrayscaleImage {
  const data = new Uint8Array(image.data.length);
  for (let y = 0; y < image.height; y++) {
    const row = y * image.width;
    for (let x = 0; x < image.width; x++) data[row + x] = image.data[row + image.width - 1 - x];
  }
  return { data, width: image.width, height: image.height };
}

/**
 * Retire les bords uniformes (bandes noires, marges blanches d'une capture,
 * cadre ajouté pour casser le hash). Une rangée est un bord si elle est quasi
 * constante et proche de la teinte du bord extérieur. Jamais plus de 40 % par
 * côté : au-delà, ce n'est plus un bord mais le sujet.
 */
export function trimUniformBorders(image: GrayscaleImage): GrayscaleImage {
  const { data, width, height } = image;
  if (width < 24 || height < 24) return image;

  const lineStats = (get: (i: number) => number, length: number) => {
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < length; i++) {
      const v = get(i);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / length;
    return { mean, std: Math.sqrt(Math.max(0, sumSq / length - mean * mean)) };
  };
  const row = (y: number) => lineStats((i) => data[y * width + i], width);
  const col = (x: number) => lineStats((i) => data[i * width + x], height);

  const isBorder = (s: { mean: number; std: number }, ref: number) => s.std < 7 && Math.abs(s.mean - ref) < 14;

  const maxY = Math.floor(height * 0.4);
  const maxX = Math.floor(width * 0.4);

  let top = 0;
  const topRef = row(0).mean;
  while (top < maxY && isBorder(row(top), topRef)) top++;
  let bottom = height - 1;
  const bottomRef = row(height - 1).mean;
  while (height - 1 - bottom < maxY && isBorder(row(bottom), bottomRef)) bottom--;
  let left = 0;
  const leftRef = col(0).mean;
  while (left < maxX && isBorder(col(left), leftRef)) left++;
  let right = width - 1;
  const rightRef = col(width - 1).mean;
  while (width - 1 - right < maxX && isBorder(col(right), rightRef)) right--;

  if (right - left < 16 || bottom - top < 16) return image;
  if (top === 0 && left === 0 && bottom === height - 1 && right === width - 1) return image;
  return crop(image, left, top, right + 1, bottom + 1);
}

/**
 * Rognage répété jusqu'à stabilité. Une bordure ajoutée autour d'une image qui
 * commence elle-même par une bande unie masque cette bande au premier passage :
 * sans le second, l'original et sa version encadrée ne seraient pas rognés
 * pareil et leurs empreintes divergeraient.
 */
function trimToContent(image: GrayscaleImage): GrayscaleImage {
  let current = image;
  for (let pass = 0; pass < 4; pass++) {
    const next = trimUniformBorders(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** dHash vertical : chaque pixel comparé à celui du dessous. */
function verticalDHash(image: GrayscaleImage): Hash64 {
  const width = 8;
  const height = 9;
  const small = resizeGray(image, width, height);
  const bits: boolean[] = [];
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width; x++) bits.push(small[y * width + x] > small[(y + 1) * width + x]);
  }
  return bitsToHash(bits);
}

const DCT_SIZE = 32;
const DCT_KEEP = 8;
// cos((2x + 1) u π / 2N), précalculé pour les 8 premières fréquences.
const DCT_COS: Float64Array[] = Array.from({ length: DCT_KEEP }, (_, u) => {
  const row = new Float64Array(DCT_SIZE);
  for (let x = 0; x < DCT_SIZE; x++) row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_SIZE));
  return row;
});

/**
 * pHash : réduction à 32×32, DCT, puis les 8×8 plus basses fréquences
 * comparées à leur médiane. Seuls les coefficients gardés sont calculés.
 */
function dctHash(image: GrayscaleImage): { hash: Hash64; flat: boolean } {
  return dctOfSmall(resizeGray(image, DCT_SIZE, DCT_SIZE));
}

/** pHash d'une image déjà réduite à 32×32. */
function dctOfSmall(small: ArrayLike<number>): { hash: Hash64; flat: boolean } {
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < small.length; i++) {
    sum += small[i];
    sumSq += small[i] * small[i];
  }
  const mean = sum / small.length;
  const std = Math.sqrt(Math.max(0, sumSq / small.length - mean * mean));

  // Transformée des lignes, puis des colonnes, limitée aux fréquences gardées.
  const rows = new Float64Array(DCT_SIZE * DCT_KEEP);
  for (let y = 0; y < DCT_SIZE; y++) {
    for (let u = 0; u < DCT_KEEP; u++) {
      let acc = 0;
      const cos = DCT_COS[u];
      for (let x = 0; x < DCT_SIZE; x++) acc += small[y * DCT_SIZE + x] * cos[x];
      rows[y * DCT_KEEP + u] = acc;
    }
  }
  const coeffs: number[] = [];
  for (let v = 0; v < DCT_KEEP; v++) {
    const cos = DCT_COS[v];
    for (let u = 0; u < DCT_KEEP; u++) {
      let acc = 0;
      for (let y = 0; y < DCT_SIZE; y++) acc += rows[y * DCT_KEEP + u] * cos[y];
      coeffs.push(acc);
    }
  }

  // La composante continue (luminosité moyenne) écraserait la médiane.
  const sorted = coeffs.slice(1).sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  return { hash: bitsToHash(coeffs.map((c) => c > median)), flat: std < 6 };
}

function viewHashes(image: GrayscaleImage): ViewHashes & { flat: boolean } {
  const dct = dctHash(image);
  return {
    dh: hexToHash(perceptualHash(image))!,
    dv: verticalDHash(image),
    ph: dct.hash,
    flat: dct.flat,
  };
}

const pickHashes = ({ dh, dv, ph }: ViewHashes): ViewHashes => ({ dh, dv, ph });

/** Calcule l'empreinte v2 d'une image en niveaux de gris. */
export function computeFingerprint(image: GrayscaleImage): ParsedFingerprint {
  const trimmed = trimToContent(image);
  const full = viewHashes(trimmed);
  const views = {
    raw: pickHashes(viewHashes(image)),
    full: pickHashes(full),
    mirror: pickHashes(viewHashes(mirror(trimmed))),
  } as Record<ViewName, ViewHashes>;
  for (const [name, inset] of CENTER_VIEWS) {
    const cx = Math.floor(image.width * inset);
    const cy = Math.floor(image.height * inset);
    views[name] = pickHashes(viewHashes(crop(image, cx, cy, image.width - cx, image.height - cy)));
  }
  return { aspect: trimmed.width / trimmed.height, rawAspect: image.width / image.height, flat: full.flat, views };
}

const viewToString = (v: ViewHashes) => `${hashToHex(v.dh)}.${hashToHex(v.dv)}.${hashToHex(v.ph)}`;

/** Sérialisation stockée en base (colonne `fingerprint`). */
export function serializeFingerprint(fp: ParsedFingerprint): string {
  const aspects = `${Math.round(fp.aspect * 1000)}/${Math.round(fp.rawAspect * 1000)}`;
  return ['v2', aspects, fp.flat ? 1 : 0, ...VIEW_NAMES.map((n) => viewToString(fp.views[n]))].join(';');
}

function parseView(text: string | undefined): ViewHashes | null {
  const parts = text?.split('.') ?? [];
  if (parts.length !== 3) return null;
  const [dh, dv, ph] = parts.map(hexToHash);
  return dh && dv && ph ? { dh, dv, ph } : null;
}

export function parseFingerprint(text: string | null | undefined): ParsedFingerprint | null {
  if (!text) return null;
  const parts = text.split(';');
  if (parts[0] !== 'v2' || parts.length !== 3 + VIEW_NAMES.length) return null;
  const views = {} as Record<ViewName, ViewHashes>;
  for (let i = 0; i < VIEW_NAMES.length; i++) {
    const view = parseView(parts[3 + i]);
    if (!view) return null;
    views[VIEW_NAMES[i]] = view;
  }
  const [aspect, rawAspect] = parts[1].split('/').map((n) => Number(n) / 1000);
  if (!aspect || !rawAspect) return null;
  return { aspect, rawAspect, flat: parts[2] === '1', views };
}

/** Empreinte v1 (dHash seul, colonne `phash`) rendue comparable. */
export function parseLegacyHash(hex: string | null | undefined): Hash64 | null {
  return hex ? hexToHash(hex) : null;
}

export type MatchVerdict = 'CERTAIN' | 'UNCERTAIN';

export type FingerprintComparison = {
  verdict: MatchVerdict | null;
  /** Distance pondérée en bits (0 = identiques, ~32 = sans rapport). */
  distance: number;
  /** Similarité de 0 à 1, pour l'affichage. */
  similarity: number;
};

// Seuils calibrés sur 64 bits : deux images sans rapport tombent autour de 32
// bits de distance ; une recompression sous 4 ; un recadrage léger vers 6-10.
const CERTAIN_MAX = 7;
const UNCERTAIN_MAX = 12;
const LEGACY_CERTAIN_MAX = 6;
const LEGACY_UNCERTAIN_MAX = 10;

function compareViews(a: ViewHashes, b: ViewHashes): { score: number; ph: number; worst: number } {
  const dh = distance64(a.dh, b.dh);
  const dv = distance64(a.dv, b.dv);
  const ph = distance64(a.ph, b.ph);
  // Le pHash pèse plus : il résiste aux retouches que le dHash ne supporte pas.
  return { score: (dh + dv + ph * 1.5) / 3.5, ph, worst: Math.max(dh, dv) };
}

const NO_MATCH: FingerprintComparison = { verdict: null, distance: 64, similarity: 0 };

function toComparison(distance: number, certainMax: number, uncertainMax: number, certainAllowed = true): FingerprintComparison {
  const verdict = distance <= certainMax && certainAllowed ? 'CERTAIN' : distance <= uncertainMax ? 'UNCERTAIN' : null;
  return { verdict, distance, similarity: Math.max(0, Math.min(1, 1 - distance / 32)) };
}

// Paires de vues comparées. Le troisième terme dit si les deux vues ont le
// même cadrage : seules celles-là doivent avoir des proportions voisines.
const SAME_FRAME_PAIRS: [ViewName, ViewName][] = [
  ['full', 'full'],
  ['raw', 'raw'],
  ['full', 'raw'],
  ['raw', 'full'],
  ['mirror', 'full'],
];
// Reçue zoomée (son entier = un centre du connu) ou dézoomée (l'inverse).
const REFRAMED_PAIRS: [ViewName, ViewName][] = [
  ...CENTER_VIEWS.map(([c]) => ['raw', c] as [ViewName, ViewName]),
  ...CENTER_VIEWS.map(([c]) => [c, 'raw'] as [ViewName, ViewName]),
  ['c6', 'c12'],
  ['c12', 'c6'],
  ['c12', 'c12'],
];

/**
 * Compare une image reçue (`incoming`) à une entrée du catalogue (`known`).
 * La meilleure paire de vues décide : même image, image rognée ou encadrée,
 * retournée, zoomée ou dézoomée.
 */
export function compareFingerprints(incoming: ParsedFingerprint, known: ParsedFingerprint): FingerprintComparison {
  // Une image quasi unie a des hash dégénérés : la confondre avec une autre
  // image plate bloquerait n'importe quel fond de couleur.
  if (incoming.flat || known.flat) return NO_MATCH;

  let best = { score: Number.POSITIVE_INFINITY, ph: 64, worst: 64, sameFrame: true };
  const consider = (pairs: [ViewName, ViewName][], sameFrame: boolean) => {
    for (const [a, b] of pairs) {
      const r = compareViews(incoming.views[a], known.views[b]);
      if (r.score < best.score) best = { ...r, sameFrame };
    }
  };
  consider(SAME_FRAME_PAIRS, true);
  consider(REFRAMED_PAIRS, false);

  // Une paire cohérente doit aussi l'être sur chaque hash pris seul : une
  // moyenne basse avec un hash très éloigné trahit une coïncidence.
  const coherent = best.ph <= 10 && best.worst <= 14;
  // Deux images de même cadrage aux proportions très différentes ne sont pas
  // la même capture.
  const ratio = Math.max(incoming.aspect, known.aspect) / Math.min(incoming.aspect, known.aspect);
  const sameShape = !best.sameFrame || ratio < 1.35;

  return toComparison(best.score, CERTAIN_MAX, UNCERTAIN_MAX, coherent && sameShape);
}

/** Comparaison avec une entrée v1, qui n'a que le dHash de l'image brute. */
export function compareWithLegacy(incoming: ParsedFingerprint, legacy: Hash64): FingerprintComparison {
  if (incoming.flat) return NO_MATCH;
  return toComparison(distance64(incoming.views.raw.dh, legacy), LEGACY_CERTAIN_MAX, LEGACY_UNCERTAIN_MAX);
}

// ─── Recherche par fenêtres (image incrustée dans une capture) ─────────────────
//
// Une arnaque rediffusée en capture d'écran (le post, entouré de l'interface
// Discord) n'a plus rien de commun, globalement, avec l'image d'origine. On
// cherche donc l'image connue *dans* l'image reçue : des fenêtres de plusieurs
// tailles balayent l'image, chacune hashée comme une image à part entière.
//
// L'image intégrale (table des sommes cumulées) rend la réduction d'une fenêtre
// proportionnelle à la taille de la sortie, pas de la fenêtre : 75 fenêtres
// coûtent quelques millisecondes.

type IntegralImage = { sums: Float64Array; width: number; height: number };

function integralOf(image: GrayscaleImage): IntegralImage {
  const { data, width, height } = image;
  const stride = width + 1;
  const sums = new Float64Array(stride * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += data[(y - 1) * width + (x - 1)];
      sums[y * stride + x] = sums[(y - 1) * stride + x] + rowSum;
    }
  }
  return { sums, width, height };
}

/** Réduit la fenêtre (x, y, w, h) à outW×outH par moyenne de blocs. */
function resizeWindow(ii: IntegralImage, x: number, y: number, w: number, h: number, outW: number, outH: number): Float64Array {
  const out = new Float64Array(outW * outH);
  const stride = ii.width + 1;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = y + Math.floor((oy * h) / outH);
    const y1 = Math.max(y0 + 1, y + Math.floor(((oy + 1) * h) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = x + Math.floor((ox * w) / outW);
      const x1 = Math.max(x0 + 1, x + Math.floor(((ox + 1) * w) / outW));
      const total = ii.sums[y1 * stride + x1] - ii.sums[y0 * stride + x1] - ii.sums[y1 * stride + x0] + ii.sums[y0 * stride + x0];
      out[oy * outW + ox] = total / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function dHashOfSmall(small: Float64Array): Hash64 {
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits.push(small[y * 9 + x] > small[y * 9 + x + 1]);
  }
  return bitsToHash(bits);
}

export type WindowHashes = { dh: Hash64; ph: Hash64; aspect: number }[];

const WINDOW_SCALES = [0.45, 0.6, 0.75, 0.9];
/** Fenêtres calculées au plus par image, toutes formes et échelles confondues. */
const WINDOW_BUDGET = 900;

/**
 * Nombre de positions d'une fenêtre le long d'un axe. Le pas suit la taille de
 * la fenêtre (4 %), pas celle de l'image : sur une capture très haute, un pas
 * fixe laisserait des trous assez grands pour que l'image cherchée tombe entre
 * deux fenêtres.
 */
function idealPositions(range: number, size: number): number {
  if (range <= 0) return 1;
  return Math.max(3, Math.ceil(range / Math.max(1, size * 0.04)) + 1);
}

function spread(range: number, count: number): number[] {
  if (range <= 0 || count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => Math.round((range * i) / (count - 1)));
}

/**
 * Regroupe des proportions en quelques formes de fenêtre représentatives :
 * deux formes à moins de 12 % l'une de l'autre n'en font qu'une. Les plus
 * fréquentes passent d'abord.
 */
export function windowShapesFor(aspects: number[], max = 4): number[] {
  const buckets = new Map<number, number>();
  for (const aspect of aspects) {
    if (!Number.isFinite(aspect) || aspect <= 0) continue;
    const key = Math.round(Math.log(aspect) / Math.log(1.12));
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) => 1.12 ** key);
}

/**
 * Hash des fenêtres d'une image, pour la recherche d'une image incrustée.
 * Les formes de fenêtre sont celle de l'image reçue (la même capture,
 * recadrée) et celles des images recherchées, que l'appelant tire du
 * catalogue (`windowShapesFor`).
 */
export function computeWindowHashes(image: GrayscaleImage, extraShapes: number[] = [1], maxShapes = 3): WindowHashes {
  if (image.width < 64 || image.height < 64) return [];
  const ii = integralOf(image);
  const out: WindowHashes = [];
  const shapes: number[] = [image.width / image.height];
  for (const shape of extraShapes) {
    if (shapes.length >= maxShapes) break;
    if (shapes.every((s) => Math.max(s, shape) / Math.min(s, shape) > 1.12)) shapes.push(shape);
  }
  for (const aspect of shapes) {
    // Plus grande fenêtre de cette forme qui tient dans l'image.
    const boxW = Math.min(image.width, image.height * aspect);
    for (const scale of WINDOW_SCALES) {
      const w = Math.floor(boxW * scale);
      const h = Math.floor(w / aspect);
      if (w < 32 || h < 32) continue;
      // Au-delà du budget de la combinaison, le pas s'élargit sur les deux axes.
      let nx = idealPositions(image.width - w, w);
      let ny = idealPositions(image.height - h, h);
      const budget = WINDOW_BUDGET / (shapes.length * WINDOW_SCALES.length);
      if (nx * ny > budget) {
        const factor = Math.sqrt(budget / (nx * ny));
        nx = Math.max(nx > 1 ? 2 : 1, Math.round(nx * factor));
        ny = Math.max(ny > 1 ? 2 : 1, Math.round(ny * factor));
      }
      for (const y of spread(image.height - h, ny)) {
        for (const x of spread(image.width - w, nx)) {
          const dct = dctOfSmall(resizeWindow(ii, x, y, w, h, DCT_SIZE, DCT_SIZE));
          if (dct.flat) continue;
          out.push({ dh: dHashOfSmall(resizeWindow(ii, x, y, w, h, 9, 8)), ph: dct.hash, aspect: w / h });
        }
      }
    }
  }
  return out;
}

// Plus de fenêtres = plus de chances de coïncidence : les seuils sont plus
// serrés que pour la comparaison d'image à image.
const WINDOW_CERTAIN_MAX = 4.5;
const WINDOW_UNCERTAIN_MAX = 9;
const WINDOW_PH_MAX = 7;

/**
 * Cherche une entrée connue dans les fenêtres d'une image reçue. Seules les
 * fenêtres de forme voisine de l'entrée sont essayées, et le pHash sert de
 * premier filtre : c'est ce qui rend la recherche abordable sur un catalogue
 * de plusieurs milliers d'images.
 */
export function compareWindows(windows: WindowHashes, known: ParsedFingerprint): FingerprintComparison {
  if (known.flat || windows.length === 0) return NO_MATCH;
  let best = { score: Number.POSITIVE_INFINITY, ph: 64, dh: 64 };
  for (const win of windows) {
    const ratio = Math.min(...[known.aspect, known.rawAspect].map((a) => Math.max(a, win.aspect) / Math.min(a, win.aspect)));
    if (ratio > 1.3) continue;
    for (const view of [known.views.raw, known.views.full]) {
      const ph = distance64(win.ph, view.ph);
      if (ph > WINDOW_PH_MAX) continue;
      const dh = distance64(win.dh, view.dh);
      const score = (dh + ph * 1.5) / 2.5;
      if (score < best.score) best = { score, ph, dh };
    }
  }
  if (best.score === Number.POSITIVE_INFINITY) return NO_MATCH;
  return toComparison(best.score, WINDOW_CERTAIN_MAX, WINDOW_UNCERTAIN_MAX, best.dh <= 12);
}

export type ImageAnalysis = {
  phash: string;
  qr: QrDetection;
  width: number;
  height: number;
  fingerprint: ParsedFingerprint;
  /** Image décodée, pour calculer les fenêtres à la demande. */
  gray: GrayscaleImage;
  /** Vignette JPEG en data URL, si demandée. */
  thumb: string | null;
};

const THUMB_MAX_SIDE = 160;

async function makeThumbnail(image: Awaited<ReturnType<typeof loadImage>>): Promise<string | null> {
  try {
    const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(image.width, image.height));
    const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvas.encode('jpeg', 70);
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Analyse complète d'un tampon d'image. null si le format est illisible. */
export async function analyzeImage(buffer: Buffer, opts: { thumb?: boolean } = {}): Promise<ImageAnalysis | null> {
  const gray = await toGrayscale(buffer);
  if (!gray) return null;

  let thumb: string | null = null;
  if (opts.thumb) {
    const image = await loadImage(buffer).catch(() => null);
    if (image) thumb = await makeThumbnail(image);
  }

  return {
    phash: perceptualHash(gray),
    qr: detectQrCode(gray),
    width: gray.width,
    height: gray.height,
    fingerprint: computeFingerprint(gray),
    gray,
    thumb,
  };
}

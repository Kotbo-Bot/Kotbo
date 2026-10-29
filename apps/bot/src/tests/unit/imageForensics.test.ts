import { describe, expect, test } from 'bun:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';

import {
  analyzeImage,
  compareFingerprints,
  compareWindows,
  compareWithLegacy,
  computeWindowHashes,
  detectQrCode,
  hammingDistance,
  isPerceptualMatch,
  parseFingerprint,
  parseLegacyHash,
  perceptualHash,
  serializeFingerprint,
  toGrayscale,
  windowShapesFor,
} from '../../services/moderation/imageForensics.js';

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

/**
 * Dessine un motif de repérage QR : anneau noir de 1 module, anneau blanc de
 * 1 module, carré noir de 3 modules. C'est exactement la structure que le
 * détecteur cherche, en proportions 1:1:3:1:1 sur toute ligne le traversant.
 */
function drawFinderPattern(ctx: Ctx, x: number, y: number, moduleSize: number): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, moduleSize * 7, moduleSize * 7);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + moduleSize, y + moduleSize, moduleSize * 5, moduleSize * 5);
  ctx.fillStyle = '#000';
  ctx.fillRect(x + moduleSize * 2, y + moduleSize * 2, moduleSize * 3, moduleSize * 3);
}

/** Image synthétique portant les trois motifs de repérage d'un QR. */
function makeQrLikeImage(moduleSize = 6, withNoise = false): Buffer {
  const size = moduleSize * 29;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);

  const offset = moduleSize * 22;
  drawFinderPattern(ctx, 0, 0, moduleSize);
  drawFinderPattern(ctx, offset, 0, moduleSize);
  drawFinderPattern(ctx, 0, offset, moduleSize);

  if (withNoise) {
    // Modules de données pseudo-aléatoires, comme dans un vrai QR.
    ctx.fillStyle = '#000';
    for (let i = 0; i < 120; i++) {
      const mx = (i * 7) % 20;
      const my = (i * 11) % 20;
      if ((mx + my) % 3 === 0) {
        ctx.fillRect((mx + 4) * moduleSize, (my + 4) * moduleSize, moduleSize, moduleSize);
      }
    }
  }

  return canvas.toBuffer('image/png');
}

function makePhotoLikeImage(seed = 1): Buffer {
  const canvas = createCanvas(200, 200);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 200, 200);
  gradient.addColorStop(0, `rgb(${40 * seed % 255}, 90, 160)`);
  gradient.addColorStop(1, `rgb(220, ${70 * seed % 255}, 60)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 200, 200);

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.arc(((i * 37 * seed) % 200), ((i * 53) % 200), 12 + (i % 5) * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

describe('hammingDistance', () => {
  test('vaut 0 pour deux empreintes identiques', () => {
    expect(hammingDistance('ff00ff00ff00ff00', 'ff00ff00ff00ff00')).toBe(0);
  });

  test('compte les bits differents', () => {
    // 0x0 -> 0x1 = un bit, 0x0 -> 0x3 = deux bits.
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', '0000000000000003')).toBe(2);
  });

  test('refuse de comparer des empreintes de longueurs differentes', () => {
    expect(hammingDistance('ff00', 'ff0000')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('perceptualHash', () => {
  test('produit une empreinte de 64 bits', async () => {
    const gray = await toGrayscale(makePhotoLikeImage());
    expect(gray).not.toBeNull();
    expect(perceptualHash(gray!)).toHaveLength(16);
  });

  test('est deterministe', async () => {
    const buffer = makePhotoLikeImage(3);
    const a = await toGrayscale(buffer);
    const b = await toGrayscale(buffer);
    expect(perceptualHash(a!)).toBe(perceptualHash(b!));
  });

  test('resiste au reechantillonnage, la ou un hash exact casserait', async () => {
    // Même visuel, rendu deux fois a des tailles differentes : les octets n'ont
    // rien en commun, la structure si.
    const large = createCanvas(400, 400);
    const small = createCanvas(160, 160);
    for (const [canvas, size] of [[large, 400], [small, 160]] as const) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#123456';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#eeddcc';
      ctx.fillRect(size * 0.1, size * 0.15, size * 0.4, size * 0.3);
      ctx.fillStyle = '#aa2211';
      ctx.beginPath();
      ctx.arc(size * 0.7, size * 0.7, size * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }

    const a = perceptualHash((await toGrayscale(large.toBuffer('image/png')))!);
    const b = perceptualHash((await toGrayscale(small.toBuffer('image/png')))!);
    expect(isPerceptualMatch(a, b)).toBe(true);
  });

  test('distingue deux images sans rapport', async () => {
    const a = perceptualHash((await toGrayscale(makePhotoLikeImage(1)))!);
    const b = perceptualHash((await toGrayscale(makeQrLikeImage(8, true)))!);
    expect(isPerceptualMatch(a, b)).toBe(false);
  });
});

describe('detectQrCode', () => {
  test('detecte les motifs de reperage d un code QR', async () => {
    const gray = await toGrayscale(makeQrLikeImage(8, true));
    const result = detectQrCode(gray!);
    expect(result.detected).toBe(true);
    expect(result.patterns).toBeGreaterThanOrEqual(2);
  });

  test('detecte aussi un QR sans modules de donnees', async () => {
    const gray = await toGrayscale(makeQrLikeImage(10, false));
    expect(detectQrCode(gray!).detected).toBe(true);
  });

  test('ne se declenche pas sur une image ordinaire', async () => {
    const gray = await toGrayscale(makePhotoLikeImage(2));
    expect(detectQrCode(gray!).detected).toBe(false);
  });

  test('ne se declenche pas sur une image unie', async () => {
    const canvas = createCanvas(300, 300);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#404040';
    ctx.fillRect(0, 0, 300, 300);
    const gray = await toGrayscale(canvas.toBuffer('image/png'));
    expect(detectQrCode(gray!).detected).toBe(false);
  });

  test('ignore les images trop petites pour porter un QR', async () => {
    const canvas = createCanvas(20, 20);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 20, 20);
    const gray = await toGrayscale(canvas.toBuffer('image/png'));
    expect(detectQrCode(gray!).detected).toBe(false);
  });
});

describe('analyzeImage', () => {
  test('renvoie empreinte et verdict QR', async () => {
    const analysis = await analyzeImage(makeQrLikeImage(8, true));
    expect(analysis).not.toBeNull();
    expect(analysis!.phash).toHaveLength(16);
    expect(analysis!.qr.detected).toBe(true);
  });

  test('renvoie null sur un contenu illisible plutot que de lever', async () => {
    // Un fichier corrompu ne doit pas faire echouer la moderation du message.
    expect(await analyzeImage(Buffer.from('ceci n est pas une image'))).toBeNull();
  });
});

// ── Empreinte Kotbo Vision v2 ──────────────────────────────────────────────────────

/** Capture d'arnaque synthétique : bandeau, cartes colorées, texte. */
function makeScamLikeImage(seed: number): Buffer {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const canvas = createCanvas(480, 600);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${r() * 360}, 50%, 25%)`;
  ctx.fillRect(0, 0, 480, 600);
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = `hsl(${r() * 360}, 65%, ${35 + r() * 40}%)`;
    ctx.fillRect(r() * 400, r() * 520, 40 + r() * 200, 30 + r() * 160);
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText(`BONUS ${Math.floor(r() * 9000)}$`, 30, 300);
  return canvas.toBuffer('image/png');
}

async function transformed(buffer: Buffer, draw: (ctx: Ctx, img: Awaited<ReturnType<typeof loadImage>>) => void, size?: [number, number]): Promise<Buffer> {
  const img = await loadImage(buffer);
  const canvas = createCanvas(size?.[0] ?? img.width, size?.[1] ?? img.height);
  draw(canvas.getContext('2d'), img);
  return canvas.encode('jpeg', 70);
}

describe('empreinte Kotbo Vision v2', () => {
  test('la sérialisation fait un aller-retour exact', async () => {
    const analysis = await analyzeImage(makeScamLikeImage(3));
    const text = serializeFingerprint(analysis!.fingerprint);
    expect(serializeFingerprint(parseFingerprint(text)!)).toBe(text);
    expect(parseFingerprint('v1;nimporte;quoi')).toBeNull();
  });

  test('reconnaît avec certitude une recompression, une bordure et un miroir', async () => {
    const original = makeScamLikeImage(7);
    const known = (await analyzeImage(original))!.fingerprint;

    const recompressed = await transformed(original, (ctx, img) => ctx.drawImage(img, 0, 0));
    const bordered = await transformed(original, (ctx, img) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 640, 800);
      ctx.drawImage(img, 80, 100);
    }, [640, 800]);
    const mirrored = await transformed(original, (ctx, img) => {
      ctx.translate(img.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
    });

    for (const variant of [recompressed, bordered, mirrored]) {
      const fp = (await analyzeImage(variant))!.fingerprint;
      expect(compareFingerprints(fp, known).verdict).toBe('CERTAIN');
    }
  });

  test('ne confond pas deux images sans rapport', async () => {
    const a = (await analyzeImage(makeScamLikeImage(11)))!.fingerprint;
    for (const seed of [12, 13, 14, 15]) {
      const b = (await analyzeImage(makeScamLikeImage(seed)))!.fingerprint;
      expect(compareFingerprints(a, b).verdict).toBeNull();
    }
  });

  test('neutralise une image unie, dont les hash sont dégénérés', async () => {
    const canvas = createCanvas(300, 300);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(0, 0, 300, 300);
    const flat = (await analyzeImage(canvas.toBuffer('image/png')))!.fingerprint;
    expect(flat.flat).toBe(true);
    expect(compareFingerprints(flat, flat).verdict).toBeNull();
  });

  test('retrouve une image incrustée dans une capture plus large', async () => {
    const original = makeScamLikeImage(21);
    const known = (await analyzeImage(original))!.fingerprint;
    const screenshot = await transformed(original, (ctx, img) => {
      ctx.fillStyle = '#313338';
      ctx.fillRect(0, 0, 600, 1100);
      ctx.fillStyle = '#dbdee1';
      ctx.font = '20px sans-serif';
      for (let i = 0; i < 10; i++) ctx.fillText(`message ${i}`, 10, 30 + i * 26);
      ctx.drawImage(img, 60, 300);
    }, [600, 1100]);
    const gray = (await analyzeImage(screenshot))!.gray;
    const windows = computeWindowHashes(gray, windowShapesFor([known.rawAspect]));
    expect(compareWindows(windows, known).verdict).not.toBeNull();
  });

  test('compare une entrée v1 (dHash seul) à une empreinte v2', async () => {
    const analysis = (await analyzeImage(makeScamLikeImage(31)))!;
    const legacy = parseLegacyHash(analysis.phash)!;
    expect(compareWithLegacy(analysis.fingerprint, legacy).verdict).toBe('CERTAIN');
  });
});

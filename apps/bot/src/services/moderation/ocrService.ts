/**
 * ocrService.ts - Lecture du texte des images, entièrement locale.
 *
 * Le hash d'une capture d'arnaque casse dès qu'elle est photographiée, recadrée
 * ou recompressée ; son texte, lui, reste (« Withdrawal Success », nom de
 * domaine, code promo). On le lit avec Tesseract (WASM, données de langue
 * embarquées) : aucune image ne quitte le serveur.
 *
 * Coût : un worker résident pèse plusieurs dizaines de Mo et une lecture prend
 * de l'ordre de la demi-seconde de CPU. On borne donc tout :
 *  - un seul worker, les lectures sont mises en file ;
 *  - file courte : au-delà, on abandonne la lecture plutôt que d'accumuler un
 *    retard pendant un raid (la modération par hash/domaine continue de jouer) ;
 *  - le worker est arrêté après quelques minutes d'inactivité.
 */

import { createRequire } from 'node:module';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createWorker, type Worker } from 'tesseract.js';
import pLimit from 'p-limit';
import { logger } from '../../utils/logger.js';

const require = createRequire(import.meta.url);

const MAX_QUEUED = 6;
const RECOGNIZE_TIMEOUT_MS = 10_000;
const WORKER_IDLE_MS = 5 * 60 * 1000;
/** Au-delà, la précision gagnée ne vaut pas le temps de lecture. */
const MAX_OCR_WIDTH = 1600;
/** En dessous, il n'y a rien de lisible (avatar, emoji, miniature). */
const MIN_OCR_SIDE = 80;
/** Sortie bornée : le texte d'une capture n'a pas besoin de plus. */
const MAX_TEXT_LENGTH = 4000;

const queue = pLimit(1);
let workerPromise: Promise<Worker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let pending = 0;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const data = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };
    workerPromise = createWorker('eng', 1, {
      langPath: data.langPath,
      gzip: data.gzip,
      // Sans cachePath explicite, tesseract.js écrit les données dans le cwd.
      cacheMethod: 'none',
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const current = workerPromise;
    workerPromise = null;
    idleTimer = null;
    current?.then((w) => w.terminate()).catch(() => null);
  }, WORKER_IDLE_MS);
  // Ne retient pas le process à l'arrêt.
  idleTimer.unref?.();
}

/**
 * Prépare l'image pour la lecture : niveaux de gris, étirement du contraste,
 * inversion des fonds sombres. Les captures d'arnaque sont souvent des photos
 * d'écran en thème sombre, où le texte clair sur fond noir se lit mal.
 */
export async function prepareForOcr(buffer: Buffer): Promise<Buffer | null> {
  try {
    const image = await loadImage(buffer);
    if (image.width < MIN_OCR_SIDE || image.height < MIN_OCR_SIDE) return null;

    const scale = Math.min(1, MAX_OCR_WIDTH / image.width);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;
    const pixels = width * height;
    const gray = new Uint8Array(pixels);
    const histogram = new Array<number>(256).fill(0);
    let sum = 0;

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const value = (data[i] * 77 + data[i + 1] * 151 + data[i + 2] * 28) >> 8;
      gray[p] = value;
      histogram[value]++;
      sum += value;
    }

    // Étirement entre les 2e et 98e percentiles : ignore les pixels isolés.
    const percentile = (ratio: number) => {
      const target = pixels * ratio;
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += histogram[v];
        if (acc >= target) return v;
      }
      return 255;
    };
    const low = percentile(0.02);
    const high = Math.max(percentile(0.98), low + 1);
    const invert = sum / pixels < 110;

    for (let p = 0, i = 0; p < pixels; p++, i += 4) {
      let v = Math.round(((gray[p] - low) / (high - low)) * 255);
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (invert) v = 255 - v;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.debug('OCR', `Préparation impossible: ${String(err)}`);
    return null;
  }
}

async function recognize(prepared: Buffer): Promise<string | null> {
  const worker = await getWorker();
  const result = await Promise.race([
    worker.recognize(prepared),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RECOGNIZE_TIMEOUT_MS).unref?.()),
  ]);

  if (result === null) {
    // Un worker bloqué est jeté : le suivant repartira d'un worker neuf.
    logger.warn('OCR', 'Lecture trop longue, worker recréé');
    const stuck = workerPromise;
    workerPromise = null;
    stuck?.then((w) => w.terminate()).catch(() => null);
    return null;
  }

  return result.data.text.slice(0, MAX_TEXT_LENGTH);
}

/**
 * Lit le texte d'une image. Retourne null si l'image est illisible, trop
 * petite, si la file est pleine ou si l'OCR est indisponible : l'appelant doit
 * traiter l'absence de texte comme « pas d'information », jamais comme « sain ».
 */
export async function readImageText(buffer: Buffer): Promise<string | null> {
  if (pending >= MAX_QUEUED) {
    logger.debug('OCR', 'File pleine, lecture ignorée');
    return null;
  }

  pending++;
  try {
    return await queue(async () => {
      const prepared = await prepareForOcr(buffer);
      if (!prepared) return null;
      try {
        return await recognize(prepared);
      } finally {
        scheduleIdleShutdown();
      }
    });
  } catch (err) {
    logger.error('OCR', 'Lecture impossible', err);
    return null;
  } finally {
    pending--;
  }
}

/** Arrête le worker (tests, arrêt propre). */
export async function shutdownOcr(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const current = workerPromise;
  workerPromise = null;
  await current?.then((w) => w.terminate()).catch(() => null);
}

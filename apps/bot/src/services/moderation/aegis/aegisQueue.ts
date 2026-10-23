/**
 * File d'attente des analyses AegisAI.
 *
 * Chaque message coûte un appel (`/scan`) à une API dont la capacité est
 * bornée et appelée à grandir. Les messages ne sont donc jamais notés sur le
 * chemin de `MessageCreate` : ils entrent ici et sortent dans l'ordre
 * d'arrivée (FIFO).
 *
 * La concurrence n'est pas figée : un régulateur (`nextConcurrency`) ajoute
 * un appel en parallèle tant qu'il reste du retard et que l'API répond vite,
 * et divise par deux dès qu'elle ralentit ou renvoie 429/5xx. Si la capacité
 * de l'API augmente, le débit suit sans rien reconfigurer.
 *
 * Au-delà d'un plafond, plus rien n'entre. Un message noté trop tard n'est
 * plus supprimé d'office : il part en revue (voir `isLate`).
 *
 * BullMQ quand Redis répond : la file survit à un redéploiement. Sinon une
 * file en mémoire, mêmes règles.
 */
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisForWorker } from '../../../infra/redis.js';
import { logger } from '../../../utils/logger.js';
import { getAegisClient } from './aegisClient.js';

export type AegisJobSource = 'MESSAGE' | 'EDIT' | 'NICKNAME';

export type AegisJob = {
  source: AegisJobSource;
  guildId: string;
  /** Salon du message (le fil lui-même pour un fil). */
  channelId: string;
  /** Salon de rattachement des statistiques (le parent pour un fil). */
  statsChannelId: string;
  messageId: string | null;
  authorId: string;
  /** Texte préparé (aegisText.prepareText). */
  text: string;
  /** Extrait brut, conservé si une détection est créée. */
  excerpt: string;
  /** Membre visé : auteur du message auquel on répond, ou unique mention. */
  targetUserId: string | null;
  /**
   * Administrateur, rôle ou salon exempté : le message est noté comme les
   * autres, mais le bot n'agit jamais seul, le staff tranche.
   */
  exempt: boolean;
  /** Le message compte dans les statistiques (collecte Analytics autorisée). */
  countStats: boolean;
  enqueuedAt: number;
};

export type AegisProcessor = (job: AegisJob) => Promise<void>;

export type EnqueueOutcome = 'queued' | 'dropped';

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const QUEUE_LIMITS = {
  /** Concurrence de départ, puis ajustée entre 1 et `maxConcurrency`. */
  concurrency: readPositiveInt(process.env.AEGISAI_CONCURRENCY, 2),
  maxConcurrency: readPositiveInt(process.env.AEGISAI_MAX_CONCURRENCY, 32),
  /** Latence médiane visée : en dessous, on peut ajouter un appel en parallèle. */
  targetLatencyMs: readPositiveInt(process.env.AEGISAI_TARGET_LATENCY_MS, 300),
  /** Au-delà, plus rien n'entre. */
  maxDepth: readPositiveInt(process.env.AEGISAI_QUEUE_MAX, 5000),
  /** Âge au-delà duquel une note ne déclenche plus d'action automatique. */
  staleMs: readPositiveInt(process.env.AEGISAI_STALE_MS, 120_000),
};

/** Note arrivée trop tard pour supprimer le message sans dérouter le salon. */
export function isLate(job: Pick<AegisJob, 'enqueuedAt'>, now = Date.now()): boolean {
  return now - job.enqueuedAt > QUEUE_LIMITS.staleMs;
}

/** Décide du sort d'un job selon la profondeur de la file. Pur, pour les tests. */
export function admitJob(depth: number, limits = QUEUE_LIMITS): EnqueueOutcome {
  return depth >= limits.maxDepth ? 'dropped' : 'queued';
}

export type ConcurrencyWindow = { requests: number; p50Ms: number | null; overloaded: number };

/**
 * Concurrence suivante. Pur, pour les tests.
 * - surcharge (429, 5xx, délais) ou latence au double de la cible : moitié ;
 * - latence au-dessus de la cible : un de moins ;
 * - retard en file et latence sous la cible : un de plus ;
 * - sinon : inchangé (inutile de grimper quand la file est vide).
 */
export function nextConcurrency(current: number, window: ConcurrencyWindow, depth: number, limits = QUEUE_LIMITS): number {
  const max = Math.max(1, limits.maxConcurrency);
  if (window.overloaded > 0 || (window.p50Ms !== null && window.p50Ms > limits.targetLatencyMs * 2)) {
    return Math.max(1, Math.floor(current / 2));
  }
  if (window.p50Ms !== null && window.p50Ms > limits.targetLatencyMs) return Math.max(1, current - 1);
  if (depth > 0 && window.requests > 0 && window.p50Ms !== null) return Math.min(max, current + 1);
  return Math.min(max, current);
}

export type AegisQueueStats = {
  backend: 'redis' | 'memory' | 'stopped';
  depth: number;
  active: number;
  concurrency: number;
  processed: number;
  failed: number;
  dropped: number;
};

const counters = { processed: 0, failed: 0, dropped: 0 };

// ── Backend mémoire ──────────────────────────────────────────────────────────

class MemoryQueue {
  private jobs: AegisJob[] = [];
  private active = 0;

  constructor(private readonly processor: AegisProcessor, public concurrency: number) {}

  get depth(): number {
    return this.jobs.length;
  }

  get running(): number {
    return this.active;
  }

  push(job: AegisJob): void {
    this.jobs.push(job);
    this.pump();
  }

  setConcurrency(value: number): void {
    this.concurrency = value;
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const job = this.jobs.shift();
      if (!job) return;
      this.active += 1;
      void this.processor(job)
        .then(() => { counters.processed += 1; })
        .catch((error) => {
          counters.failed += 1;
          logger.warn('AegisQueue', 'Analyse en échec :', error);
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}

// ── Backend Redis ────────────────────────────────────────────────────────────

const QUEUE_NAME = 'kotbo-aegis';
const DEPTH_REFRESH_MS = 1000;

let processorRef: AegisProcessor | null = null;
let memory: MemoryQueue | null = null;
let queue: Queue<AegisJob> | null = null;
let worker: Worker<AegisJob> | null = null;
let connections: Redis[] = [];
let redisDepth = 0;
let depthTimer: ReturnType<typeof setInterval> | null = null;
let regulatorTimer: ReturnType<typeof setInterval> | null = null;
let concurrency = QUEUE_LIMITS.concurrency;
const REGULATOR_INTERVAL_MS = 5000;

function applyConcurrency(value: number): void {
  if (value === concurrency) return;
  logger.debug('AegisQueue', `Concurrence ${concurrency} → ${value}`);
  concurrency = value;
  memory?.setConcurrency(value);
  if (worker) worker.concurrency = value;
}

function startRegulator(): void {
  regulatorTimer = setInterval(() => {
    applyConcurrency(nextConcurrency(concurrency, getAegisClient().takeWindow(), aegisQueueDepth()));
  }, REGULATOR_INTERVAL_MS);
  if (typeof regulatorTimer.unref === 'function') regulatorTimer.unref();
}

async function refreshRedisDepth(): Promise<void> {
  if (!queue) return;
  try {
    redisDepth = await queue.getWaitingCount();
  } catch {
    // Profondeur inconnue un instant : on garde la dernière lue.
  }
}

async function startRedisBackend(processor: AegisProcessor): Promise<boolean> {
  const queueConnection = createRedisForWorker();
  const workerConnection = createRedisForWorker();
  if (!queueConnection || !workerConnection) return false;
  try {
    await queueConnection.connect();
    await workerConnection.connect();
    queue = new Queue<AegisJob>(QUEUE_NAME, {
      connection: queueConnection,
      // Le texte d'un message n'a rien à faire dans Redis une fois noté.
      defaultJobOptions: { removeOnComplete: true, removeOnFail: 100, attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
    });
    worker = new Worker<AegisJob>(
      QUEUE_NAME,
      async (job: Job<AegisJob>) => processor(job.data),
      // Le traitement attend l'API quand le coupe-circuit est ouvert (30 s) :
      // le verrou doit tenir plus longtemps pour ne pas passer pour bloqué.
      { connection: workerConnection, concurrency, lockDuration: 90_000 },
    );
    worker.on('completed', () => { counters.processed += 1; });
    worker.on('failed', (_job, error) => {
      counters.failed += 1;
      logger.warn('AegisQueue', 'Analyse en échec :', error);
    });
    connections = [queueConnection, workerConnection];
    depthTimer = setInterval(() => void refreshRedisDepth(), DEPTH_REFRESH_MS);
    if (typeof depthTimer.unref === 'function') depthTimer.unref();
    return true;
  } catch (error) {
    logger.warn('AegisQueue', 'File Redis indisponible, repli en mémoire :', error);
    await worker?.close().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    worker = null;
    queue = null;
    queueConnection.disconnect();
    workerConnection.disconnect();
    return false;
  }
}

// ── API ──────────────────────────────────────────────────────────────────────

/** Démarre la file. Le processeur est celui d'aegisProcessor.ts. */
export async function startAegisQueue(processor: AegisProcessor): Promise<void> {
  if (processorRef) return;
  processorRef = processor;
  startRegulator();
  if (await startRedisBackend(processor)) {
    logger.success('AegisQueue', `File AegisAI sur Redis (concurrence auto, ${concurrency} au départ, ${QUEUE_LIMITS.maxConcurrency} au plus).`);
    return;
  }
  memory = new MemoryQueue(processor, concurrency);
  logger.info('AegisQueue', `File AegisAI en mémoire (concurrence auto, ${concurrency} au départ, ${QUEUE_LIMITS.maxConcurrency} au plus).`);
}

export async function stopAegisQueue(): Promise<void> {
  if (depthTimer) clearInterval(depthTimer);
  if (regulatorTimer) clearInterval(regulatorTimer);
  depthTimer = null;
  regulatorTimer = null;
  await worker?.close().catch(() => undefined);
  await queue?.close().catch(() => undefined);
  for (const connection of connections) connection.disconnect();
  connections = [];
  worker = null;
  queue = null;
  memory = null;
  processorRef = null;
}

export function aegisQueueDepth(): number {
  if (queue) return redisDepth;
  return memory?.depth ?? 0;
}

export async function enqueueAegisJob(job: AegisJob): Promise<EnqueueOutcome> {
  if (!processorRef) return 'dropped';
  if (admitJob(aegisQueueDepth()) === 'dropped') {
    counters.dropped += 1;
    return 'dropped';
  }

  if (queue) {
    try {
      await queue.add(job.source, job);
      redisDepth += 1;
      return 'queued';
    } catch (error) {
      logger.warn('AegisQueue', 'Enfilage Redis impossible, traitement en mémoire :', error);
      memory ??= new MemoryQueue(processorRef, concurrency);
    }
  }
  memory?.push(job);
  return 'queued';
}

export async function getAegisQueueStats(): Promise<AegisQueueStats> {
  let active = memory?.running ?? 0;
  if (queue) active += await queue.getActiveCount().catch(() => 0);
  return {
    backend: queue ? 'redis' : memory ? 'memory' : 'stopped',
    depth: aegisQueueDepth(),
    active,
    concurrency,
    ...counters,
  };
}

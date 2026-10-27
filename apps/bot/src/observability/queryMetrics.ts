import { logger } from '../utils/logger.js';

/**
 * Mesure du coût réel de chaque requête Prisma.
 *
 * Le dépôt compte plus de trois mille appels Prisma et aucune trace de leur
 * durée : jusqu'ici, décider quoi optimiser relevait de l'intuition. On
 * enveloppe donc toutes les opérations pour accumuler un profil par
 * modèle+opération, et pour signaler celles qui dépassent un seuil.
 *
 * L'enveloppe coûte deux lectures d'horloge et un accès à une Map par requête,
 * soit un ordre de grandeur en dessous d'un aller-retour réseau vers Postgres.
 * Elle reste donc active en production, où sont précisément les requêtes qu'on
 * cherche à voir.
 */

export interface QueryStat {
  /** `modèle.opération`, ex. `guild.findUnique`. */
  key: string;
  count: number;
  totalMs: number;
  maxMs: number;
  /** Nombre d'exécutions au-delà de `SLOW_QUERY_MS`. */
  slowCount: number;
  errorCount: number;
}

const stats = new Map<string, QueryStat>();

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Seuil au-delà duquel une requête est journalisée individuellement. */
const SLOW_QUERY_MS = parsePositiveInt(process.env.SLOW_QUERY_MS, 200);

/**
 * Une requête lente l'est rarement une seule fois : sans plafond, un modèle
 * mal indexé noie le journal sous des milliers de lignes identiques. On ne
 * journalise donc qu'une fois par intervalle et par `modèle.opération`, le
 * compteur `slowCount` conservant la mesure exhaustive.
 */
const SLOW_LOG_COOLDOWN_MS = parsePositiveInt(process.env.SLOW_QUERY_LOG_COOLDOWN_MS, 60_000);
const lastSlowLogAt = new Map<string, number>();

/** Vue minimale d'un `pg.Pool`, pour ne pas importer `pg` ici. */
interface PoolCounters {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options: { max?: number };
}

let trackedPool: PoolCounters | null = null;

/**
 * Le chronomètre englobe l'attente d'une connexion libre : sans l'état du pool
 * dans le message, une requête lente parce que les 30 connexions étaient prises
 * ne se distingue pas d'une requête lente parce que mal indexée.
 */
export function trackQueryPool(pool: PoolCounters): void {
  trackedPool = pool;
}

function describePool(): string {
  if (!trackedPool) return '';
  const busy = trackedPool.totalCount - trackedPool.idleCount;
  return `, pool ${busy}/${trackedPool.options.max ?? '?'} occupées, ${trackedPool.waitingCount} en attente`;
}

/**
 * Le nombre de couples modèle+opération est borné par le schéma (280 modèles,
 * une poignée d'opérations chacun), mais une clé inattendue ne doit pas pouvoir
 * faire croître la Map indéfiniment.
 */
const MAX_TRACKED_KEYS = 5_000;

function record(key: string, durationMs: number, failed: boolean): void {
  let stat = stats.get(key);
  if (!stat) {
    if (stats.size >= MAX_TRACKED_KEYS) return;
    stat = { key, count: 0, totalMs: 0, maxMs: 0, slowCount: 0, errorCount: 0 };
    stats.set(key, stat);
  }

  stat.count += 1;
  stat.totalMs += durationMs;
  if (durationMs > stat.maxMs) stat.maxMs = durationMs;
  if (failed) stat.errorCount += 1;

  if (durationMs < SLOW_QUERY_MS) return;

  stat.slowCount += 1;

  const now = Date.now();
  const lastLoggedAt = lastSlowLogAt.get(key) ?? 0;
  if (now - lastLoggedAt < SLOW_LOG_COOLDOWN_MS) return;

  lastSlowLogAt.set(key, now);
  logger.warn(
    'Prisma',
    `Requête lente: ${key} a pris ${Math.round(durationMs)}ms (seuil ${SLOW_QUERY_MS}ms, ${stat.slowCount} dépassement(s) cumulé(s)${describePool()}).`,
  );
}

/**
 * Extension Prisma à appliquer via `$extends`.
 *
 * On passe par `$allOperations` plutôt que par l'évènement `query` : avec les
 * driver adapters, cet évènement rapporte le SQL émis mais pas le modèle ni
 * l'opération Prisma appelante, ce qui rend le résultat inexploitable pour
 * remonter jusqu'au code fautif.
 */
export const queryMetricsExtension = {
  name: 'kotbo-query-metrics',
  query: {
    $allOperations: async ({ model, operation, args, query }: {
      model?: string;
      operation: string;
      args: unknown;
      query: (args: unknown) => Promise<unknown>;
    }) => {
      const key = `${model ?? 'raw'}.${operation}`;
      const startedAt = performance.now();
      try {
        const result = await query(args);
        record(key, performance.now() - startedAt, false);
        return result;
      } catch (error) {
        record(key, performance.now() - startedAt, true);
        throw error;
      }
    },
  },
} as const;

/**
 * Profil accumulé depuis le démarrage, du plus coûteux au moins coûteux.
 *
 * Le tri porte sur le temps cumulé et non sur la durée maximale : une requête
 * de 20ms appelée cent mille fois pèse davantage sur la latence ressentie
 * qu'un rapport mensuel de deux secondes.
 */
export function getQueryStats(limit = 50): QueryStat[] {
  return [...stats.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit)
    .map((stat) => ({ ...stat }));
}

export function resetQueryStats(): void {
  stats.clear();
  lastSlowLogAt.clear();
}

/**
 * Les lectures marquées `prismaRead` sont-elles réellement déportées ?
 *
 * Le drapeau est lu ici plutôt qu'exporté par `utils/db`, dont les tests
 * remplacent le module par un double : y ajouter un export obligerait chaque
 * double à le reproduire, et transformerait un simple indicateur en piège pour
 * tout test futur.
 */
export function isReadReplicaConfigured(): boolean {
  return Boolean(process.env.DATABASE_READ_REPLICA_URL);
}

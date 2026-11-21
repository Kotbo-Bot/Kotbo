import Redis, { Cluster } from 'ioredis';
import type { RedisOptions, ClusterOptions, ClusterNode } from 'ioredis';
import { logger } from '../utils/logger.js';

type RedisLike = Redis | Cluster;

let sharedRedis: RedisLike | null = null;
let clusterMode = false;

/**
 * Redis absent de la configuration : etat definitif, et parfaitement legitime.
 * Le bot sait tourner sans cache.
 */
let redisUnconfigured = false;

/**
 * Instant avant lequel on ne retente pas de se connecter.
 *
 * Un echec de connexion condamnait Redis pour toute la duree du process :
 * `redisDisabled` passait a `true` et plus rien ne repassait jamais par la.
 * Un Redis qui demarre deux secondes apres le bot, ou qui redemarre une fois,
 * laissait donc le cache eteint jusqu'au prochain deploiement, sans que rien
 * ne le signale. L'indisponibilite est desormais temporaire : on laisse
 * passer un delai avant de retenter, pour ne pas marteler un service absent.
 */
let retryConnectionAfter = 0;

/** Delai avant une nouvelle tentative de connexion apres un echec. */
const RECONNECT_COOLDOWN_MS = 30_000;

function getRedisConnectionInput(): { url?: string; host?: string; port?: number; password?: string } {
  const url = process.env.REDIS_URL;
  if (url) return { url };

  const host = process.env.REDIS_HOST;
  if (!host) return {};

  const port = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
  const password = process.env.REDIS_PASSWORD;
  return { host, port: Number.isNaN(port) ? 6379 : port, password };
}

function parseClusterNodes(): ClusterNode[] | null {
  const raw = process.env.REDIS_CLUSTER_NODES;
  if (!raw) return null;

  return raw.split(',').map((node) => {
    const [host, portStr] = node.trim().split(':');
    return { host: host || '127.0.0.1', port: Number.parseInt(portStr || '6379', 10) };
  });
}

function buildRedisOptions(extra?: RedisOptions): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableReadyCheck: true,
    ...extra,
  };
}

function createClient(extra?: RedisOptions): Redis | null {
  const conn = getRedisConnectionInput();

  if (!conn.url && !conn.host) {
    return null;
  }

  if (conn.url) {
    return new Redis(conn.url, buildRedisOptions(extra));
  }

  return new Redis({
    host: conn.host,
    port: conn.port,
    password: conn.password,
    ...buildRedisOptions(extra),
  });
}

function createCluster(extra?: Partial<ClusterOptions>): Cluster | null {
  const nodes = parseClusterNodes();
  if (!nodes || nodes.length === 0) return null;

  const password = process.env.REDIS_PASSWORD;

  return new Cluster(nodes, {
    redisOptions: {
      password: password || undefined,
      maxRetriesPerRequest: null,
      ...extra?.redisOptions,
    },
    lazyConnect: true,
    enableReadyCheck: true,
    scaleReads: 'slave',
    ...extra,
  });
}

/**
 * Rend visibles les coupures d'un client deja connecte.
 *
 * ioredis se reconnecte tout seul et n'en dit rien : une coupure de plusieurs
 * minutes passait sans une ligne de journal, et les caches manques
 * ressemblaient a des donnees froides. Sans ecouteur sur `error`, Node traite
 * en plus l'evenement comme une exception non geree.
 */
function attachLifecycleLogging(client: RedisLike, label: string) {
  client.on('error', (err: Error) => {
    logger.error('Redis', `${label}: erreur de connexion:`, err);
  });
  client.on('end', () => {
    logger.warn('Redis', `${label}: connexion fermée, tentative de reconnexion automatique.`);
  });
  client.on('reconnecting', () => {
    logger.debug('Redis', `${label}: reconnexion en cours...`);
  });
  client.on('ready', () => {
    logger.info('Redis', `${label}: connexion rétablie.`);
  });
}

export async function initRedis(): Promise<RedisLike | null> {
  if (sharedRedis) return sharedRedis;
  if (redisUnconfigured) return null;
  if (Date.now() < retryConnectionAfter) return null;

  // Cluster mode takes priority
  const cluster = createCluster();
  if (cluster) {
    try {
      await cluster.connect();
      await cluster.ping();
      attachLifecycleLogging(cluster, 'Cluster');
      sharedRedis = cluster;
      clusterMode = true;
      logger.success('Redis', `Connexion Redis Cluster établie (${parseClusterNodes()!.length} noeud(s)).`);
      return sharedRedis;
    } catch (error) {
      logger.error('Redis', 'Impossible de se connecter au Cluster Redis:', error);
      cluster.disconnect();
    }
  }

  // Fallback: single node
  const client = createClient();
  if (!client) {
    redisUnconfigured = true;
    logger.warn('Redis', 'Redis désactivé: REDIS_URL/REDIS_HOST absent.');
    return null;
  }

  try {
    await client.connect();
    await client.ping();
    attachLifecycleLogging(client, 'Single node');
    sharedRedis = client;
    clusterMode = false;
    logger.success('Redis', 'Connexion Redis (single node) établie.');
    return sharedRedis;
  } catch (error) {
    retryConnectionAfter = Date.now() + RECONNECT_COOLDOWN_MS;
    logger.error(
      'Redis',
      `Connexion à Redis impossible, nouvelle tentative dans ${RECONNECT_COOLDOWN_MS / 1000}s:`,
      error,
    );
    client.disconnect();
    return null;
  }
}

export function createRedisForWorker(): Redis | null {
  if (redisUnconfigured) return null;
  return createClient({
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export function getRedis(): RedisLike | null {
  return sharedRedis;
}

export function isClusterMode(): boolean {
  return clusterMode;
}

export async function assertRedisConnection(): Promise<void> {
  const client = sharedRedis ?? await initRedis();
  if (!client) {
    throw new Error(
      'Redis indisponible - BullMQ requiert une connexion Redis active. ' +
      'Configurez REDIS_URL ou REDIS_HOST (ou REDIS_CLUSTER_NODES pour le mode cluster).'
    );
  }
  try {
    await client.ping();
  } catch (err) {
    throw new Error(`Redis indisponible - ping échoué: ${String(err)}`);
  }
}

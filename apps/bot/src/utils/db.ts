import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { queryMetricsExtension } from '../observability/queryMetrics.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.resolve(currentDir, '../../../../.env') });
loadEnv({ path: path.resolve(currentDir, '../../.env') });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL non défini. Vérifie ton fichier .env.');
}

const poolSize = Number.parseInt(process.env.DATABASE_POOL_SIZE ?? '30', 10) || 30;

// `pg` ferme par defaut une connexion inactive au bout de 10 s : sur un bot peu
// sollicite, presque chaque rafale de requetes rouvrait alors ses connexions
// (TCP puis authentification), ce qui coute bien plus cher que la requete.
const POOL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const adapter = new PrismaPg({ connectionString, max: poolSize, idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS });

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/**
 * `$extends` renvoie un client dont le type diffère de `PrismaClient` (il perd
 * `$on` et `$use`, inutilisés ici). Sans la conversion, les quelque 3 000
 * appelants annotés `PrismaClient` cesseraient de compiler pour un changement
 * purement interne : on rétablit donc le type nominal.
 */
function withInstrumentation(client: PrismaClient): PrismaClient {
  return client.$extends(queryMetricsExtension) as unknown as PrismaClient;
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ||
  withInstrumentation(
    new PrismaClient({
      adapter,
      log: process.env.LOG_LEVEL === 'debug' ? ['error', 'warn'] : ['error'],
    }),
  );

// Diagnostic log to see what models are actually loaded at runtime
if (process.env.NODE_ENV !== 'production') {
  const models = Object.keys(prisma).filter(k => !k.startsWith('_') && !k.startsWith('$'));
  console.log("[Prisma Startup Diagnostics] Loaded Models:", models);
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Read replica for dashboard/analytics queries (heavy reads that shouldn't
// block the primary write pool). Falls back to the primary if not configured.
const readReplicaUrl = process.env.DATABASE_READ_REPLICA_URL;
const globalForReadReplica = globalThis as unknown as { prismaReadReplica: PrismaClient };

/**
 * `prismaRead` compte plus de deux cents appelants, tous écrits en supposant
 * qu'ils déchargent la primaire. Sans `DATABASE_READ_REPLICA_URL`, ils tapent
 * en réalité le même pool que les écritures, et l'intention se perd sans
 * qu'aucun symptôme ne la trahisse : les lectures lourdes du tableau de bord
 * continuent simplement de concurrencer les écritures du bot. On rend donc
 * l'absence de réplica explicite au démarrage.
 */
export const prismaRead: PrismaClient = readReplicaUrl
  ? (globalForReadReplica.prismaReadReplica ||
    (() => {
      const readPoolSize = Number.parseInt(process.env.DATABASE_READ_POOL_SIZE ?? '20', 10) || 20;
      const readAdapter = new PrismaPg({
        connectionString: readReplicaUrl,
        max: readPoolSize,
        idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      });
      const client = withInstrumentation(new PrismaClient({
        adapter: readAdapter,
        log: ['error'],
      }));
      if (process.env.NODE_ENV !== 'production') globalForReadReplica.prismaReadReplica = client;
      return client;
    })())
  : prisma;

if (!readReplicaUrl && process.env.NODE_ENV === 'production') {
  console.warn(
    '[Prisma] DATABASE_READ_REPLICA_URL absent : les lectures marquées `prismaRead` ' +
    'partagent le pool de la primaire.',
  );
}

export default prisma;

import { errorMessage } from './utils/errors.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

import { ShardingManager, type PresenceData } from 'discord.js';
import prisma from './utils/db.js';
import { logger } from './utils/logger.js';
import { loadAllInstances, type ResolvedInstance } from './utils/instanceResolver.js';
import { comparePlans, normalizePlanKey } from '@kotbo/contracts';

/**
 * Messages IPC echanges entre le gestionnaire de shards et les shards.
 * Ils traversent une frontiere de processus : tous les champs sont optionnels.
 */
type ShardIpcMessage = {
  type?: string;
  instanceId?: string;
  presence?: PresenceData;
} & Record<string, unknown>;

const activeManagers: ShardingManager[] = [];
// Instances lancées ou arrêtées à chaud (bots perso des serveurs), par identifiant.
const managersByInstance = new Map<string, ShardingManager>();
let shuttingDown = false;
const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.ts');

// `docker stop` laisse 10 s par defaut avant le SIGKILL : on garde une marge
// pour la deconnexion Prisma et la sortie du processus.
const SHUTDOWN_TIMEOUT_MS = 8_000;

/** Bot perso d'un serveur : instance `cb-<serveur>`. */
function customBotGuildId(slug: string): string | null {
  return slug.startsWith('cb-') ? slug.slice(3) : null;
}

async function markCustomBot(guildId: string, data: { isRunning: boolean; lastStartedAt?: Date; lastError: string | null }) {
  await prisma.customBotConfig.updateMany({ where: { guildId }, data }).catch(() => {});
}

function stopInstance(instanceId: string) {
  const manager = managersByInstance.get(instanceId);
  if (!manager) return;
  managersByInstance.delete(instanceId);
  manager.respawn = false;
  for (const shard of manager.shards.values()) {
    if (shard.process) shard.kill();
  }
  const index = activeManagers.indexOf(manager);
  if (index >= 0) activeManagers.splice(index, 1);
  logger.info('CustomBot', `Instance ${instanceId} arrêtée.`);
}

/** (Re)lance une instance enregistrée en base, sans toucher aux autres. */
async function startInstanceById(instanceId: string) {
  stopInstance(instanceId);
  const instance = (await loadAllInstances()).find((i) => i.id === instanceId);
  if (!instance) {
    logger.warn('CustomBot', `Instance ${instanceId} introuvable ou désactivée.`);
    return;
  }
  const guildId = customBotGuildId(instance.slug);
  try {
    await spawnInstance(instance);
    if (guildId) await markCustomBot(guildId, { isRunning: true, lastStartedAt: new Date(), lastError: null });
  } catch (err) {
    logger.error('CustomBot', `Démarrage de l'instance ${instance.slug} impossible :`, err);
    stopInstance(instanceId);
    if (guildId) await markCustomBot(guildId, { isRunning: false, lastError: (errorMessage(err) || 'Démarrage impossible').slice(0, 500) });
  }
}

type ShardingConfig = {
  mode: 'auto' | 'fixed';
  shardCount?: number;
};

// SHARD_COUNT ne concerne que le ShardingManager : discord.js le relit dans
// process.env à chaque `new Client`, et les custom bots créés ici plantaient
// (« shardCount must be >= 1 ») quand il valait "" ou "auto".
const ENV_SHARD_COUNT = process.env.SHARD_COUNT ? Number(process.env.SHARD_COUNT) : undefined;
delete process.env.SHARD_COUNT;

const SHARDING_CONFIG_KEY = 'SHARDING_CONFIG';

async function loadShardingConfig(): Promise<ShardingConfig> {
  try {
    const config = await prisma.botGlobalConfig.findUnique({ where: { key: SHARDING_CONFIG_KEY } });
    if (!config?.value) {
      return { mode: 'auto' };
    }

    const parsed = JSON.parse(config.value) as Partial<ShardingConfig>;
    if (parsed.mode === 'fixed') {
      const shardCount = Number(parsed.shardCount);
      if (Number.isFinite(shardCount) && shardCount > 0) {
        return { mode: 'fixed', shardCount: Math.floor(shardCount) };
      }
    }

    return { mode: 'auto' };
  } catch (error) {
    logger.warn('Sharding', 'Impossible de lire la config de sharding, fallback en auto.', error);
    return { mode: 'auto' };
  }
}

function setupShardListeners(manager: ShardingManager, instanceLabel: string) {
  manager.on('shardCreate', (shard) => {
    logger.info('Sharding', `[${instanceLabel}] Shard ${shard.id} initialisé.`);

    shard.on('spawn', (childProcess) => {
      const pid = 'pid' in childProcess ? childProcess.pid : undefined;
      logger.info('Sharding', `[${instanceLabel}] Processus enfant pour le Shard ${shard.id} démarré (PID: ${pid}).`);

      if ('stdout' in childProcess && childProcess.stdout) {
        childProcess.stdout.on('data', (data: Buffer) => {
          process.stdout.write(data);
        });
      }

      if ('stderr' in childProcess && childProcess.stderr) {
        childProcess.stderr.on('data', (data: Buffer) => {
          logger.error('Sharding', `[${instanceLabel}][Shard ${shard.id} STDERR] ${data.toString().trim()}`);
        });
      }
    });

    shard.on('death', (childProcess) => {
      if (shuttingDown) return;
      const exitCode = 'exitCode' in childProcess ? childProcess.exitCode : undefined;
      logger.error('Sharding', `[${instanceLabel}] Le Shard ${shard.id} est mort de manière inattendue (Code de sortie: ${exitCode}).`);
    });

    shard.on('message', (message: ShardIpcMessage | null | undefined) => {
      try {
        if (!message || typeof message !== 'object') return;

        if (message.type === 'restart-container') {
          logger.warn('Sharding', `[${instanceLabel}] Redémarrage du conteneur demandé par le shard ${shard.id}.`);
          if (process.env.MANAGER_USE_CONTAINER_RESTART === 'true') {
            process.exit(0);
          }

          void manager.respawnAll().catch((err) => {
            logger.error('Sharding', `[${instanceLabel}] Erreur lors du respawn global :`, err);
          });
          return;
        }

        // Bots perso des serveurs : instances lancées, arrêtées ou mises à jour à chaud.
        if (typeof message.instanceId === 'string') {
          const instanceId = message.instanceId;
          if (message.type === 'custom-instance-start') {
            void startInstanceById(instanceId);
            return;
          }
          if (message.type === 'custom-instance-stop') {
            stopInstance(instanceId);
            return;
          }
          if (message.type === 'custom-instance-presence' && message.presence) {
            void managersByInstance.get(instanceId)
              ?.broadcastEval((c, presence) => { c.user?.setPresence(presence); }, { context: message.presence })
              .catch((err) => logger.warn('CustomBot', `Statut de l'instance ${instanceId} non appliqué :`, err));
            return;
          }
        }

        if (message.type === 'respawn-shard' && Number.isInteger(Number(message.shardId))) {
          const target = Number(message.shardId);
          logger.warn('Sharding', `[${instanceLabel}] Respawn demandé pour le shard ${target} (via shard ${shard.id}).`);
          const targetShard = manager.shards.get(target);
          if (!targetShard) {
            logger.warn('Sharding', `[${instanceLabel}] Respawn impossible : shard ${target} inconnu.`);
            return;
          }
          void targetShard.respawn().catch((err) => {
            logger.error('Sharding', `[${instanceLabel}] Erreur lors du respawn du shard ${target}:`, err);
          });
          return;
        }
      } catch (err) {
        logger.error('Sharding', `[${instanceLabel}] Erreur en traitant le message IPC du shard:`, err);
      }
    });
  });
}

async function spawnInstance(instance: ResolvedInstance): Promise<ShardingManager> {
  const shardingConfig = await loadShardingConfig();
  const label = instance.isDefault ? 'default' : instance.slug;

  const envShardCount = ENV_SHARD_COUNT;
  let totalShards: number | 'auto' = shardingConfig.mode === 'fixed' && shardingConfig.shardCount
    ? shardingConfig.shardCount
    : 'auto';

  if (instance.isDefault && envShardCount && Number.isFinite(envShardCount) && envShardCount > 0) {
    totalShards = Math.floor(envShardCount);
    logger.info('Sharding', `[${label}] SHARD_COUNT override: démarrage en ${totalShards} shard(s).`);
  }

  // White-label instances run with a single shard by default (small communities)
  if (!instance.isDefault && totalShards === 'auto') {
    totalShards = 1;
  }

  const manager = new ShardingManager(workerPath, {
    token: instance.discordToken,
    totalShards,
    respawn: true,
    shardArgs: [`--instance-id=${instance.id}`],
    execArgv: [],
  });

  setupShardListeners(manager, label);
  activeManagers.push(manager);
  managersByInstance.set(instance.id, manager);

  const timeout = process.env.SHARD_READY_TIMEOUT ? Number(process.env.SHARD_READY_TIMEOUT) : 120_000;
  await manager.spawn({ timeout });
  logger.success('Sharding', `[${label}] Bot lancé avec ${manager.totalShards} shard(s) - port API ${instance.apiPort}`);

  return manager;
}

async function main() {
  const instances = await loadAllInstances();

  const defaultInstance = instances.find(i => i.isDefault);
  if (!defaultInstance || !defaultInstance.discordToken) {
    logger.error('Bot', 'DISCORD_TOKEN non défini dans .env !');
    process.exit(1);
  }

  const managers: ShardingManager[] = [];

  // Spawn default instance first
  const defaultManager = await spawnInstance(defaultInstance);
  managers.push(defaultManager);

  // Spawn white-label instances in parallel. Le bot perso d'un serveur repassé
  // sous l'offre Plus pendant l'arrêt n'est pas relancé.
  const customGuildIds = instances.map((i) => customBotGuildId(i.slug)).filter((id): id is string => Boolean(id));
  const eligible = new Set(
    (await prisma.guild.findMany({ where: { id: { in: customGuildIds } }, select: { id: true, plan: true } }).catch(() => []))
      .filter((g) => comparePlans(normalizePlanKey(g.plan), 'PLUS') >= 0)
      .map((g) => g.id),
  );
  const wlInstances = instances.filter((i) => {
    if (i.isDefault) return false;
    const guildId = customBotGuildId(i.slug);
    return !guildId || eligible.has(guildId);
  });
  if (wlInstances.length > 0) {
    logger.info('WhiteLabel', `Démarrage de ${wlInstances.length} instance(s) white-label...`);

    const results = await Promise.allSettled(
      wlInstances.map(inst => spawnInstance(inst))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        managers.push(result.value);
      } else {
        logger.error('WhiteLabel', `Impossible de démarrer l'instance "${wlInstances[i].name}" (${wlInstances[i].slug}):`, result.reason);
        const guildId = customBotGuildId(wlInstances[i].slug);
        if (guildId) await markCustomBot(guildId, { isRunning: false, lastError: (errorMessage(result.reason) || 'Démarrage impossible').slice(0, 500) });
      }
    }
  }

  logger.success('Sharding', `${managers.length} instance(s) bot démarrée(s) au total.`);
}

/**
 * Sans ce gestionnaire, le launcher ignorait le SIGTERM de `docker stop` (un
 * PID 1 n'a pas de reaction par defaut aux signaux) : Docker attendait 10 s
 * puis tuait tous les shards d'un coup, sans qu'ils vident leurs tampons.
 * `Shard.kill()` envoie SIGTERM au shard, que son propre gestionnaire traite
 * dans index.ts, et le retire du respawn automatique.
 */
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Sharding', `${signal} reçu : arrêt des shards...`);

  const exits: Promise<unknown>[] = [];
  for (const manager of activeManagers) {
    manager.respawn = false;
    for (const shard of manager.shards.values()) {
      const child = shard.process;
      // Un shard mort en attente de respawn n'a plus de processus, et
      // `kill()` planterait en voulant le detacher.
      if (!child) continue;
      if (child.exitCode === null && child.signalCode === null) {
        exits.push(new Promise((resolve) => child.once('exit', resolve)));
      }
      shard.kill();
    }
  }

  await Promise.race([
    Promise.all(exits),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  // Tuer un shard en cours de demarrage fait rejeter `manager.spawn` : c'est
  // alors shutdown() qui doit decider de la sortie, apres l'attente des shards.
  if (shuttingDown) return;
  logger.error('Sharding', 'Impossible de démarrer le manager de sharding.', error);
  process.exit(1);
});

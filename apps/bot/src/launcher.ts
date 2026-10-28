import { errorMessage } from './utils/errors.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

import { ShardingManager, Client, GatewayIntentBits, ActivityType, type ActivitiesOptions, type PresenceStatusData } from 'discord.js';
import prisma from './utils/db.js';
import { logger } from './utils/logger.js';
import { loadAllInstances, type ResolvedInstance } from './utils/instanceResolver.js';
import { openSecret } from './utils/secretBox.js';
import { applyCustomBotProfile } from './services/system/customBotProfile.js';
import { comparePlans, normalizePlanKey } from '@kotbo/contracts';

/**
 * Messages IPC echanges entre le gestionnaire de shards et les shards.
 * Ils traversent une frontiere de processus : tous les champs sont optionnels.
 */
type ShardIpcMessage = {
  type?: string;
  guildId?: string;
  config?: { botToken?: string } & Record<string, unknown>;
} & Record<string, unknown>;

// Custom Bot instances (lightweight clients managed per-guild)
const customBotClients = new Map<string, Client>();

const activeManagers: ShardingManager[] = [];
let shuttingDown = false;

// `docker stop` laisse 10 s par defaut avant le SIGKILL : on garde une marge
// pour la deconnexion Prisma et la sortie du processus.
const SHUTDOWN_TIMEOUT_MS = 8_000;

const STATUS_MAP: Record<string, PresenceStatusData> = {
  ONLINE: 'online', IDLE: 'idle', DND: 'dnd', INVISIBLE: 'invisible',
};

const ACTIVITY_MAP: Record<string, ActivityType> = {
  PLAYING: ActivityType.Playing,
  STREAMING: ActivityType.Streaming,
  LISTENING: ActivityType.Listening,
  WATCHING: ActivityType.Watching,
  COMPETING: ActivityType.Competing,
};

async function startCustomBot(guildId: string, config: {
  botToken: string;
  botStatus?: string;
  activityType?: string;
  activityText?: string;
  activityUrl?: string;
  botName?: string;
  botAvatarUrl?: string;
  botBannerUrl?: string;
  botBio?: string;
  /** Faux à la restauration après redémarrage : Discord limite les changements de profil. */
  applyProfile?: boolean;
}) {
  if (customBotClients.has(guildId)) {
    const existing = customBotClients.get(guildId)!;
    existing.destroy();
    customBotClients.delete(guildId);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('ready', async (c) => {
    logger.success('CustomBot', `[${guildId}] Bot "${c.user.tag}" connecté.`);

    const status = STATUS_MAP[config.botStatus || 'ONLINE'] || 'online';
    const activities: ActivitiesOptions[] = [];

    if (config.activityType && config.activityType !== 'NONE' && config.activityText) {
      activities.push({
        name: config.activityText,
        type: ACTIVITY_MAP[config.activityType] ?? ActivityType.Playing,
        url: config.activityType === 'STREAMING' ? config.activityUrl : undefined,
      });
    }

    c.user.setPresence({ status, activities });

    const profileErrors = config.applyProfile === false ? [] : await applyCustomBotProfile(c, config);
    if (profileErrors.length > 0) logger.warn('CustomBot', `[${guildId}] Profil partiellement appliqué : ${profileErrors.join(' | ')}`);

    await prisma.customBotConfig.update({
      where: { guildId },
      data: { isRunning: true, lastStartedAt: new Date(), lastError: profileErrors.length ? profileErrors.join(' | ').slice(0, 500) : null },
    }).catch(() => {});
  });

  client.on('error', async (err) => {
    logger.error('CustomBot', `[${guildId}] Erreur:`, err);
    await prisma.customBotConfig.update({
      where: { guildId },
      data: { lastError: err.message },
    }).catch(() => {});
  });

  try {
    await client.login(config.botToken);
    customBotClients.set(guildId, client);
  } catch (err: unknown) {
    logger.error('CustomBot', `[${guildId}] Impossible de se connecter:`, err);
    await prisma.customBotConfig.update({
      where: { guildId },
      data: { isRunning: false, lastError: errorMessage(err) || 'Login failed' },
    }).catch(() => {});
  }
}

async function stopCustomBot(guildId: string) {
  const client = customBotClients.get(guildId);
  if (client) {
    client.destroy();
    customBotClients.delete(guildId);
    logger.info('CustomBot', `[${guildId}] Bot arrêté.`);
  }
  await prisma.customBotConfig.update({
    where: { guildId },
    data: { isRunning: false },
  }).catch(() => {});
}

async function bootCustomBots() {
  try {
    // Un serveur repassé en FREE pendant l'arrêt ne voit pas son bot relancé :
    // l'accès se vérifie aussi ici, pas seulement dans le dashboard.
    const candidates = await prisma.customBotConfig.findMany({
      where: { enabled: true, isRunning: true, botToken: { not: null } },
      include: { guild: { select: { plan: true } } },
    });
    const configs = candidates.filter((cfg) => comparePlans(normalizePlanKey(cfg.guild.plan), 'PLUS') >= 0);

    if (configs.length === 0) return;

    logger.info('CustomBot', `Restauration de ${configs.length} custom bot(s)...`);
    for (const cfg of configs) {
      if (!cfg.botToken) continue;

      let botToken: string | null;
      try {
        botToken = openSecret(cfg.botToken);
      } catch (err) {
        logger.error('CustomBot', `[${cfg.guildId}] Token non déchiffrable :`, err);
        botToken = null;
      }
      if (!botToken) {
        await prisma.customBotConfig.update({
          where: { guildId: cfg.guildId },
          data: { isRunning: false, lastError: 'Token illisible : ressaisissez-le dans le dashboard.' },
        }).catch(() => {});
        continue;
      }

      await startCustomBot(cfg.guildId, {
        botToken,
        botStatus: cfg.botStatus,
        activityType: cfg.activityType,
        activityText: cfg.activityText || undefined,
        activityUrl: cfg.activityUrl || undefined,
        botName: cfg.botName || undefined,
        applyProfile: false,
      });
    }
  } catch (err) {
    logger.warn('CustomBot', 'Impossible de restaurer les custom bots (table manquante ?):', err);
  }
}

type ShardingConfig = {
  mode: 'auto' | 'fixed';
  shardCount?: number;
};

console.log("TOKEN DANS LE SHARD :", process.env.DISCORD_TOKEN ? "OK" : "MANQUANT");
console.log("DATABASE_URL DANS LE SHARD :", process.env.DATABASE_URL ? "OK" : "MANQUANT");

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

        // Custom bot management via IPC
        if (message.type === 'custom-bot-start' && message.guildId && message.config?.botToken) {
          startCustomBot(message.guildId, message.config as { botToken: string } & Record<string, unknown>);
          return;
        }
        if (message.type === 'custom-bot-stop' && message.guildId) {
          stopCustomBot(message.guildId);
          return;
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

async function spawnInstance(instance: ResolvedInstance, workerPath: string): Promise<ShardingManager> {
  const shardingConfig = await loadShardingConfig();
  const label = instance.isDefault ? 'default' : instance.slug;

  const envShardCount = process.env.SHARD_COUNT ? Number(process.env.SHARD_COUNT) : undefined;
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

  const timeout = process.env.SHARD_READY_TIMEOUT ? Number(process.env.SHARD_READY_TIMEOUT) : 120_000;
  await manager.spawn({ timeout });
  logger.success('Sharding', `[${label}] Bot lancé avec ${manager.totalShards} shard(s) - port API ${instance.apiPort}`);

  return manager;
}

async function main() {
  const instances = await loadAllInstances();
  const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.ts');

  const defaultInstance = instances.find(i => i.isDefault);
  if (!defaultInstance || !defaultInstance.discordToken) {
    logger.error('Bot', 'DISCORD_TOKEN non défini dans .env !');
    process.exit(1);
  }

  const managers: ShardingManager[] = [];

  // Spawn default instance first
  const defaultManager = await spawnInstance(defaultInstance, workerPath);
  managers.push(defaultManager);

  // Spawn white-label instances in parallel
  const wlInstances = instances.filter(i => !i.isDefault);
  if (wlInstances.length > 0) {
    logger.info('WhiteLabel', `Démarrage de ${wlInstances.length} instance(s) white-label...`);

    const results = await Promise.allSettled(
      wlInstances.map(inst => spawnInstance(inst, workerPath))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        managers.push(result.value);
      } else {
        logger.error('WhiteLabel', `Impossible de démarrer l'instance "${wlInstances[i].name}" (${wlInstances[i].slug}):`, result.reason);
      }
    }
  }

  logger.success('Sharding', `${managers.length} instance(s) bot démarrée(s) au total.`);

  if (shuttingDown) return;

  // Restore custom bots that were running before restart
  await bootCustomBots();
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

  for (const client of customBotClients.values()) {
    void client.destroy();
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

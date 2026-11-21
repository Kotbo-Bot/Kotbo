import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getCurrentInstance } from '../../utils/instanceContext.js';
import { getMachineFingerprint } from '../../utils/machineFingerprint.js';
import { fetchExternal } from '../../utils/http.js';
import botPackageJson from '../../../package.json';

export interface BotPingPayload {
  botClientId: string;
  botName: string;
  botAvatarUrl: string | null;
  dashboardUrl: string | null;
  guildCount: number;
  userCount: number;
  version: string | null;
  isSelfHosted: boolean;
  // Optionnel pour tolerer les instances self-host qui tournent encore sur
  // une version anterieure a l'introduction de l'empreinte machine.
  machineFingerprint?: string;
}

export interface BotPingResponse {
  ok: boolean;
  banned?: boolean;
  mode?: 'SHUTDOWN' | 'DISABLE_FEATURES';
  reason?: string | null;
}

/**
 * Applique la directive de bannissement renvoyee par le master suite a un
 * ping. C'est le seul canal par lequel le master peut "parler" a un bot
 * self-host (qui ne fait que sortir, jamais entrer) : SHUTDOWN arrete le
 * process (une boucle de crash si un process manager le relance
 * automatiquement est le comportement voulu tant que le ban est actif),
 * DISABLE_FEATURES pose juste un drapeau memoire verifie a l'entree des
 * interactions (voir index.ts, a cote de KOTBO_MAINTENANCE_MODE).
 */
function applyBanDirective(data: BotPingResponse | null): void {
  if (!data?.banned) {
    global.KOTBO_INSTANCE_BANNED = null;
    return;
  }

  logger.error(
    'StatsPing',
    `Cette instance a été bannie par l'administration Kotbo (mode=${data.mode}): ${data.reason ?? 'aucune raison fournie'}`,
  );

  if (data.mode === 'SHUTDOWN') {
    logger.error(
      'StatsPing',
      "Arrêt du processus suite au bannissement. Ce processus s'arrêtera à chaque redémarrage tant que le bannissement est actif.",
    );
    process.exit(1);
  }

  global.KOTBO_INSTANCE_BANNED = { mode: 'DISABLE_FEATURES', reason: data.reason ?? null };
}

/**
 * Pings the central master server to report statistics of the current bot instance.
 * To avoid duplication, this only executes on Shard 0.
 */
export async function pingMasterServer(client: Client): Promise<void> {
  // Un bot perso ne représente qu'un serveur : son ping écraserait les stats de Kotbo.
  if (!getCurrentInstance().isDefault) return;

  // If sharded, only run on Shard 0
  if (client.shard && !client.shard.ids.includes(0)) {
    return;
  }

  try {
    let guildCount = 0;
    let userCount = 0;

    if (client.shard) {
      const shardGuilds = await client.shard.fetchClientValues('guilds.cache.size') as number[];
      guildCount = shardGuilds.reduce((acc, count) => acc + count, 0);

      const shardUsers = await client.shard.broadcastEval((c) =>
        c.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0)
      ) as number[];
      userCount = shardUsers.reduce((acc, count) => acc + count, 0);
    } else {
      guildCount = client.guilds.cache.size;
      userCount = client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
    }

    const currentInst = getCurrentInstance();
    const isSelfHosted = process.env.IS_SELF_HOSTED === 'true' ||
      (!currentInst.dashboardOrigin.includes('kotbo.fr') && currentInst.isDefault);

    const payload: BotPingPayload = {
      botClientId: client.user?.id || '',
      botName: client.user?.username || currentInst.name,
      botAvatarUrl: client.user?.displayAvatarURL() || currentInst.brandLogoUrl || null,
      dashboardUrl: currentInst.dashboardUrl,
      guildCount,
      userCount,
      version: botPackageJson.version,
      isSelfHosted,
      machineFingerprint: await getMachineFingerprint(),
    };

    if (!payload.botClientId) {
      logger.warn('StatsPing', 'Client user ID not available yet. Skipping ping.');
      return;
    }

    const masterUrl = process.env.MASTER_API_URL || 'https://api.kotbo.fr';
    const pingUrl = `${masterUrl.replace(/\/$/, '')}/api/public/stats/ping`;

    logger.info('StatsPing', `Sending stats ping to ${pingUrl} (Guilds: ${guildCount}, Users: ${userCount}, Self-Hosted: ${isSelfHosted})`);

    // Perform the HTTP request
    const response = await fetchExternal(pingUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kotbo-Ping': 'true',
        ...(process.env.STATS_PING_SECRET ? { 'X-Kotbo-Ping-Secret': process.env.STATS_PING_SECRET } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      logger.success('StatsPing', 'Stats ping sent successfully.');
      const data = await response.json().catch(() => null) as BotPingResponse | null;
      applyBanDirective(data);
    } else {
      logger.error('StatsPing', `Failed to send stats ping: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    logger.error('StatsPing', 'Error sending stats ping:', err);
  }
}

/**
 * Registers/Updates the stats for a bot instance in the database.
 */
export async function registerBotInstanceStats(payload: BotPingPayload): Promise<void> {
  const { botClientId, botName, botAvatarUrl, dashboardUrl, guildCount, userCount, version, isSelfHosted, machineFingerprint } = payload;

  await prisma.botInstanceStats.upsert({
    where: { botClientId },
    update: {
      botName,
      botAvatarUrl,
      dashboardUrl,
      guildCount,
      userCount,
      version,
      isSelfHosted,
      machineFingerprint: machineFingerprint ?? null,
      lastPingAt: new Date(),
    },
    create: {
      botClientId,
      botName,
      botAvatarUrl,
      dashboardUrl,
      guildCount,
      userCount,
      version,
      isSelfHosted,
      machineFingerprint: machineFingerprint ?? null,
    },
  });
}

/**
 * Deletes any bot stats rows that haven't updated in the last 48 hours.
 */
export async function cleanUpStaleStats(): Promise<void> {
  const staleThreshold = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
  const result = await prisma.botInstanceStats.deleteMany({
    where: {
      lastPingAt: {
        lt: staleThreshold,
      },
    },
  });

  if (result.count > 0) {
    logger.info('StatsService', `Cleaned up ${result.count} stale bot instance stats.`);
  }
}

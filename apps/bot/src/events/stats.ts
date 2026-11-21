import { Client, Events, ChannelType, VoiceChannel, CategoryChannel } from 'discord.js';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { resolvePlaceholders, type PlaceholderContext } from '../utils/placeholders.js';
import { fetchAllMembers } from '../utils/discord.js';
import { readStatsConfig } from '../services/analytics/statsConfig.js';
import * as m from '../lib/paraglide/messages.js';
import { resolveGuildLocale } from '../utils/i18n.js';

const updateTimeouts = new Map<string, NodeJS.Timeout>();

export function registerStatsChannelListener(client: Client): void {
  client.on(Events.ClientReady, () => {
    updateAllGuildsStats(client);
    setInterval(() => updateAllGuildsStats(client), 10 * 60 * 1000);
  });

  client.on(Events.GuildMemberAdd, (member) => {
    triggerDebouncedUpdate(client, member.guild.id);
  });

  client.on(Events.GuildMemberRemove, (member) => {
    triggerDebouncedUpdate(client, member.guild.id);
  });

  logger.success('StatsChannels', 'Écouteur de Salons Statistiques enregistré');
}

function triggerDebouncedUpdate(client: Client, guildId: string) {
  const existingTimeout = updateTimeouts.get(guildId);
  if (existingTimeout) clearTimeout(existingTimeout);

  const timeout = setTimeout(() => {
    updateTimeouts.delete(guildId);
    updateGuildStats(client, guildId).catch((err) =>
      logger.error('StatsChannels', `Erreur lors de la mise à jour des stats pour la guilde ${guildId} :`, err)
    );
  }, 15000);

  updateTimeouts.set(guildId, timeout);
}

async function updateAllGuildsStats(client: Client): Promise<void> {
  const activeConfigs = await prisma.guild.findMany({
    where: { statsEnabled: true },
    select: { id: true }
  });

  for (const config of activeConfigs) {
    try {
      await updateGuildStats(client, config.id);
    } catch (err) {
      logger.error('StatsChannels', `Erreur lors de la mise à jour globale des stats pour ${config.id} :`, err);
    }
  }
}

export async function updateGuildStats(client: Client, guildId: string): Promise<void> {
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      statsEnabled: true,
      statsConfig: true,
    }
  });

  if (!guildConfig || !guildConfig.statsEnabled || !guildConfig.statsConfig) {
    return;
  }

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  // Les gabarits par defaut suivent la langue du serveur, comme le reste du bot.
  // `{count}` est passe LITTERAL : c'est `resolvePlaceholders` qui le remplace
  // ensuite, pas Paraglide — meme motif que `serverTemplateService`.
  const locale = await resolveGuildLocale(guildId, guild.preferredLocale ?? null);
  const compteur = { count: '{count}' } as const;

  const config = readStatsConfig(guildConfig.statsConfig);

  // 1. Gather all counts upfront
  const membersCount = guild.memberCount;
  let botsCount = 0;
  let roleCount = 0;

  let needsFetch = Boolean(config.botChannelId || (config.roleChannelId && config.roleTargetId));
  if (!needsFetch && Array.isArray(config.customStats)) {
    needsFetch = config.customStats.some((c) => c.enabled && (c.type === 'role' || c.type === 'online' || c.type === 'bots'));
  }

  let allMembers = guild.members.cache;
  if (needsFetch) {
    allMembers = await fetchAllMembers(guild).catch(() => guild.members.cache);
    botsCount = allMembers.filter(m => m.user.bot).size;

    if (config.roleChannelId && config.roleTargetId) {
      roleCount = allMembers.filter(m => m.roles.cache.has(config.roleTargetId!)).size;
    }
  }

  const channelsCount = guild.channels.cache.size;
  const categoriesCount = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;
  const onlineCount = allMembers.filter(m => m.presence && m.presence.status !== 'offline').size;
  const voiceCount = guild.members.cache.filter(m => m.voice && m.voice.channelId).size;
  const boostCount = guild.premiumSubscriptionCount || 0;

  let activityCount = 0;
  if (config.activityChannelId || (Array.isArray(config.customStats) && config.customStats.some((c) => c.enabled && c.type === 'activity'))) {
    activityCount = await prisma.memberProfile.count({
      where: {
        guildId,
        lastSeenAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        }
      }
    }).catch(() => 0);
  }

  // Build the universal placeholder context
  const baseCtx: PlaceholderContext = {
    guild,
    memberCount: membersCount,
    botCount: botsCount,
    onlineCount,
    voiceCount,
    channelCount: channelsCount,
    categoryCount: categoriesCount,
    boostCount,
    activityCount,
    roleCount,
  };

  // 2. Helper to rename a channel (voice or category) if value changed
  const renameChannelIfNeeded = async (channelId: string, template: string, count: number, customGoal?: number) => {
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const isRenameable = channel instanceof VoiceChannel || channel instanceof CategoryChannel;
    if (!isRenameable) return;

    const expectedName = resolvePlaceholders(template, {
      ...baseCtx,
      count,
      goal: customGoal,
    });

    if (channel.name !== expectedName) {
      await channel.setName(expectedName).catch((err) =>
        logger.warn('StatsChannels', `Impossible de renommer le salon ${channelId} vers "${expectedName}" (limitation Discord ?) :`, err)
      );
    }
  };

  // 3. Rename active stats channels
  if ((config.memberEnabled ?? !!config.memberChannelId) && config.memberChannelId) {
    await renameChannelIfNeeded(config.memberChannelId, config.memberTemplate || m.setup_template_stats_members(compteur, { locale }), membersCount);
  }
  if ((config.botEnabled ?? !!config.botChannelId) && config.botChannelId) {
    await renameChannelIfNeeded(config.botChannelId, config.botTemplate || m.setup_template_stats_bots(compteur, { locale }), botsCount);
  }
  if ((config.roleEnabled ?? !!config.roleChannelId) && config.roleChannelId && config.roleTargetId) {
    await renameChannelIfNeeded(config.roleChannelId, config.roleTemplate || m.setup_template_stats_staff(compteur, { locale }), roleCount);
  }
  if ((config.channelEnabled ?? !!config.channelChannelId) && config.channelChannelId) {
    await renameChannelIfNeeded(config.channelChannelId, config.channelTemplate || m.setup_template_stats_channels(compteur, { locale }), channelsCount);
  }
  if ((config.categoryEnabled ?? !!config.categoryChannelId) && config.categoryChannelId) {
    await renameChannelIfNeeded(config.categoryChannelId, config.categoryTemplate || m.setup_template_stats_categories(compteur, { locale }), categoriesCount);
  }
  if ((config.activityEnabled ?? !!config.activityChannelId) && config.activityChannelId) {
    await renameChannelIfNeeded(config.activityChannelId, config.activityTemplate || m.setup_template_stats_active24h(compteur, { locale }), activityCount);
  }

  // 4. Update custom stats channels (voice or category)
  if (Array.isArray(config.customStats)) {
    for (const custom of config.customStats) {
      if (!custom.enabled || !custom.channelId) continue;

      let count = 0;
      if (custom.type === 'members') {
        count = membersCount;
      } else if (custom.type === 'bots') {
        count = botsCount;
      } else if (custom.type === 'online') {
        count = onlineCount;
      } else if (custom.type === 'voice') {
        count = voiceCount;
      } else if (custom.type === 'role') {
        if (custom.roleTargetId) {
          if (!needsFetch) {
            allMembers = await fetchAllMembers(guild).catch(() => guild.members.cache);
          }
          count = allMembers.filter(m => m.roles.cache.has(custom.roleTargetId!)).size;
        }
      } else if (custom.type === 'channels') {
        count = channelsCount;
      } else if (custom.type === 'categories') {
        count = categoriesCount;
      } else if (custom.type === 'activity') {
        count = activityCount;
      } else if (custom.type === 'boosts') {
        count = boostCount;
      } else if (custom.type === 'goal') {
        count = membersCount;
      }

      await renameChannelIfNeeded(custom.channelId!, custom.template || 'Stat : {count}', count, custom.goalTarget ?? undefined);
    }
  }
}

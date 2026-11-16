/**
 * Réglages de Starlight côté dashboard : lecture sous forme de réglages
 * complets, écriture suivie de l'invalidation du cache du service et d'un
 * signal temps réel à la page.
 */
import type { StarboardConfig } from '@prisma/client';
import { defaultStarboardSettings, readStarboardChannelThresholds, type StarboardSettings } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { invalidateStarboardCache, notifyStarboardChange } from './starboardService.js';

export function toStarboardSettings(row: StarboardConfig | null): StarboardSettings {
  if (!row) return defaultStarboardSettings();
  return {
    channelId: row.channelId,
    upvoteEmojis: row.upvoteEmojis,
    downvoteEmojis: row.downvoteEmojis,
    threshold: row.threshold,
    countEmbedReactions: row.countEmbedReactions,
    autoReactEmbed: row.autoReactEmbed,
    autoReactChannels: row.autoReactChannels,
    watchedChannels: row.watchedChannels,
    ignoredChannels: row.ignoredChannels,
    allowBots: row.allowBots,
    ignoreAuthorVotes: row.ignoreAuthorVotes,
    embedColor: row.embedColor,
    removeBelowThreshold: row.removeBelowThreshold,
    maxMessageAgeDays: row.maxMessageAgeDays,
    channelThresholds: readStarboardChannelThresholds(row.channelThresholds),
    blockedUserIds: row.blockedUserIds,
  };
}

/** Sans ligne en base, les valeurs par défaut du schéma : le formulaire s'affiche rempli. */
export async function getStarboardSettings(guildId: string): Promise<StarboardSettings> {
  return toStarboardSettings(await prisma.starboardConfig.findUnique({ where: { guildId } }));
}

/**
 * `enabled` n'est pas écrit ici : l'activation passe par `/modules`, qui tient
 * la pastille du module et cette colonne ensemble. Le `create` reste pour le
 * serveur dont la bascule aurait échoué à mi-chemin.
 */
export async function saveStarboardSettings(guildId: string, patch: Partial<StarboardSettings>): Promise<StarboardSettings> {
  const row = await prisma.starboardConfig.upsert({
    where: { guildId },
    create: { guildId, enabled: true, ...defaultStarboardSettings(), ...patch },
    update: patch,
  });
  await invalidateStarboardCache(guildId);
  notifyStarboardChange(guildId);
  return toStarboardSettings(row);
}

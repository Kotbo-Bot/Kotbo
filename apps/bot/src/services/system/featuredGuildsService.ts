import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

/** Nombre de membres à partir duquel un serveur apparaît sur kotbo.fr. */
export const FEATURED_MIN_MEMBERS = 1000;

// Sans passage pendant ce délai, le bot a quitté le serveur ou le shard qui le
// porte est tombé. Large devant la cadence horaire de la synchro.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Met `featured_guilds` à jour avec les serveurs que voit ce shard. Chaque
 * shard, et chaque instance, ne connaît que les siens : il rafraîchit ceux de
 * plus de 1000 membres, retire ceux passés sous le seuil, et les lignes que
 * plus personne ne rafraîchit expirent.
 */
export async function syncFeaturedGuilds(client: Client, now = new Date()): Promise<void> {
  const below: string[] = [];

  for (const guild of client.guilds.cache.values()) {
    if (guild.memberCount < FEATURED_MIN_MEMBERS) {
      below.push(guild.id);
      continue;
    }

    const data = {
      name: guild.name,
      iconUrl: guild.iconURL({ size: 128 }),
      memberCount: guild.memberCount,
      lastSeenAt: now,
    };
    await prisma.featuredGuild.upsert({
      where: { guildId: guild.id },
      create: { guildId: guild.id, ...data, description: guild.description ?? '' },
      // Un serveur sans description sur Discord garde celle déjà en base.
      update: guild.description ? { ...data, description: guild.description } : data,
    });
  }

  const { count } = await prisma.featuredGuild.deleteMany({
    where: {
      OR: [
        { guildId: { in: below } },
        { lastSeenAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
      ],
    },
  });

  logger.debug('FeaturedGuilds', `Synchro faite (${client.guilds.cache.size - below.length} retenu(s), ${count} retiré(s))`);
}

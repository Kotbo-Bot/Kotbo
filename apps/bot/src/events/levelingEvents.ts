import { Client } from 'discord.js';
import { addXp, getOrCreateLevelConfig } from '../services/progression/levelingService.js';
import { handleUserActivity } from '../services/features/economyService.js';
import { isProgressionBlocked } from '../services/progression/progressionBlacklist.js';
import { logger } from '../utils/logger.js';


let voiceXpInterval: ReturnType<typeof setInterval> | null = null;

// L'XP texte est gérée par le module bus (leveling.module.ts).
// Ce fichier ne conserve que la boucle d'XP vocale (polling, non event-driven).
export function registerLevelingListener(client: Client) {
  // Vocal XP Loop (every 60 seconds)
  if (voiceXpInterval) clearInterval(voiceXpInterval);
  
  voiceXpInterval = setInterval(async () => {
    try {
      const xpPromises: Promise<void>[] = [];

      for (const [guildId, guild] of client.guilds.cache) {
        const config = await getOrCreateLevelConfig(guildId).catch(() => null);
        if (!config || !config.enabled || config.vocalXpPerMin <= 0) continue;

        // Parcourir tous les salons vocaux de la guilde
        for (const [_channelId, channel] of guild.channels.cache) {
          if (!channel.isVoiceBased()) continue;

          // Vérifier si le salon vocal est exclu
          if (config.ignoredChannels && config.ignoredChannels.includes(channel.id)) continue;

          // Les conditions actives par défaut sont comparées à `false` plutôt que
          // testées pour leur véracité : une config encore en cache depuis avant
          // la migration n'a pas ces colonnes, et l'absence doit valoir le défaut
          // (condition appliquée) et non l'inverse.
          if (config.voiceIgnoreAfkChannel !== false && guild.afkChannelId === channel.id) continue;

          // Le seuil se compte en humains : sinon un bot de musique suffirait à
          // faire passer un salon où le membre est seul pour une conversation.
          const humanCount = channel.members.filter(m => !m.user.bot).size;
          if (humanCount < Math.max(1, config.voiceMinMembers ?? 1)) continue;

          // Parcourir tous les membres connectés
          for (const [_memberId, member] of channel.members) {
            if (member.user.bot) continue;

            const isMuted = member.voice.selfMute || member.voice.serverMute;
            const isDeafened = member.voice.selfDeaf || member.voice.serverDeaf;
            if (config.voiceRequireUnmuted !== false && isMuted) continue;
            if (config.voiceRequireUndeafened !== false && isDeafened) continue;

            // Vérifier si le membre possède un rôle exclu
            if (config.ignoredRoles && (config.ignoredRoles as string[]).some(roleId => member.roles.cache.has(roleId))) continue;
            if (await isProgressionBlocked(guildId, { userId: member.id, roleIds: member.roles.cache.keys(), channelIds: [channel.id, channel.parentId] })) continue;

            // Calculer le multiplicateur d'XP par rôle
            let multiplier = 1.0;
            if (config.xpMultipliers && typeof config.xpMultipliers === 'object') {
              const multipliers = config.xpMultipliers as Record<string, number>;
              for (const [roleId, multValue] of Object.entries(multipliers)) {
                if (member.roles.cache.has(roleId)) {
                  if (multValue > multiplier) {
                    multiplier = multValue;
                  }
                }
              }
            }

            const voiceXp = Math.floor(config.vocalXpPerMin * multiplier);
            if (voiceXp <= 0) continue;

            // Ajouter l'XP vocale (batching: max 50 opérations en parallèle)
            xpPromises.push(
              addXp(guildId, member.id, voiceXp, client, undefined, { applyDailyCap: true, rankedSource: 'voice' }).catch(err =>
                logger.error('LevelingService', `Erreur lors de l'attribution XP vocal à ${member.id}:`, err)
              )
            );
            xpPromises.push(
              handleUserActivity(guildId, member.id, 'voice').catch(() => {})
            );

            if (xpPromises.length >= 50) {
              await Promise.all(xpPromises);
              xpPromises.length = 0;
            }
          }
        }
      }

      // Flush remaining XP updates
      if (xpPromises.length > 0) {
        await Promise.all(xpPromises);
      }

    } catch (err) {
      logger.error('LevelingEvents', "Erreur lors de la boucle d'XP vocale :", err);
    }
  }, 60000) as ReturnType<typeof setInterval>;

  logger.info('System', 'Écouteurs de Leveling & XP enregistrés.');
}

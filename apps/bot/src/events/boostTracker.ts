/**
 * Suivi des boosts : chaque changement de `premiumSince` passe par
 * syncMemberBoost, qui compare à la valeur en base plutôt qu'à l'ancien membre
 * (souvent partiel, donc muet sur le boost précédent).
 */
import { Events, type Client, type GuildMember, type PartialGuildMember } from 'discord.js';
import { logger } from '../utils/logger.js';
import { isGuildActivated } from '../utils/activation.js';
import { notifyTierDrop, stopBoostOnLeave, syncMemberBoost } from '../services/analytics/boostService.js';

export function registerBoostTracker(client: Client): void {
  const sync = async (member: GuildMember | PartialGuildMember) => {
    if (member.partial || !isGuildActivated(member.guild.id)) return;
    try {
      await syncMemberBoost(member);
    } catch (err) {
      logger.error('Boosts', `Suivi du boost impossible pour ${member.id}:`, err);
    }
  };

  client.on(Events.GuildMemberUpdate, (_old, member) => void sync(member));
  // Membre absent du cache : discord.js émet cet événement à la place de GuildMemberUpdate.
  client.on(Events.GuildMemberAvailable, (member) => void sync(member));

  client.on(Events.GuildMemberRemove, async (member) => {
    if (!isGuildActivated(member.guild.id)) return;
    try {
      await stopBoostOnLeave(member.guild, member.id, member.displayName ?? member.user?.username ?? member.id);
    } catch (err) {
      logger.error('Boosts', `Arrêt de boost au départ impossible pour ${member.id}:`, err);
    }
  });

  client.on(Events.GuildUpdate, (oldGuild, guild) => {
    if (!isGuildActivated(guild.id)) return;
    if (oldGuild.premiumTier > guild.premiumTier) void notifyTierDrop(guild, oldGuild.premiumTier, guild.premiumTier);
  });
}

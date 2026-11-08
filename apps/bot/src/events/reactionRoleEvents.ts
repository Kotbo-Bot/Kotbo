/**
 * Rôles-boutons : suit ce qui arrive aux menus publiés hors du panneau.
 *
 * Un rôle donné ou retiré ailleurs (à la main, par un autre bot, membre parti)
 * remet à jour les nombres des boutons ; un rôle ou un message de menu supprimé
 * sur Discord prévient le staff sans attendre qu'un membre clique pour rien.
 */

import { Client, Events } from 'discord.js';
import {
  changedRoleIds,
  handleMenuMessagesDeleted,
  handleMenuRoleDeleted,
  refreshCountsForRoles,
} from '../services/features/reactionRoleService.js';
import { logger } from '../utils/logger.js';

export function registerReactionRoleListener(client: Client): void {
  const fail = (what: string) => (err: unknown) => logger.error('ReactionRoles', `Erreur sur ${what}`, err);

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    const changed = changedRoleIds(oldMember.roles.cache.keys(), newMember.roles.cache.keys());
    void refreshCountsForRoles(client, newMember.guild.id, changed).catch(fail(`la mise à jour de ${newMember.id}`));
  });

  // Discord retire le membre du cache avant l'événement : les rôles qu'il
  // portait sont recomptés sans lui.
  client.on(Events.GuildMemberRemove, (member) => {
    void refreshCountsForRoles(client, member.guild.id, [...member.roles.cache.keys()])
      .catch(fail(`le départ de ${member.id}`));
  });

  client.on(Events.GuildRoleDelete, (role) => {
    void handleMenuRoleDeleted(role).catch(fail(`la suppression du rôle ${role.id}`));
  });

  client.on(Events.MessageDelete, (message) => {
    if (!message.guild) return;
    void handleMenuMessagesDeleted(message.guild, [message.id]).catch(fail(`la suppression du message ${message.id}`));
  });

  client.on(Events.MessageBulkDelete, (messages, channel) => {
    void handleMenuMessagesDeleted(channel.guild, [...messages.keys()])
      .catch(fail(`la purge du salon ${channel.id}`));
  });

  logger.info('Modules', 'Module "reaction_roles" enregistré sur les événements de rôles et de messages.');
}

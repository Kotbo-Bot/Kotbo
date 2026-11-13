/**
 * Réputation : remercier en réagissant sous un message.
 *
 * Écoute directe du client, comme Starlight : le bus d'événements ne transporte
 * pas la réaction complète. Le client reçu est restreint aux serveurs où le
 * module Réputation est actif.
 */
import { Client, Events, type MessageReaction, type PartialMessageReaction, type PartialUser, type User } from 'discord.js';
import { handleReputationReaction } from '../services/community/reputationReaction.js';
import { logger } from '../utils/logger.js';

export function registerReputationListener(client: Client): void {
  client.on(Events.MessageReactionAdd, async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ) => {
    try {
      await handleReputationReaction(client, reaction, user);
    } catch (err) {
      logger.error('Reputation', `Erreur sur la réaction du message ${reaction.message.id}`, err);
    }
  });
}

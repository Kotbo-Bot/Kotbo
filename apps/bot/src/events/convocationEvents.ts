/**
 * Convocations : l'accusé de réception (✅ du membre sous le message) et ses
 * réponses dans le fil suspendent l'échéance.
 */
import { Client, Events, type Message } from 'discord.js';
import { handleConvocationReaction, handleConvocationThreadMessage } from '../services/moderation/convocationService.js';
import { logger } from '../utils/logger.js';

export function registerConvocationListener(client: Client): void {
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot || !reaction.message.guildId) return;
    await handleConvocationReaction(reaction, user).catch((err) =>
      logger.error('Convocation', `Accusé de réception non enregistré (${reaction.message.id})`, err));
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (!message.guildId) return;
    await handleConvocationThreadMessage(message).catch((err) =>
      logger.error('Convocation', `Réponse dans le fil non enregistrée (${message.id})`, err));
  });
}

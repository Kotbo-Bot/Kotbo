/**
 * AutoMod Module - Bus-based subscriber
 *
 * Note: AutoMod needs the full Discord Message/Member objects to apply
 * moderation actions (delete, timeout, etc.). The bus payload is used
 * for routing only - the actual Discord objects are fetched from cache.
 *
 * The ghost ping detection (MessageDelete/MessageUpdate) also needs
 * access to the full Discord client to resolve mentions and send alerts.
 * These stay on client.on() but are registered here for module cohesion.
 */

import type { Client } from 'discord.js';
import { Events, type AutoModerationActionExecution, type Message, type PartialMessage, type GuildMember } from 'discord.js';
import { handleAutoMod, handleAutoModExecution, handleGhostPingDelete, handleGhostPingUpdate, handleAntiBotAdd } from '../services/moderation/autoModService.js';
import { logger } from '../utils/logger.js';

const MODULE_NAME = 'automod';

export function registerAutoModBusSubscribers(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      await handleAutoMod(message, client);
    } catch (err) {
      logger.error(`[EventBus:${MODULE_NAME}]`, 'Erreur handleAutoMod:', err);
    }
  });

  // Règles natives en mode « Censurer » : Discord bloque, le bot republie masqué.
  client.on(Events.AutoModerationActionExecution, async (execution: AutoModerationActionExecution) => {
    try {
      await handleAutoModExecution(execution);
    } catch (err) {
      logger.error(`[EventBus:${MODULE_NAME}]`, 'Erreur handleAutoModExecution:', err);
    }
  });

  client.on(Events.MessageDelete, async (message: Message | PartialMessage) => {
    try {
      await handleGhostPingDelete(message, client);
    } catch (err) {
      logger.error(`[EventBus:${MODULE_NAME}]`, 'Erreur handleGhostPingDelete:', err);
    }
  });

  client.on(Events.MessageUpdate, async (oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) => {
    try {
      await handleGhostPingUpdate(oldMessage, newMessage, client);
    } catch (err) {
      logger.error(`[EventBus:${MODULE_NAME}]`, 'Erreur handleGhostPingUpdate:', err);
    }
  });

  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    try {
      await handleAntiBotAdd(member, client);
    } catch (err) {
      logger.error(`[EventBus:${MODULE_NAME}]`, 'Erreur handleAntiBotAdd:', err);
    }
  });

  logger.info('Modules', `Module "${MODULE_NAME}" enregistre sur le bus d'events.`);
}

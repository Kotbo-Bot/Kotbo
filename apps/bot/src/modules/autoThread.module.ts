/**
 * AutoThread Module - Bus-based subscriber
 *
 * Écoute `message:new` et confie le message au service des fils
 * automatiques, qui choisit la configuration du salon qui l'accepte, ouvre le
 * fil ou applique la politique de rejet.
 */

import type { Client, Message } from 'discord.js';
import { subscribeForModule } from '../services/core/moduleScope.js';
import { getGuildAutoThreadConfigs, handleAutoThreadMessage } from '../services/features/autoThreadService.js';
import { isStickyMessage } from '../services/features/stickyMessageService.js';
import { logger } from '../utils/logger.js';

const MODULE_NAME = 'autothread';

export function registerAutoThreadBusSubscribers(client: Client): void {
  subscribeForModule('auto_thread', 'message:new', async (payload) => {
    if (!payload.guildId) return;
    if (payload.isInteraction) return;

    // Filtre bon marché avant tout appel à Discord : la plupart des salons
    // n'ont aucune configuration.
    const configs = await getGuildAutoThreadConfigs(payload.guildId);
    if (!configs.some((config) => config.channelId === payload.channelId)) return;

    const channel = client.channels.cache.get(payload.channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.isThread()) return;

    const message = await channel.messages.fetch(payload.messageId).catch(() => null) as Message<true> | null;
    if (!message) return;

    // Le sticky remonte à chaque seuil et laisserait un fil vide derrière
    // chaque renvoi. Testé après le fetch, qui laisse le temps à l'envoi du
    // sticky d'être enregistré si l'événement le devance.
    if (await isStickyMessage(payload.guildId, payload.channelId, payload.messageId)) return;

    try {
      await handleAutoThreadMessage(client, message);
    } catch (err) {
      logger.error('AutoThread', `Erreur sur le message ${payload.messageId}`, err);
    }
  }, MODULE_NAME);

  logger.info('Modules', `Module "${MODULE_NAME}" enregistre sur le bus d'events.`);
}

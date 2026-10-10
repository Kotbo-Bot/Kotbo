import { Client, Events, type Message } from 'discord.js';
import { handleSiteTicketMessage } from '../services/site/siteNotifyService.js';
import { logger } from '../utils/logger.js';

/** Écouteurs du site communautaire : réponses du staff aux tickets ouverts depuis le site. */
export function registerSiteListeners(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      await handleSiteTicketMessage(message);
    } catch (err) {
      logger.error('Site', 'Erreur sur un message de ticket du site :', err);
    }
  });

  logger.info('System', 'Écouteur Site communautaire enregistré.');
}

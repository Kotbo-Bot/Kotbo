import { Client, Events, Message } from 'discord.js';
import { handleRichLink } from '../services/integrations/richLinkService.js';
import { logger } from '../utils/logger.js';

export function registerRichLinkListener(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      await handleRichLink(message);
    } catch (err) {
      logger.error('RichLinks', "Erreur lors de l'envoi d'un aperçu de lien :", err);
    }
  });

  logger.info('System', 'Écouteur Aperçus de liens enregistré.');
}

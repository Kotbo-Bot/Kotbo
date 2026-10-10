import { Client, Events, type Message, type VoiceState } from 'discord.js';
import { handleSiteTicketMessage } from '../services/site/siteNotifyService.js';
import { publishGuildSignal, type SiteLiveChannel } from '../services/site/siteLive.js';
import { logger } from '../utils/logger.js';

/**
 * Filtre par serveur avant tout signal : un serveur bavard ne doit pas
 * provoquer une recherche de site à chaque message. Le regroupement fin se
 * fait ensuite dans `siteLive`.
 */
const lastSignal = new Map<string, number>();

function throttledSignal(guildId: string, channel: SiteLiveChannel, windowMs: number): void {
  const key = `${guildId}:${channel}`;
  const now = Date.now();
  if (now - (lastSignal.get(key) ?? 0) < windowMs) return;
  lastSignal.set(key, now);
  if (lastSignal.size > 50_000) lastSignal.clear();
  publishGuildSignal(guildId, channel);
}

/**
 * Écouteurs du site communautaire : réponses du staff aux tickets ouverts
 * depuis le site, et signaux temps réel des blocs « Discord en direct ».
 */
export function registerSiteListeners(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.guildId && !message.system) throttledSignal(message.guildId, 'module:channelFeed', 10_000);
      await handleSiteTicketMessage(message);
    } catch (err) {
      logger.error('Site', 'Erreur sur un message de ticket du site :', err);
    }
  });

  client.on(Events.VoiceStateUpdate, (before: VoiceState, after: VoiceState) => {
    if (before.channelId === after.channelId) return;
    const guildId = after.guild?.id ?? before.guild?.id;
    if (guildId) throttledSignal(guildId, 'module:voice', 3_000);
  });

  logger.info('System', 'Écouteur Site communautaire enregistré.');
}

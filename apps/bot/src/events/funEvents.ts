import { Client, Events, Message } from 'discord.js';
import { getCachedGuild } from '../utils/cache.js';
import {
  handleCountingMessage,
  handleOneWordStoryMessage,
  handleGuessNumberMessage,
  handleWordChainMessage,
  handleEmojiRiddleMessage,
  handleNeverSayMessage,
  handleEmojiOnlyMessage
} from '../services/features/funService.js';
import { handleImageOfDayMessage } from '../services/features/imageOfDayService.js';
import { logger } from '../utils/logger.js';
import { isModuleEnabled } from '../services/core/moduleGate.js';

/**
 * File par salon. Chaque jeu lit son état en base puis l'écrit : deux messages
 * traités en parallèle lisaient le même état, et un « 6 » envoyé juste après un
 * « 5 » était jugé faux, ce qui remettait le comptage à zéro en mode punitif.
 */
const channelQueues = new Map<string, Promise<void>>();

function runInChannelOrder(channelId: string, task: () => Promise<void>): Promise<void> {
  const run = (channelQueues.get(channelId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (channelQueues.get(channelId) === run) channelQueues.delete(channelId);
    });
  channelQueues.set(channelId, run);
  return run;
}

/**
 * Registers the message listener for Fun Channels.
 */
export function registerFunEventsListener(client: Client) {
  client.on(Events.MessageCreate, (message: Message) => {
    const guildId = message.guildId;
    
    // Ignore direct messages or messages from bots
    if (!guildId || message.author.bot) return;

    // Mise en file dès la réception, avant tout await : l'ordre d'arrivée des
    // messages est celui dans lequel ils doivent être joués.
    void runInChannelOrder(message.channelId, () => handleFunMessage(message, guildId));
  });

  logger.info('System', 'Écouteur des Salons Fun enregistré.');
}

async function handleFunMessage(message: Message, guildId: string) {
  try {
    if (!(await isModuleEnabled(guildId, 'fun'))) return;

    const guild = await getCachedGuild(guildId);
    
    // Ensure the Fun module is active for the server
    if (!guild || !guild.funEnabled) return;

    const channelId = message.channelId;

    if (guild.funCountingChannelId && channelId === guild.funCountingChannelId) {
      await handleCountingMessage(message, guildId, guild.funPunitiveMode);
    } else if (guild.funOneWordStoryChannelId && channelId === guild.funOneWordStoryChannelId) {
      await handleOneWordStoryMessage(message, guildId);
    } else if (guild.funGuessNumberChannelId && channelId === guild.funGuessNumberChannelId) {
      await handleGuessNumberMessage(message, guildId);
    } else if (guild.funWordChainChannelId && channelId === guild.funWordChainChannelId) {
      await handleWordChainMessage(message, guildId, guild.funPunitiveMode);
    } else if (guild.funEmojiRiddleChannelId && channelId === guild.funEmojiRiddleChannelId) {
      await handleEmojiRiddleMessage(message, guildId);
    } else if (guild.funNeverSayChannelId && channelId === guild.funNeverSayChannelId) {
      await handleNeverSayMessage(message);
    } else if (guild.funEmojiOnlyChannelId && channelId === guild.funEmojiOnlyChannelId) {
      await handleEmojiOnlyMessage(message);
    } else if (guild.funImageOfDayChannelId && channelId === guild.funImageOfDayChannelId) {
      await handleImageOfDayMessage(message, guildId);
    }
  } catch (error) {
    logger.error('FunEvents', `Error processing message in fun channels:`, error);
  }
}

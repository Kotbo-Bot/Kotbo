/**
 * contentStatsTracker.ts
 *
 * Alimente les stats de contenu en direct : chaque message analysé, chaque
 * réaction posée, chaque première modification d'un message. Suit
 * `Guild.analyticsEnabled` comme le reste de la collecte.
 *
 * Un message posté dans un fil compte pour le salon parent, pour que la vue
 * par catégorie retrouve ses fils (styleThread les distingue).
 */

import {
  Events,
  MessageFlags,
  MessageReferenceType,
  type Client,
  type Guild,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { isGuildActivated } from '../utils/activation.js';
import { isAnalyticsCollectionEnabled } from '../services/analytics/analyticsConsent.js';
import { analyzeMessageContent, type ContentSticker } from '../services/analytics/messageContentAnalyzer.js';
import {
  dateKeyOf,
  queueContentCounters,
  queueContentItem,
  recordMessageAnalysis,
  startContentStatsFlusher,
} from '../services/analytics/contentStatsService.js';
import { isStandardSticker, noteAssets, startAssetSourceResolver } from '../services/analytics/assetSourceService.js';

const EXPLICIT_MENTION_RE = /<@[!&]?\d{17,20}>|@everyone|@here/;

type AnyChannel = Message['channel'] | PartialMessage['channel'];

/** Salon de rattachement : le parent pour un fil. */
function statsChannelId(channel: AnyChannel | null | undefined, fallback: string): string {
  if (channel && 'isThread' in channel && channel.isThread() && channel.parentId) return channel.parentId;
  return fallback;
}

async function collecting(guildId: string): Promise<boolean> {
  return isGuildActivated(guildId) && (await isAnalyticsCollectionEnabled(guildId));
}

function stickerOrigin(guild: Guild, id: string): ContentSticker['origin'] {
  if (guild.stickers.cache.has(id)) return 'guild';
  return isStandardSticker(id) ? 'standard' : 'external';
}

async function handleMessage(message: Message): Promise<void> {
  const guild = message.guild;
  if (!guild || message.author.bot || message.system || message.webhookId) return;
  if (!(await collecting(guild.id))) return;

  const isForward = message.reference?.type === MessageReferenceType.Forward;
  const analysis = analyzeMessageContent({
    content: message.content ?? '',
    attachments: message.attachments.map((a) => ({ name: a.name, contentType: a.contentType })),
    stickers: message.stickers.map((s) => ({ id: s.id, name: s.name, origin: stickerOrigin(guild, s.id) })),
    isGuildEmoji: (id) => guild.emojis.cache.has(id),
    isVoiceMessage: message.flags.has(MessageFlags.IsVoiceMessage),
    hasPoll: Boolean(message.poll),
    isForward,
    isReply: Boolean(message.reference) && !isForward,
    hasMention: EXPLICIT_MENTION_RE.test(message.content ?? ''),
    inThread: message.channel.isThread(),
  });

  recordMessageAnalysis(
    guild.id,
    dateKeyOf(message.createdAt),
    statsChannelId(message.channel, message.channelId),
    message.author.id,
    analysis,
  );
}

async function handleReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  const message = reaction.message;
  const guild = message.guild;
  if (!guild || user.bot) return;
  if (!(await collecting(guild.id))) return;

  const channelId = statsChannelId(message.channel, message.channelId);
  const today = dateKeyOf(new Date());
  const emoji = reaction.emoji;

  if (!emoji.id) {
    const key = (emoji.name ?? '').replace(/️/g, '');
    if (!key) return;
    queueContentCounters(guild.id, today, channelId, user.id, { reactUnicode: 1 });
    queueContentItem(guild.id, today, 'reaction_unicode', key, channelId, user.id);
  } else {
    const own = guild.emojis.cache.has(emoji.id);
    queueContentCounters(guild.id, today, channelId, user.id, own ? { reactGuild: 1 } : { reactExternal: 1 });
    queueContentItem(guild.id, today, own ? 'reaction_guild' : 'reaction_external', emoji.id, channelId, user.id);
    noteAssets([{ kind: 'emoji', id: emoji.id, name: emoji.name ?? 'emoji', animated: Boolean(emoji.animated), guildId: own ? guild.id : null }]);
  }

  // Première réaction du message : il rejoint les « messages avec réaction »,
  // comptés au jour et au nom de son auteur. Un message hors cache n'a ni
  // auteur ni total fiable : on ne le compte pas plutôt que de le compter faux.
  if (message.partial || !message.author || message.author.bot) return;
  let total = 0;
  for (const r of message.reactions.cache.values()) total += r.count ?? 0;
  if (total !== 1) return;
  queueContentCounters(guild.id, dateKeyOf(message.createdAt), channelId, message.author.id, { reactedMessages: 1 });
}

async function handleUpdate(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage): Promise<void> {
  // Seule la première modification compte, et on ne sait qu'elle est la
  // première que si l'ancien message était en cache.
  if (oldMessage.partial || oldMessage.editedTimestamp || !newMessage.editedTimestamp) return;
  const guild = newMessage.guild;
  const author = newMessage.author;
  if (!guild || !author || author.bot || !newMessage.createdAt) return;
  if (!(await collecting(guild.id))) return;

  queueContentCounters(
    guild.id,
    dateKeyOf(newMessage.createdAt),
    statsChannelId(newMessage.channel, newMessage.channelId),
    author.id,
    { styleEdited: 1 },
  );
}

export function registerContentStatsTracker(client: Client): void {
  startContentStatsFlusher();
  startAssetSourceResolver(client);

  client.on(Events.MessageCreate, (message: Message) => {
    void handleMessage(message).catch((err) => logger.error('ContentStats', 'Analyse de message impossible :', err));
  });
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReaction(reaction, user).catch((err) => logger.error('ContentStats', 'Suivi de réaction impossible :', err));
  });
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    void handleUpdate(oldMessage, newMessage).catch((err) => logger.error('ContentStats', 'Suivi de modification impossible :', err));
  });
}

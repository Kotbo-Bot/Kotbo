/**
 * Fils automatiques : choisit la configuration qui accepte un message, ouvre
 * le fil sous le nom voulu, et applique la politique de rejet sinon.
 *
 * Les configurations d'un serveur sont lues une fois puis gardées en cache ;
 * le dashboard invalide après chaque écriture. Les règles elles-mêmes vivent
 * dans @kotbo/shared, que le dashboard utilise pour son aperçu.
 */

import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import type { AutoThreadConfig } from '@prisma/client';
import {
  autoThreadAccepts,
  buildAutoThreadName,
  defaultAutoThreadConfig,
  normalizeAutoThreadConfig,
  type AutoThreadConfigData,
  type AutoThreadFacts,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';

const CONFIG_TTL_SECONDS = 300;

export interface RuntimeAutoThreadConfig extends AutoThreadConfigData {
  id: string;
  channelId: string;
  position: number;
}

function cacheKey(guildId: string): string {
  return `guild:${guildId}:autothread`;
}

/**
 * Ligne de base -> configuration validée. Une ligne qui ne passe plus la
 * validation (motif devenu invalide) est neutralisée plutôt que d'ouvrir des
 * fils au hasard.
 */
export function toAutoThreadConfigData(row: AutoThreadConfig): AutoThreadConfigData {
  const normalized = normalizeAutoThreadConfig(row);
  if (normalized.ok) return normalized.value;
  return { ...defaultAutoThreadConfig(), name: row.name || 'Configuration', enabled: false };
}

/** Configurations actives du serveur, triées par salon puis par ordre. */
export async function getGuildAutoThreadConfigs(guildId: string): Promise<RuntimeAutoThreadConfig[]> {
  const cached = await cache.get<RuntimeAutoThreadConfig[]>(cacheKey(guildId));
  if (cached) return cached;

  const rows = await prisma.autoThreadConfig
    .findMany({ where: { guildId, enabled: true }, orderBy: [{ channelId: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }] })
    .catch((err) => {
      logger.error('AutoThread', `Lecture des configurations de ${guildId} impossible`, err);
      return null;
    });
  if (!rows) return [];

  const configs = rows
    .map((row) => ({ ...toAutoThreadConfigData(row), id: row.id, channelId: row.channelId, position: row.position }))
    .filter((config) => config.enabled);
  await cache.set(cacheKey(guildId), configs, CONFIG_TTL_SECONDS);
  return configs;
}

/**
 * À appeler après toute écriture. Recalcule au passage le miroir
 * `guild.autoThreadChannels`, que la vue par salon et l'état du serveur lisent.
 */
export async function invalidateAutoThreadConfigs(guildId: string): Promise<void> {
  const rows = await prisma.autoThreadConfig.findMany({
    where: { guildId, enabled: true },
    select: { channelId: true },
    distinct: ['channelId'],
  });
  await prisma.guild.update({
    where: { id: guildId },
    data: { autoThreadChannels: rows.map((row) => row.channelId) },
  }).catch(() => null);
  await cache.delete(cacheKey(guildId));
  await cache.delete(`guild:${guildId}:config`);
}

/**
 * Active ou coupe les fils d'un salon sans passer par l'éditeur : vue par
 * salon, modèles de serveur. Allumer crée une configuration par défaut si le
 * salon n'en a aucune et réactive les siennes sinon ; éteindre les désactive
 * toutes sans les supprimer, pour qu'un rallumage retrouve les réglages.
 */
export async function setAutoThreadChannel(guildId: string, channelId: string, enabled: boolean): Promise<void> {
  const existing = await prisma.autoThreadConfig.count({ where: { guildId, channelId } });
  if (enabled && existing === 0) {
    await prisma.autoThreadConfig.create({ data: { guildId, channelId, namingMode: 'first_line' } });
  } else {
    await prisma.autoThreadConfig.updateMany({ where: { guildId, channelId }, data: { enabled } });
  }
  await invalidateAutoThreadConfigs(guildId);
}

// ── Lecture d'un message ────────────────────────────────────────────────────

const MEDIA_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|mp4|mov|webm|mkv)$/i;

export function autoThreadFactsOf(message: Message<true>): AutoThreadFacts {
  const attachments = [...message.attachments.values()];
  const mediaAttachments = attachments.filter((a) =>
    (a.contentType ?? '').startsWith('image/') || (a.contentType ?? '').startsWith('video/') || MEDIA_EXTENSIONS.test(a.name ?? ''),
  ).length;
  const mediaEmbeds = message.embeds.filter((e) =>
    !!e.image || !!e.video || !!e.thumbnail || ['image', 'video', 'gifv'].includes(String(e.data.type ?? '')),
  ).length;
  const firstEmbed = message.embeds[0];

  return {
    content: message.cleanContent ?? message.content ?? '',
    authorId: message.author.id,
    authorDisplayName: message.member?.displayName || message.author.displayName || message.author.username,
    authorUsername: message.author.username,
    authorRoleIds: message.member ? [...message.member.roles.cache.keys()] : [],
    isBot: message.author.bot,
    isWebhook: !!message.webhookId,
    isReply: !!message.reference?.messageId,
    attachmentCount: attachments.length,
    mediaCount: mediaAttachments + mediaEmbeds + message.stickers.size,
    embedTitle: firstEmbed?.title || firstEmbed?.description || firstEmbed?.author?.name || '',
    channelName: 'name' in message.channel ? message.channel.name : '',
    createdAt: message.createdAt,
  };
}

// ── Rejet ───────────────────────────────────────────────────────────────────

/**
 * Avertissements publiés par le bot, pour qu'ils n'ouvrent pas de fil à leur
 * tour : le bot garde ses propres messages éligibles (les suggestions qu'il
 * relaie veulent leur fil). Vidé à la suppression de l'avertissement.
 */
const warningIds = new Set<string>();

export function isAutoThreadWarning(messageId: string): boolean {
  return warningIds.has(messageId);
}

function rejectText(config: RuntimeAutoThreadConfig, message: Message<true>, locale: BotLocale): string {
  const delay = String(config.rejectDelaySeconds);
  const fallback = locale === 'fr'
    ? config.rejectAction === 'delete'
      ? '{user}, ton message ne correspond pas à ce qu’attend ce salon : il sera retiré dans {delay} s.'
      : '{user}, ton message ne correspond pas à ce qu’attend ce salon.'
    : config.rejectAction === 'delete'
      ? '{user}, your message doesn’t match what this channel expects: it will be removed in {delay}s.'
      : '{user}, your message doesn’t match what this channel expects.';
  return (config.rejectMessage || fallback)
    .replaceAll('{user}', `<@${message.author.id}>`)
    .replaceAll('{channel}', `<#${message.channelId}>`)
    .replaceAll('{delay}', delay)
    .slice(0, 2000);
}

/**
 * Retrait différé du message et de l'avertissement. Un redémarrage pendant le
 * délai les laisse en place : assumé, l'alternative étant une file persistée
 * pour quelques secondes.
 */
function later(seconds: number, task: () => Promise<unknown>): void {
  const timer = setTimeout(() => void task().catch(() => null), seconds * 1000);
  timer.unref?.();
}

async function applyRejection(
  channel: GuildTextBasedChannel,
  message: Message<true>,
  config: RuntimeAutoThreadConfig,
): Promise<void> {
  const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
  if (!me) return;
  const botPerms = me.permissionsIn(channel);

  // Les modérateurs ne sont jamais repris : ils doivent pouvoir écrire une
  // consigne dans un salon de médias sans la voir disparaître.
  const authorPerms = message.member?.permissionsIn(channel);
  if (authorPerms?.has(PermissionFlagsBits.ManageMessages)) return;

  if (config.rejectAction === 'delete' && !botPerms.has(PermissionFlagsBits.ManageMessages)) return;
  if (!botPerms.has(PermissionFlagsBits.SendMessages)) return;

  const locale = await resolveGuildLocale(channel.guild.id);
  const warning = await message.reply({
    content: rejectText(config, message, locale),
    allowedMentions: { users: [message.author.id], repliedUser: true },
  }).catch(() => null);
  if (warning) warningIds.add(warning.id);

  later(config.rejectDelaySeconds, async () => {
    if (config.rejectAction === 'delete') await message.delete().catch(() => null);
    if (warning) {
      await warning.delete().catch(() => null);
      warningIds.delete(warning.id);
    }
  });
}

// ── Création du fil ─────────────────────────────────────────────────────────

/**
 * Traite un message publié dans un salon. Les configurations sont essayées
 * dans l'ordre ; la première qui accepte ouvre le fil. Retourne l'identifiant
 * du fil créé, ou null.
 */
export async function handleAutoThreadMessage(client: Client, message: Message<true>): Promise<string | null> {
  if (message.interaction || message.interactionMetadata || message.flags.has(MessageFlags.Ephemeral)) return null;
  if (warningIds.has(message.id)) return null;

  const channel = message.channel;
  if (channel.isThread()) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return null;

  const configs = (await getGuildAutoThreadConfigs(message.guildId)).filter((c) => c.channelId === channel.id);
  if (configs.length === 0) return null;

  // Messages automatisés : seules les configurations qui les acceptent les
  // évaluent. Les nôtres restent éligibles (suggestions relayées), sans quoi
  // aucune configuration ne pourrait jamais leur ouvrir un fil.
  const automated = message.author.bot || !!message.webhookId;
  const ownMessage = message.author.id === client.user?.id;
  const candidates = automated && !ownMessage ? configs.filter((c) => c.allowBots) : configs;
  if (candidates.length === 0) return null;

  const facts = autoThreadFactsOf(message);
  const match = candidates.find((config) => autoThreadAccepts(config, facts));

  if (!match) {
    // Les messages automatisés ignorés ne sont jamais repris : un bot ne lit
    // pas l'avertissement et la boucle avec un autre bot serait vite trouvée.
    if (automated) return null;
    const policy = configs.find((c) => c.rejectAction !== 'keep');
    if (policy) await applyRejection(channel, message, policy);
    return null;
  }

  const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
  const perms = me?.permissionsIn(channel);
  if (!perms?.has(PermissionFlagsBits.CreatePublicThreads) || !perms.has(PermissionFlagsBits.SendMessagesInThreads)) {
    return null;
  }
  if (message.hasThread) return null;

  const counted = await prisma.autoThreadConfig.update({
    where: { id: match.id },
    data: { threadCount: { increment: 1 } },
    select: { threadCount: true },
  }).catch(() => null);

  const locale = await resolveGuildLocale(message.guildId);
  const name = buildAutoThreadName(match, facts, { locale, count: counted?.threadCount ?? 1 });

  const thread = await message.startThread({
    name,
    autoArchiveDuration: match.archiveMinutes,
    reason: `Fil automatique (${match.name})`,
  }).catch((err: unknown) => {
    logger.error('AutoThread', `Création du fil impossible pour le message ${message.id}`, err);
    return null;
  });
  if (!thread) return null;

  await prisma.autoThreadCreated.create({
    data: { threadId: thread.id, guildId: message.guildId, configId: match.id, authorId: message.author.id },
  }).catch(() => null);

  return thread.id;
}

// ── Renommage ───────────────────────────────────────────────────────────────

export type AutoThreadRenameRefusal = 'not_auto_thread' | 'not_allowed';

/**
 * Le membre peut-il renommer ce fil ? Les modérateurs (Gérer les fils)
 * peuvent toujours ; l'auteur et les autres selon la configuration.
 */
export async function canRenameAutoThread(
  threadId: string,
  memberId: string,
  isModerator: boolean,
): Promise<AutoThreadRenameRefusal | null> {
  const created = await prisma.autoThreadCreated.findUnique({
    where: { threadId },
    include: { config: { select: { renamePermission: true } } },
  });
  if (!created) return 'not_auto_thread';
  if (isModerator) return null;
  const permission = created.config.renamePermission;
  if (permission === 'everyone') return null;
  if (permission === 'author_and_moderators' && created.authorId === memberId) return null;
  return 'not_allowed';
}

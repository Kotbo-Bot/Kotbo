/**
 * Starlight : met en avant les messages qui font réagir.
 *
 * Dès qu'un message dépasse le score configuré (réactions positives moins
 * négatives), le bot le republie en highlight dans un salon dédié : auteur,
 * contenu, images liées, lien vers l'original, et un compteur réactualisé à
 * chaque nouvelle réaction.
 *
 * Deux surfaces de vote alimentent le même score : le message d'origine et
 * l'embed republié. C'est souvent sur le highlight que les membres votent une
 * fois le message sorti de son salon.
 *
 * Le décompte s'appuie sur `reaction.count` plutôt que sur la liste des
 * votants : récupérer les utilisateurs coûterait un appel par tranche de 100
 * réactions à chaque événement, sur des messages qui en cumulent des centaines.
 * Conséquence assumée : un membre qui vote sur les deux surfaces compte deux
 * fois. Les réactions posées par le bot lui-même (amorçage) sont retirées.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildTextBasedChannel,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type ReactionEmoji,
  type GuildEmoji,
} from 'discord.js';
import type { StarboardConfig, StarboardEntry } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { normalizeEmojiKey, tallyVotes } from './starboardTally.js';

export { normalizeEmojiKey } from './starboardTally.js';

/** TTL du cache de configuration. Invalidé explicitement par le dashboard. */
const CONFIG_TTL_SECONDS = 300;

/**
 * Délai d'agrégation avant recalcul. Les réactions arrivent en rafale sur un
 * message qui décolle : sans ça, chaque clic déclencherait un fetch + une
 * édition, et Discord nous couperait au rate limit.
 */
const REFRESH_DEBOUNCE_MS = 4000;

/** Recalculs programmés, par message source. */
const pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
/** Recalculs en cours : empêche deux passes concurrentes sur le même message. */
const refreshing = new Set<string>();

function cacheKey(guildId: string): string {
  return `guild:${guildId}:starboard`;
}

function refreshKey(guildId: string, messageId: string): string {
  return `${guildId}:${messageId}`;
}

// ── Configuration ────────────────────────────────────────────────────────────

export async function getStarboardConfig(guildId: string): Promise<StarboardConfig | null> {
  // L'absence de configuration est mise en cache comme le reste : le module est
  // opt-in, la grande majorité des serveurs n'a pas de ligne et chaque réaction
  // provoquerait sinon une lecture en base.
  const cached = await cache.get<{ config: StarboardConfig | null }>(cacheKey(guildId));
  if (cached) return cached.config;

  const config = await prisma.starboardConfig.findUnique({ where: { guildId } }).catch((err) => {
    logger.error('Starlight', `Lecture de la config de ${guildId} impossible`, err);
    return undefined;
  });
  if (config === undefined) return null;

  await cache.set(cacheKey(guildId), { config }, CONFIG_TTL_SECONDS);
  return config;
}

/** À appeler après toute écriture depuis le dashboard. */
export async function invalidateStarboardCache(guildId: string): Promise<void> {
  await cache.delete(cacheKey(guildId));
}

// ── Emojis ───────────────────────────────────────────────────────────────────

/** Même clé, mais depuis l'emoji d'une réaction reçue. */
function reactionEmojiKey(emoji: GuildEmoji | ReactionEmoji | MessageReaction['emoji']): string {
  return emoji.id ?? emoji.name ?? '';
}

/**
 * Forme utilisable dans `message.react()`. Un emoji custom se réagit avec
 * `nom:id` ; on ne connaît le nom qu'en le résolvant sur le serveur.
 */
function toReactable(client: Client, raw: string): string | null {
  const key = normalizeEmojiKey(raw);
  if (!/^\d{15,25}$/.test(key)) return key || null;
  const emoji = client.emojis.cache.get(key);
  return emoji ? `${emoji.name}:${emoji.id}` : null;
}

/** Forme affichable dans un message (mention Discord pour les emojis custom). */
function toDisplay(client: Client, raw: string): string {
  const key = normalizeEmojiKey(raw);
  if (!/^\d{15,25}$/.test(key)) return key;
  const emoji = client.emojis.cache.get(key);
  return emoji ? emoji.toString() : '⭐';
}

function isVoteEmoji(config: StarboardConfig, key: string): boolean {
  if (!key) return false;
  return config.upvoteEmojis.some((e) => normalizeEmojiKey(e) === key)
    || config.downvoteEmojis.some((e) => normalizeEmojiKey(e) === key);
}

// ── Portée ───────────────────────────────────────────────────────────────────

/**
 * Un salon est surveillé s'il n'est pas exclu et, quand une liste blanche
 * existe, s'il y figure. Pour un fil, le salon parent fait autorité : personne
 * ne configure ses fils un par un, ils naissent et meurent en continu.
 */
function isWatchedChannel(config: StarboardConfig, channelId: string, parentId: string | null): boolean {
  const ids = parentId ? [channelId, parentId] : [channelId];
  if (config.ignoredChannels.some((id) => ids.includes(id))) return false;
  if (config.watchedChannels.length === 0) return true;
  return config.watchedChannels.some((id) => ids.includes(id));
}

function channelParentId(message: Message): string | null {
  const channel = message.channel;
  if (channel.isThread()) return channel.parentId;
  return null;
}

// ── Décompte ─────────────────────────────────────────────────────────────────

/**
 * Additionne les réactions de vote d'un message. La réaction du bot (amorçage
 * automatique) est retirée : elle n'est le vote de personne. Celle de l'auteur
 * l'est aussi quand `excludedUserId` est fourni : on ne vote pas pour soi.
 */
async function tallyMessage(
  message: Message,
  config: StarboardConfig,
  excludedUserId: string | null,
): Promise<{ up: number; down: number }> {
  const votes = await Promise.all([...message.reactions.cache.values()].map(async (reaction) => {
    const key = reactionEmojiKey(reaction.emoji);
    // Pas d'appel à Discord quand seul le bot a réagi : il n'y a rien à retirer.
    const hasOtherVoters = reaction.count > (reaction.me ? 1 : 0);
    const byAuthor = excludedUserId !== null && hasOtherVoters && isVoteEmoji(config, key)
      ? await hasReacted(reaction, excludedUserId)
      : false;
    return { key, count: reaction.count, me: reaction.me, byAuthor };
  }));
  return tallyVotes(votes, config);
}

/**
 * Discord liste les votants par id croissant, par pages de 100 : demander le
 * premier votant situé juste après `userId - 1` répond en un seul appel, quel
 * que soit le nombre de réactions.
 */
async function hasReacted(reaction: MessageReaction, userId: string): Promise<boolean> {
  if (reaction.users.cache.has(userId)) return true;
  const after = (BigInt(userId) - 1n).toString();
  const users = await reaction.users.fetch({ limit: 1, after }).catch(() => null);
  return users?.has(userId) ?? false;
}

// ── Rendu du highlight ───────────────────────────────────────────────────────

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i;

/**
 * Images liées au message : pièces jointes d'abord, puis celles portées par les
 * embeds (lien d'image collé, aperçu de tweet...).
 */
function collectImages(message: Message): string[] {
  const urls: string[] = [];

  for (const attachment of message.attachments.values()) {
    if (attachment.contentType?.startsWith('image/') || IMAGE_EXT.test(attachment.url)) {
      urls.push(attachment.url);
    }
  }
  for (const embed of message.embeds) {
    const url = embed.image?.url ?? embed.thumbnail?.url;
    if (url) urls.push(url);
  }

  return [...new Set(urls)].slice(0, 4);
}

/** Pièces jointes non affichables en image : listées en liens. */
function collectOtherAttachments(message: Message): string[] {
  return [...message.attachments.values()]
    .filter((a) => !(a.contentType?.startsWith('image/') || IMAGE_EXT.test(a.url)))
    .map((a) => `[${a.name ?? 'fichier'}](${a.url})`)
    .slice(0, 5);
}

function parseColor(hex: string): number {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? Number.parseInt(hex.slice(1), 16) : 0xf5c518;
}

async function buildHighlightPayload(
  client: Client,
  message: Message,
  config: StarboardConfig,
  tally: { up: number; down: number; score: number },
) {
  const locale = await resolveGuildLocale(message.guildId!, message.guild?.preferredLocale ?? null);
  const jumpUrl = message.url;
  const upDisplay = toDisplay(client, config.upvoteEmojis[0] ?? '⭐');

  const author = message.member?.displayName ?? message.author.displayName ?? message.author.username;
  const images = collectImages(message);
  const others = collectOtherAttachments(message);

  const main = new EmbedBuilder()
    .setColor(parseColor(config.embedColor))
    .setURL(jumpUrl)
    .setAuthor({ name: author, iconURL: message.author.displayAvatarURL() })
    .setTimestamp(message.createdAt);

  const content = message.content?.trim();
  if (content) main.setDescription(content.slice(0, 4000));
  if (images[0]) main.setImage(images[0]);
  if (others.length > 0) {
    main.addFields({ name: m.starboard_attachments_field({}, { locale }), value: others.join('\n').slice(0, 1024) });
  }
  if (config.downvoteEmojis.length > 0) {
    main.setFooter({ text: m.starboard_footer_votes({ up: String(tally.up), down: String(tally.down) }, { locale }) });
  }

  // Discord regroupe en galerie les embeds partageant la même URL : c'est le
  // seul moyen d'afficher plusieurs images sous un même highlight.
  const embeds = [main];
  for (const url of images.slice(1)) {
    embeds.push(new EmbedBuilder().setURL(jumpUrl).setImage(url).setColor(parseColor(config.embedColor)));
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(m.starboard_jump_button({}, { locale }))
      .setURL(jumpUrl),
  );

  return {
    content: `${upDisplay} **${tally.score}** | <#${message.channelId}>`,
    embeds,
    components: [row],
    allowedMentions: { parse: [] as never[] },
  };
}

// ── Amorçage des réactions ───────────────────────────────────────────────────

/**
 * Pose les emojis de vote sur un message. Séquentiel et tolérant : un emoji
 * custom retiré du serveur ne doit pas empêcher les suivants.
 */
async function seedReactions(client: Client, message: Message, config: StarboardConfig): Promise<void> {
  for (const raw of [...config.upvoteEmojis, ...config.downvoteEmojis]) {
    const reactable = toReactable(client, raw);
    if (!reactable) continue;
    await message.react(reactable).catch(() => null);
  }
}

/**
 * Amorce les nouveaux messages des salons configurés (boîte à suggestions :
 * pouce haut / pouce bas posés d'office). Appelé pour chaque message de guilde.
 */
export async function handleStarboardMessage(client: Client, message: Message): Promise<void> {
  if (!message.guildId || message.author.id === client.user?.id) return;

  const config = await getStarboardConfig(message.guildId);
  if (!config?.enabled || config.autoReactChannels.length === 0) return;
  if (message.author.bot && !config.allowBots) return;

  const parentId = channelParentId(message);
  const ids = parentId ? [message.channelId, parentId] : [message.channelId];
  if (!config.autoReactChannels.some((id) => ids.includes(id))) return;

  await seedReactions(client, message, config);
}

// ── Boucle de recalcul ───────────────────────────────────────────────────────

/**
 * Point d'entrée des événements de réaction (ajout comme retrait). Détermine le
 * message source concerné - le highlight republié renvoie vers lui - puis
 * programme un recalcul.
 */
export async function handleStarboardReaction(
  client: Client,
  reaction: MessageReaction | PartialMessageReaction,
): Promise<void> {
  const guildId = reaction.message.guildId;
  if (!guildId) return;

  const config = await getStarboardConfig(guildId);
  if (!config?.enabled || !config.channelId) return;
  if (!isVoteEmoji(config, reactionEmojiKey(reaction.emoji))) return;

  // Réaction posée sur un highlight : on remonte au message d'origine.
  if (reaction.message.channelId === config.channelId) {
    if (!config.countEmbedReactions) return;
    const entry = await prisma.starboardEntry.findFirst({
      where: { guildId, starMessageId: reaction.message.id },
    }).catch(() => null);
    if (!entry) return;
    scheduleRefresh(client, guildId, entry.channelId, entry.messageId);
    return;
  }

  const message = reaction.message;
  const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
  if (!isWatchedChannel(config, message.channelId, parentId)) return;

  scheduleRefresh(client, guildId, message.channelId, message.id);
}

/**
 * Purge complète des réactions d'un message : le score s'effondre d'un coup.
 * Le message purgé peut être le highlight comme la source, d'où la résolution.
 */
export async function handleStarboardReactionPurge(
  client: Client,
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const config = await getStarboardConfig(guildId);
  if (!config?.enabled || !config.channelId) return;

  if (channelId === config.channelId) {
    const entry = await prisma.starboardEntry.findFirst({
      where: { guildId, starMessageId: messageId },
    }).catch(() => null);
    if (!entry) return;
    scheduleRefresh(client, guildId, entry.channelId, entry.messageId);
    return;
  }

  scheduleRefresh(client, guildId, channelId, messageId);
}

/** Agrège les rafales de réactions en un seul recalcul par message. */
export function scheduleRefresh(client: Client, guildId: string, channelId: string, messageId: string): void {
  const key = refreshKey(guildId, messageId);
  const existing = pendingRefreshes.get(key);
  if (existing) clearTimeout(existing);

  pendingRefreshes.set(key, setTimeout(() => {
    pendingRefreshes.delete(key);
    void refreshEntry(client, guildId, channelId, messageId).catch((err) =>
      logger.error('Starlight', `Recalcul du message ${messageId} impossible`, err),
    );
  }, REFRESH_DEBOUNCE_MS));
}

function resolveTextChannel(client: Client, channelId: string): GuildTextBasedChannel | null {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  return channel as GuildTextBasedChannel;
}

/**
 * Recalcule le score d'un message et aligne son highlight : publication au
 * franchissement du seuil, édition du compteur ensuite, retrait si le score
 * redescend (quand l'option est active).
 */
export async function refreshEntry(
  client: Client,
  guildId: string,
  channelId: string,
  messageId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const key = refreshKey(guildId, messageId);
  if (refreshing.has(key)) return;
  refreshing.add(key);

  try {
    const config = await getStarboardConfig(guildId);
    if (!config?.enabled || !config.channelId) return;

    const entry = await prisma.starboardEntry.findUnique({
      where: { guildId_messageId: { guildId, messageId } },
    }).catch(() => null);

    const sourceChannel = resolveTextChannel(client, channelId)
      ?? (await client.channels.fetch(channelId).catch(() => null)) as GuildTextBasedChannel | null;
    const message = sourceChannel
      ? await sourceChannel.messages.fetch(messageId).catch(() => null)
      : null;

    // Message source disparu : on retire le highlight, il ne mène plus nulle part.
    if (!message) {
      if (entry) await removeEntry(client, entry);
      return;
    }
    if (message.author.bot && !config.allowBots) return;

    // Le bot peut être l'auteur (allowBots) : sa réaction est déjà retirée.
    const excludedUserId = config.ignoreAuthorVotes && message.author.id !== client.user?.id
      ? message.author.id
      : null;
    const source = await tallyMessage(message, config, excludedUserId);
    let up = source.up;
    let down = source.down;

    // Réactions posées sur le highlight lui-même.
    if (config.countEmbedReactions && entry?.starMessageId) {
      const starChannel = resolveTextChannel(client, entry.starChannelId ?? config.channelId);
      const starMessage = starChannel
        ? await starChannel.messages.fetch(entry.starMessageId).catch(() => null)
        : null;
      if (starMessage) {
        const starTally = await tallyMessage(starMessage, config, excludedUserId);
        up += starTally.up;
        down += starTally.down;
      }
    }

    const score = up - down;
    const threshold = Math.max(1, config.threshold);

    // Sous le seuil et jamais publié : on ne crée pas de ligne pour rien.
    if (score < threshold && !entry) return;

    if (score < threshold && entry) {
      if (entry.starMessageId && config.removeBelowThreshold) {
        await removeEntry(client, entry, { keepRow: true });
        return;
      }
      await prisma.starboardEntry.update({
        where: { id: entry.id },
        data: { upvotes: up, downvotes: down, score, peakScore: Math.max(entry.peakScore, score) },
      }).catch(() => null);
      // Le highlight publié reste affiché : son compteur doit suivre.
      if (entry.starMessageId) await editHighlight(client, entry, message, config, { up, down, score });
      return;
    }

    const record = entry ?? await prisma.starboardEntry.create({
      data: {
        guildId,
        channelId,
        messageId,
        authorId: message.author.id,
        upvotes: up,
        downvotes: down,
        score,
        peakScore: score,
      },
    }).catch((err) => {
      logger.error('Starlight', `Création de l'entrée ${messageId} impossible`, err);
      return null;
    });
    if (!record) return;

    if (record.starMessageId && !options.force) {
      await editHighlight(client, record, message, config, { up, down, score });
    } else {
      await postHighlight(client, record, message, config, { up, down, score });
    }

    await prisma.starboardEntry.update({
      where: { id: record.id },
      data: { upvotes: up, downvotes: down, score, peakScore: Math.max(record.peakScore, score) },
    }).catch(() => null);
  } finally {
    refreshing.delete(key);
  }
}

/** Publie le highlight et l'amorce des emojis de vote si demandé. */
async function postHighlight(
  client: Client,
  entry: StarboardEntry,
  message: Message,
  config: StarboardConfig,
  tally: { up: number; down: number; score: number },
): Promise<void> {
  const channel = resolveTextChannel(client, config.channelId!);
  if (!channel) return;

  const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
  if (!me) return;
  const perms = me.permissionsIn(channel);
  if (!perms.has(PermissionFlagsBits.ViewChannel)
    || !perms.has(PermissionFlagsBits.SendMessages)
    || !perms.has(PermissionFlagsBits.EmbedLinks)) {
    logger.warn('Starlight', `Permissions insuffisantes dans le salon ${config.channelId} de ${entry.guildId}`);
    return;
  }

  // Un highlight déjà publié doit disparaître avant d'être remplacé.
  if (entry.starMessageId) {
    const previous = await channel.messages.fetch(entry.starMessageId).catch(() => null);
    await previous?.delete().catch(() => null);
  }

  const payload = await buildHighlightPayload(client, message, config, tally);
  const sent = await channel.send(payload).catch((err: unknown) => {
    logger.error('Starlight', `Publication du highlight de ${entry.messageId} impossible`, err);
    return null;
  });
  if (!sent) return;

  await prisma.starboardEntry.update({
    where: { id: entry.id },
    data: { starMessageId: sent.id, starChannelId: channel.id, postedAt: new Date() },
  }).catch(() => null);

  if (config.autoReactEmbed && perms.has(PermissionFlagsBits.AddReactions)) {
    await seedReactions(client, sent, config);
  }
}

/** Réactualise le compteur d'un highlight déjà publié. */
async function editHighlight(
  client: Client,
  entry: StarboardEntry,
  message: Message,
  config: StarboardConfig,
  tally: { up: number; down: number; score: number },
): Promise<void> {
  if (!entry.starMessageId) return;

  const channel = resolveTextChannel(client, entry.starChannelId ?? config.channelId!);
  const starMessage = channel
    ? await channel.messages.fetch(entry.starMessageId).catch(() => null)
    : null;

  // Highlight supprimé à la main : on le republie plutôt que d'échouer en boucle.
  if (!starMessage) {
    await prisma.starboardEntry.update({
      where: { id: entry.id },
      data: { starMessageId: null, starChannelId: null },
    }).catch(() => null);
    await postHighlight(client, { ...entry, starMessageId: null }, message, config, tally);
    return;
  }

  const payload = await buildHighlightPayload(client, message, config, tally);
  await starMessage.edit(payload).catch((err: unknown) =>
    logger.error('Starlight', `Édition du highlight de ${entry.messageId} impossible`, err),
  );
}

/**
 * Retire le highlight publié. `keepRow` conserve la ligne (score redescendu
 * sous le seuil) ; sinon l'entrée disparaît avec son message source.
 */
async function removeEntry(
  client: Client,
  entry: StarboardEntry,
  options: { keepRow?: boolean } = {},
): Promise<void> {
  if (entry.starMessageId) {
    const channel = resolveTextChannel(client, entry.starChannelId ?? '');
    const starMessage = channel
      ? await channel.messages.fetch(entry.starMessageId).catch(() => null)
      : null;
    await starMessage?.delete().catch(() => null);
  }

  if (options.keepRow) {
    await prisma.starboardEntry.update({
      where: { id: entry.id },
      data: { starMessageId: null, starChannelId: null, postedAt: null },
    }).catch(() => null);
    return;
  }

  await prisma.starboardEntry.delete({ where: { id: entry.id } }).catch(() => null);
}

/**
 * Message source supprimé : le highlight pointe dans le vide, on le retire.
 * Couvre aussi la suppression du highlight lui-même (l'entrée est alors
 * détachée, un futur vote la republiera).
 */
export async function handleStarboardMessageDelete(
  client: Client,
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const config = await getStarboardConfig(guildId);
  if (!config?.enabled) return;

  if (config.channelId === channelId) {
    const entry = await prisma.starboardEntry.findFirst({
      where: { guildId, starMessageId: messageId },
    }).catch(() => null);
    if (!entry) return;
    await prisma.starboardEntry.update({
      where: { id: entry.id },
      data: { starMessageId: null, starChannelId: null, postedAt: null },
    }).catch(() => null);
    return;
  }

  const entry = await prisma.starboardEntry.findUnique({
    where: { guildId_messageId: { guildId, messageId } },
  }).catch(() => null);
  if (!entry) return;

  await removeEntry(client, entry);
}

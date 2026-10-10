/**
 * Forum du site communautaire.
 *
 * Une catégorie est propre au site, ou le miroir d'un salon forum Discord :
 *  - Discord → site : chaque fil devient un sujet, chaque message un message
 *    (création, modification, suppression) ;
 *  - site → Discord : un sujet ouvert ou une réponse écrite sur le site part
 *    dans le salon par le webhook de la catégorie, au nom et avec l'avatar du
 *    membre. Les messages de ce webhook sont ignorés au retour.
 *
 * Le contenu est du Markdown Discord dans les deux sens ; le site l'affiche
 * avec le même rendu que les blocs « Discord en direct ».
 */

import {
  ChannelType,
  ForumChannel,
  PermissionFlagsBits,
  WebhookClient,
  type AnyThreadChannel,
  type Client,
  type Message,
  type PartialMessage,
} from 'discord.js';
import type { SiteForumCategory, SiteForumTopic } from '@prisma/client';
import { slugify } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { openSecret, sealSecret } from '../../utils/secretBox.js';
import { publishGuildSignal } from './siteLive.js';
import { getSiteByGuild } from './siteService.js';

export const FORUM_LIMITS = { categories: 30, name: 60, description: 300, title: 100, content: 2000, pageSize: 25 } as const;

export type ForumErrorCode =
  | 'site_missing'
  | 'category_missing'
  | 'topic_missing'
  | 'post_missing'
  | 'name_required'
  | 'slug_taken'
  | 'channel_invalid'
  | 'webhook_failed'
  | 'too_many_categories'
  | 'title_required'
  | 'content_required'
  | 'forbidden'
  | 'locked'
  | 'discord_failed';

export class ForumError extends Error {
  constructor(
    readonly code: ForumErrorCode,
    readonly status = 400,
  ) {
    super(code);
  }
}

const SNOWFLAKE = /^\d{17,20}$/;

// ─── Catégories (administration) ────────────────────────────────────────────

export async function listForumCategories(siteId: string) {
  const categories = await prisma.siteForumCategory.findMany({ where: { siteId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  const counts = await prisma.siteForumTopic.groupBy({ by: ['categoryId'], where: { categoryId: { in: categories.map((c) => c.id) }, deletedAt: null }, _count: { _all: true }, _max: { lastPostAt: true } });
  const by = new Map(counts.map((c) => [c.categoryId, c]));
  return categories.map(({ webhookToken: _token, ...category }) => ({
    ...category,
    topicCount: by.get(category.id)?._count._all ?? 0,
    lastPostAt: by.get(category.id)?._max.lastPostAt ?? null,
  }));
}

function channelCacheKey(channelId: string) {
  return `site-forum:channel:${channelId}`;
}

/** Ouvre (ou reprend) le webhook par lequel le site écrit dans le salon forum. */
async function ensureWebhook(client: Client, channelId: string, current: { webhookId: string | null; webhookToken: string | null }) {
  const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!(channel instanceof ForumChannel)) throw new ForumError('channel_invalid');
  const me = channel.guild.members.me;
  if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    throw new ForumError('webhook_failed');
  }
  if (current.webhookId && current.webhookToken) {
    const hooks = await channel.fetchWebhooks().catch(() => null);
    if (hooks?.has(current.webhookId)) return { webhookId: current.webhookId, webhookToken: current.webhookToken };
  }
  const hook = await channel.createWebhook({ name: 'Kotbo · site', reason: 'Forum du site communautaire' }).catch(() => null);
  if (!hook?.token) throw new ForumError('webhook_failed');
  return { webhookId: hook.id, webhookToken: sealSecret(hook.token) };
}

export async function saveForumCategory(client: Client, guildId: string, id: string | null, raw: Record<string, unknown>) {
  const site = await getSiteByGuild(guildId);
  if (!site) throw new ForumError('site_missing', 404);
  const existing = id ? await prisma.siteForumCategory.findFirst({ where: { id, guildId } }) : null;
  if (id && !existing) throw new ForumError('category_missing', 404);

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, FORUM_LIMITS.name) : existing?.name ?? '';
  if (!name) throw new ForumError('name_required');
  const slug = slugify(typeof raw.slug === 'string' && raw.slug.trim() ? raw.slug : existing?.slug ?? name, 40) || 'forum';
  const mode = raw.mode === 'MIRROR' || raw.mode === 'SITE' ? raw.mode : existing?.mode ?? 'SITE';
  const channelId = mode === 'MIRROR' ? (typeof raw.channelId === 'string' && SNOWFLAKE.test(raw.channelId) ? raw.channelId : existing?.channelId ?? null) : null;
  if (mode === 'MIRROR' && !channelId) throw new ForumError('channel_invalid');
  if (channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildForum || channel.guildId !== guildId) throw new ForumError('channel_invalid');
    const taken = await prisma.siteForumCategory.findFirst({ where: { channelId, NOT: id ? { id } : undefined }, select: { id: true } });
    if (taken) throw new ForumError('channel_invalid');
  }

  const hook = channelId
    ? await ensureWebhook(client, channelId, channelId === existing?.channelId ? { webhookId: existing.webhookId, webhookToken: existing.webhookToken } : { webhookId: null, webhookToken: null })
    : { webhookId: null, webhookToken: null };

  const data = {
    name,
    slug,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, FORUM_LIMITS.description) : existing?.description ?? '',
    mode,
    channelId,
    ...hook,
    writeRoleIds: Array.isArray(raw.writeRoleIds)
      ? [...new Set(raw.writeRoleIds.filter((v): v is string => typeof v === 'string' && SNOWFLAKE.test(v)))].slice(0, 20)
      : existing?.writeRoleIds ?? [],
    staffTopicsOnly: typeof raw.staffTopicsOnly === 'boolean' ? raw.staffTopicsOnly : existing?.staffTopicsOnly ?? false,
  };

  try {
    const saved = existing
      ? await prisma.siteForumCategory.update({ where: { id: existing.id }, data })
      : await (async () => {
          const total = await prisma.siteForumCategory.count({ where: { siteId: site.id } });
          if (total >= FORUM_LIMITS.categories) throw new ForumError('too_many_categories', 409);
          return prisma.siteForumCategory.create({ data: { ...data, siteId: site.id, guildId, sortOrder: total } });
        })();
    if (existing?.channelId) await cache.delete(channelCacheKey(existing.channelId));
    if (saved.channelId) await cache.delete(channelCacheKey(saved.channelId));
    // Nouveau miroir : on rapatrie les fils récents en arrière-plan.
    if (saved.channelId && saved.channelId !== existing?.channelId) {
      void importForumHistory(client, saved.id).catch((err: unknown) => logger.warn('SiteForum', `Import du forum ${saved.channelId} en échec :`, err));
    }
    publishGuildSignal(guildId, 'forum:index');
    return saved;
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') throw new ForumError('slug_taken', 409);
    throw err;
  }
}

export async function deleteForumCategory(client: Client, guildId: string, id: string): Promise<void> {
  const category = await prisma.siteForumCategory.findFirst({ where: { id, guildId } });
  if (!category) return;
  await prisma.siteForumCategory.delete({ where: { id } });
  if (category.channelId) {
    await cache.delete(channelCacheKey(category.channelId));
    if (category.webhookId) {
      const hook = await client.fetchWebhook(category.webhookId).catch(() => null);
      await hook?.delete('Forum du site supprimé').catch(() => null);
    }
  }
  publishGuildSignal(guildId, 'forum:index');
}

export async function reorderForumCategories(guildId: string, ids: unknown): Promise<void> {
  if (!Array.isArray(ids)) return;
  await prisma.$transaction(
    ids
      .filter((id): id is string => typeof id === 'string')
      .slice(0, FORUM_LIMITS.categories)
      .map((id, index) => prisma.siteForumCategory.updateMany({ where: { id, guildId }, data: { sortOrder: index } })),
  );
}

// ─── Lecture publique ───────────────────────────────────────────────────────

export async function getForumCategoryBySlug(siteId: string, slug: string) {
  return prisma.siteForumCategory.findUnique({ where: { siteId_slug: { siteId, slug } } });
}

export async function listForumTopics(categoryId: string, page: number) {
  const where = { categoryId, deletedAt: null };
  const [total, topics] = await Promise.all([
    prisma.siteForumTopic.count({ where }),
    prisma.siteForumTopic.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { lastPostAt: 'desc' }],
      skip: (page - 1) * FORUM_LIMITS.pageSize,
      take: FORUM_LIMITS.pageSize,
    }),
  ]);
  return { total, topics, pages: Math.max(1, Math.ceil(total / FORUM_LIMITS.pageSize)) };
}

export async function getForumTopic(categoryId: string, topicId: string) {
  return prisma.siteForumTopic.findFirst({ where: { id: topicId, categoryId, deletedAt: null } });
}

export async function listForumPosts(topicId: string, page: number) {
  const where = { topicId, deletedAt: null };
  const [total, posts] = await Promise.all([
    prisma.siteForumPost.count({ where }),
    prisma.siteForumPost.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (page - 1) * FORUM_LIMITS.pageSize, take: FORUM_LIMITS.pageSize }),
  ]);
  return { total, posts, pages: Math.max(1, Math.ceil(total / FORUM_LIMITS.pageSize)) };
}

// ─── Écriture depuis le site ────────────────────────────────────────────────

export interface ForumAuthor {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  roleIds: string[];
  isStaff: boolean;
}

export function canWriteInCategory(category: Pick<SiteForumCategory, 'writeRoleIds'>, author: ForumAuthor): boolean {
  if (author.isStaff) return true;
  return category.writeRoleIds.length === 0 || category.writeRoleIds.some((id) => author.roleIds.includes(id));
}

function webhookOf(category: SiteForumCategory): WebhookClient | null {
  if (!category.webhookId || !category.webhookToken) return null;
  const token = openSecret(category.webhookToken);
  return token ? new WebhookClient({ id: category.webhookId, token }) : null;
}

function cleanContent(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

async function touchTopic(topicId: string, by: string, at: Date): Promise<void> {
  const replies = await prisma.siteForumPost.count({ where: { topicId, deletedAt: null } });
  await prisma.siteForumTopic.update({ where: { id: topicId }, data: { replyCount: Math.max(0, replies - 1), lastPostAt: at, lastPostBy: by } });
}

export async function createForumTopic(client: Client, category: SiteForumCategory, author: ForumAuthor, rawTitle: unknown, rawContent: unknown): Promise<SiteForumTopic> {
  if (!canWriteInCategory(category, author) || (category.staffTopicsOnly && !author.isStaff)) throw new ForumError('forbidden', 403);
  const title = cleanContent(rawTitle, FORUM_LIMITS.title).replace(/\n/g, ' ');
  const content = cleanContent(rawContent, FORUM_LIMITS.content);
  if (!title) throw new ForumError('title_required');
  if (!content) throw new ForumError('content_required');

  let threadId: string | null = null;
  let messageId: string | null = null;
  if (category.mode === 'MIRROR' && category.channelId) {
    const hook = webhookOf(category);
    const channel = client.channels.cache.get(category.channelId);
    if (!hook || !(channel instanceof ForumChannel)) throw new ForumError('discord_failed', 502);
    // Un forum qui exige une étiquette refuse un fil sans : on prend la première.
    const requireTag = channel.flags.has('RequireTag');
    const sent = await hook
      .send({
        content,
        username: author.displayName.slice(0, 80),
        avatarURL: author.avatarUrl ?? undefined,
        threadName: title,
        appliedTags: requireTag && channel.availableTags[0] ? [channel.availableTags[0].id] : undefined,
        allowedMentions: { parse: [] },
      })
      .catch((err: unknown) => {
        logger.warn('SiteForum', `Sujet non publié sur Discord (${category.channelId}) :`, err);
        return null;
      });
    if (!sent) throw new ForumError('discord_failed', 502);
    threadId = sent.channel_id;
    messageId = sent.id;
  }

  const now = new Date();
  const topic = await prisma.siteForumTopic.create({
    data: {
      categoryId: category.id,
      guildId: category.guildId,
      title,
      authorId: author.userId,
      threadId,
      lastPostAt: now,
      lastPostBy: author.userId,
      posts: { create: { guildId: category.guildId, authorId: author.userId, authorName: author.displayName, authorAvatar: author.avatarUrl, content, messageId, source: 'site', createdAt: now } },
    },
  });
  publishGuildSignal(category.guildId, `forum:${category.id}`);
  return topic;
}

export async function replyToForumTopic(client: Client, category: SiteForumCategory, topic: SiteForumTopic, author: ForumAuthor, rawContent: unknown) {
  if (!canWriteInCategory(category, author)) throw new ForumError('forbidden', 403);
  if (topic.locked && !author.isStaff) throw new ForumError('locked', 403);
  const content = cleanContent(rawContent, FORUM_LIMITS.content);
  if (!content) throw new ForumError('content_required');

  let messageId: string | null = null;
  if (category.mode === 'MIRROR' && topic.threadId) {
    const hook = webhookOf(category);
    if (!hook) throw new ForumError('discord_failed', 502);
    const sent = await hook
      .send({ content, username: author.displayName.slice(0, 80), avatarURL: author.avatarUrl ?? undefined, threadId: topic.threadId, allowedMentions: { parse: [] } })
      .catch((err: unknown) => {
        logger.warn('SiteForum', `Réponse non publiée sur Discord (${topic.threadId}) :`, err);
        return null;
      });
    if (!sent) throw new ForumError('discord_failed', 502);
    messageId = sent.id;
  }

  const now = new Date();
  const post = await prisma.siteForumPost.create({
    data: { topicId: topic.id, guildId: topic.guildId, authorId: author.userId, authorName: author.displayName, authorAvatar: author.avatarUrl, content, messageId, source: 'site', createdAt: now },
  });
  await touchTopic(topic.id, author.userId, now);
  publishGuildSignal(topic.guildId, `forum:${topic.id}`);
  publishGuildSignal(topic.guildId, `forum:${category.id}`);
  return post;
}

/** L'auteur retire son message ; le staff, n'importe lequel. Le premier message d'un sujet retire le sujet. */
export async function deleteForumPost(client: Client, guildId: string, postId: string, actor: { userId: string; isStaff: boolean }): Promise<void> {
  const post = await prisma.siteForumPost.findFirst({ where: { id: postId, guildId, deletedAt: null }, include: { topic: { include: { category: true } } } });
  if (!post) throw new ForumError('post_missing', 404);
  if (post.authorId !== actor.userId && !actor.isStaff) throw new ForumError('forbidden', 403);
  const first = await prisma.siteForumPost.findFirst({ where: { topicId: post.topicId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  const now = new Date();
  await prisma.siteForumPost.update({ where: { id: post.id }, data: { deletedAt: now } });
  if (first?.id === post.id) await prisma.siteForumTopic.update({ where: { id: post.topicId }, data: { deletedAt: now } });
  else await touchTopic(post.topicId, post.topic.lastPostBy ?? post.authorId, post.topic.lastPostAt);

  // Un message écrit depuis le site disparaît aussi de Discord.
  if (post.messageId && post.source === 'site' && post.topic.threadId) {
    const hook = webhookOf(post.topic.category);
    await hook?.deleteMessage(post.messageId, post.topic.threadId).catch(() => null);
  }
  publishGuildSignal(guildId, `forum:${post.topicId}`);
  publishGuildSignal(guildId, `forum:${post.topic.categoryId}`);
}

export async function setForumTopicFlags(guildId: string, topicId: string, flags: { pinned?: boolean; locked?: boolean }): Promise<void> {
  const updated = await prisma.siteForumTopic.updateMany({
    where: { id: topicId, guildId },
    data: { ...(typeof flags.pinned === 'boolean' ? { pinned: flags.pinned } : {}), ...(typeof flags.locked === 'boolean' ? { locked: flags.locked } : {}) },
  });
  if (updated.count === 0) throw new ForumError('topic_missing', 404);
  publishGuildSignal(guildId, `forum:${topicId}`);
}

export async function listRecentForumPosts(guildId: string, limit = 50) {
  return prisma.siteForumPost.findMany({
    where: { guildId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, limit),
    include: { topic: { select: { id: true, title: true, pinned: true, locked: true, category: { select: { name: true, slug: true } } } } },
  });
}

// ─── Discord → site ─────────────────────────────────────────────────────────

interface MirrorRef {
  id: string | null;
  guildId: string;
  webhookId: string | null;
}

/** Catégorie miroir d'un salon forum, mise en cache (y compris l'absence). */
async function mirrorOf(channelId: string | null | undefined): Promise<MirrorRef | null> {
  if (!channelId) return null;
  const ref = await cache.wrap<MirrorRef>(channelCacheKey(channelId), 300, async () => {
    const category = await prisma.siteForumCategory.findFirst({ where: { channelId, mode: 'MIRROR' }, select: { id: true, guildId: true, webhookId: true } });
    return category ?? { id: null, guildId: '', webhookId: null };
  });
  return ref.id ? ref : null;
}

function attachmentsOf(message: Message): Array<{ name: string; url: string; contentType: string | null }> {
  return [...message.attachments.values()].slice(0, 10).map((a) => ({ name: a.name, url: a.url, contentType: a.contentType ?? null }));
}

async function ensureTopicForThread(thread: AnyThreadChannel, categoryId: string): Promise<SiteForumTopic> {
  const existing = await prisma.siteForumTopic.findUnique({ where: { threadId: thread.id } });
  if (existing) return existing;
  try {
    return await prisma.siteForumTopic.create({
      data: {
        categoryId,
        guildId: thread.guildId,
        title: thread.name.slice(0, FORUM_LIMITS.title),
        authorId: thread.ownerId ?? '0',
        threadId: thread.id,
        locked: Boolean(thread.locked),
        createdAt: thread.createdAt ?? new Date(),
        lastPostAt: thread.createdAt ?? new Date(),
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return prisma.siteForumTopic.findUniqueOrThrow({ where: { threadId: thread.id } });
    throw err;
  }
}

async function storeDiscordMessage(message: Message, categoryId: string): Promise<boolean> {
  if (!message.channel.isThread()) return false;
  const text = message.content.trim();
  const attachments = attachmentsOf(message);
  if (!text && attachments.length === 0) return false;
  const topic = await ensureTopicForThread(message.channel, categoryId);
  const authorName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
  try {
    await prisma.siteForumPost.create({
      data: {
        topicId: topic.id,
        guildId: topic.guildId,
        authorId: message.author.id,
        authorName: authorName.slice(0, 80),
        authorAvatar: (message.member ?? message.author).displayAvatarURL({ size: 64 }),
        content: text.slice(0, 4000),
        attachments,
        messageId: message.id,
        source: 'discord',
        createdAt: message.createdAt,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return false;
    throw err;
  }
  if (topic.authorId === '0' && message.id === message.channel.id) {
    await prisma.siteForumTopic.update({ where: { id: topic.id }, data: { authorId: message.author.id } });
  }
  await touchTopic(topic.id, message.author.id, message.createdAt);
  return true;
}

export async function handleForumMessageCreate(message: Message): Promise<void> {
  if (!message.guildId || message.system || !message.channel.isThread()) return;
  const mirror = await mirrorOf(message.channel.parentId);
  if (!mirror) return;
  // Le webhook du site : déjà enregistré au moment de l'envoi.
  if (message.webhookId && message.webhookId === mirror.webhookId) return;
  if (await storeDiscordMessage(message, mirror.id!)) {
    const topic = await prisma.siteForumTopic.findUnique({ where: { threadId: message.channel.id }, select: { id: true } });
    if (topic) publishGuildSignal(message.guildId, `forum:${topic.id}`);
    publishGuildSignal(message.guildId, `forum:${mirror.id}`);
  }
}

export async function handleForumMessageUpdate(message: Message | PartialMessage): Promise<void> {
  if (!message.guildId || !message.channel.isThread()) return;
  const mirror = await mirrorOf(message.channel.parentId);
  if (!mirror) return;
  const full = message.partial ? await message.fetch().catch(() => null) : message;
  if (!full) return;
  const updated = await prisma.siteForumPost.updateMany({
    where: { messageId: full.id, source: 'discord' },
    data: { content: full.content.trim().slice(0, 4000), attachments: attachmentsOf(full), editedAt: full.editedAt ?? new Date() },
  });
  if (updated.count > 0) {
    const post = await prisma.siteForumPost.findUnique({ where: { messageId: full.id }, select: { topicId: true } });
    if (post) publishGuildSignal(message.guildId, `forum:${post.topicId}`);
  }
}

export async function handleForumMessageDelete(message: Message | PartialMessage): Promise<void> {
  if (!message.guildId) return;
  const post = await prisma.siteForumPost.findUnique({ where: { messageId: message.id }, include: { topic: true } });
  if (!post || post.deletedAt) return;
  const now = new Date();
  await prisma.siteForumPost.update({ where: { id: post.id }, data: { deletedAt: now } });
  // Le message d'ouverture d'un fil porte l'identifiant du fil : le supprimer retire le sujet.
  if (post.topic.threadId === message.id) await prisma.siteForumTopic.update({ where: { id: post.topicId }, data: { deletedAt: now } });
  else await touchTopic(post.topicId, post.topic.lastPostBy ?? post.authorId, post.topic.lastPostAt);
  publishGuildSignal(message.guildId, `forum:${post.topicId}`);
  publishGuildSignal(message.guildId, `forum:${post.topic.categoryId}`);
}

export async function handleForumThreadCreate(thread: AnyThreadChannel): Promise<void> {
  const mirror = await mirrorOf(thread.parentId);
  if (!mirror) return;
  await ensureTopicForThread(thread, mirror.id!);
  publishGuildSignal(thread.guildId, `forum:${mirror.id}`);
}

export async function handleForumThreadUpdate(thread: AnyThreadChannel): Promise<void> {
  const mirror = await mirrorOf(thread.parentId);
  if (!mirror) return;
  const updated = await prisma.siteForumTopic.updateMany({
    where: { threadId: thread.id },
    data: { title: thread.name.slice(0, FORUM_LIMITS.title), locked: Boolean(thread.locked) },
  });
  if (updated.count > 0) publishGuildSignal(thread.guildId, `forum:${mirror.id}`);
}

export async function handleForumThreadDelete(thread: AnyThreadChannel): Promise<void> {
  const mirror = await mirrorOf(thread.parentId);
  if (!mirror) return;
  await prisma.siteForumTopic.updateMany({ where: { threadId: thread.id, deletedAt: null }, data: { deletedAt: new Date() } });
  publishGuildSignal(thread.guildId, `forum:${mirror.id}`);
}

/** Rapatrie les fils récents d'un salon forum devenu miroir (50 fils, 100 messages chacun). */
export async function importForumHistory(client: Client, categoryId: string): Promise<number> {
  const category = await prisma.siteForumCategory.findUnique({ where: { id: categoryId } });
  if (!category?.channelId) return 0;
  const channel = client.channels.cache.get(category.channelId) ?? (await client.channels.fetch(category.channelId).catch(() => null));
  if (!(channel instanceof ForumChannel)) return 0;
  const [active, archived] = await Promise.all([
    channel.threads.fetchActive().catch(() => null),
    channel.threads.fetchArchived({ limit: 50 }).catch(() => null),
  ]);
  const threads = [...(active?.threads.values() ?? []), ...(archived?.threads.values() ?? [])].filter((t) => t.parentId === channel.id).slice(0, 50);
  let imported = 0;
  for (const thread of threads) {
    await ensureTopicForThread(thread, category.id);
    const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
    for (const message of [...(messages?.values() ?? [])].reverse()) {
      if (message.system || (message.webhookId && message.webhookId === category.webhookId)) continue;
      if (await storeDiscordMessage(message, category.id)) imported += 1;
    }
  }
  publishGuildSignal(category.guildId, `forum:${category.id}`);
  return imported;
}

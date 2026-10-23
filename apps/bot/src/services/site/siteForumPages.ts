/**
 * Pages du forum : liste des catégories, sujets d'une catégorie, messages
 * d'un sujet. Le rendu serveur est anonyme (la session vit sur l'API) : les
 * formulaires s'affichent pour tous et le script du site les réserve aux
 * membres connectés, ainsi que les boutons de suppression et de solution.
 *
 * Les sujets sont faits pour être trouvés : adresse qui porte le titre,
 * description tirée du premier message, balisage questions-réponses
 * (`QAPage`) quand le sujet est résolu, discussion (`DiscussionForumPosting`)
 * sinon. Un forum recopié d'un salon que `@everyone` ne lit pas n'est jamais
 * indexé, et un membre qui a masqué son profil apparaît sans nom ni avatar.
 *
 * Les listes de sujets et de messages sont des fragments rechargés par le
 * script à chaque signal `forum:<catégorie|sujet>`.
 */

import type { SiteForumCategory, SiteForumPost, SiteForumTopic } from '@prisma/client';
import { forumTopicSegment, siteIconSvg } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import * as m from '../../lib/paraglide/messages.js';
import { parseDiscordMarkdown } from '../../api/shared/markdown.js';
import { getMemberIdentities } from '../moderation/memberIdentityService.js';
import { attrs, cls, esc, truncate } from './siteHtml.js';
import { avatar, discordMessageUrl, emptyState, formatNumber, timeTag, type BlockContext, type SiteLocale } from './blocks/blockContext.js';
import { getGuildCounts } from './blocks/vitrineBlocks.js';
import type { Breadcrumb } from './siteLayout.js';
import {
  FORUM_LIMITS,
  getForumCategoryBySlug,
  getForumTopic,
  isForumCategoryIndexable,
  listForumCategories,
  listForumPosts,
  listForumTopics,
  listRelatedTopics,
} from './siteForumService.js';

export interface ForumPage {
  title: string;
  lead?: string;
  main: string;
  path: string;
  breadcrumbs: Breadcrumb[];
  noindex?: boolean;
  description?: string;
  jsonLd?: Record<string, unknown> | null;
  /** Adresse canonique quand la demandée n'est pas la bonne (titre changé, lien court). */
  redirect?: string;
}

function pager(base: string, page: number, pages: number, o: { locale: SiteLocale }): string {
  if (pages <= 1) return '';
  const link = (p: number, label: string, rel?: string) => `<a class="btn btn-secondary btn-sm"${attrs({ href: p === 1 ? base : `${base}?page=${p}`, rel: rel ?? null })}>${esc(label)}</a>`;
  return `<nav class="forum-pager" aria-label="${esc(m.site_forum_pages({}, o))}">
  ${page > 1 ? link(page - 1, m.site_forum_prev({}, o), 'prev') : '<span></span>'}
  <span class="forum-pager-pos">${esc(m.site_forum_page_of({ page, pages }, o))}</span>
  ${page < pages ? link(page + 1, m.site_forum_next({}, o), 'next') : '<span></span>'}
</nav>`;
}

export function parseForumPage(value: string | null): number {
  const n = Number.parseInt(value ?? '1', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10_000) : 1;
}

// ─── Adresses ───────────────────────────────────────────────────────────────

export const topicSegment = forumTopicSegment;

export function topicPath(basePath: string, categorySlug: string, topic: Pick<SiteForumTopic, 'id' | 'title'>): string {
  return `${basePath}/forum/${categorySlug}/${topicSegment(topic)}`;
}

/** Identifiant de sujet d'un segment d'adresse (`<id>` ou `<id>-<titre>`), sinon nul. */
export function parseTopicSegment(segment: string): string | null {
  const match = /^([a-z0-9]{20,32})(?:-[a-z0-9-]{0,80})?$/.exec(segment);
  return match ? match[1] : null;
}

// ─── Auteurs ────────────────────────────────────────────────────────────────

/** Membres qui ont masqué leur profil public : ni nom, ni avatar, ni lien sur le forum. */
async function hiddenAuthors(guildId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await prisma.siteMemberSettings.findMany({ where: { guildId, userId: { in: [...new Set(userIds)] }, profileHidden: true }, select: { userId: true } });
  return new Set(rows.map((r) => r.userId));
}

interface ShownAuthor {
  name: string;
  avatar: string | null;
  href: string | null;
}

function shownAuthor(post: Pick<SiteForumPost, 'authorId' | 'authorName' | 'authorAvatar'>, hidden: Set<string>, basePath: string, locale: SiteLocale): ShownAuthor {
  if (hidden.has(post.authorId)) return { name: m.site_forum_hidden_member({}, { locale }), avatar: null, href: null };
  return { name: post.authorName, avatar: post.authorAvatar, href: `${basePath}/u/${post.authorId}` };
}

/** Texte brut d'un message Discord, pour les descriptions et le balisage. */
export function plainDiscordText(content: string, max = 500): string {
  const text = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<a?:(\w{1,32}):\d{17,20}>/g, ':$1:')
    .replace(/<(@[!&]?|#)\d{17,20}>/g, '')
    .replace(/<t:\d{1,12}(?::[tTdDfFR])?>/g, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/[*_~`>|#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, max);
}

// ─── Index ──────────────────────────────────────────────────────────────────

export async function forumIndexPage(ctx: BlockContext): Promise<ForumPage> {
  const o = { locale: ctx.locale };
  const categories = await listForumCategories(ctx.site.id);
  const base = `${ctx.basePath}/forum`;
  const list = categories.length
    ? `<ul class="forum-cats">${categories
        .map(
          (category) => `<li>
  <a class="forum-cat"${attrs({ href: `${base}/${category.slug}` })}>
    <span class="forum-cat-icon">${siteIconSvg(category.mode === 'MIRROR' ? 'message' : 'forum', 20)}</span>
    <span class="forum-cat-main">
      <strong>${esc(category.name)}</strong>
      ${category.description ? `<span class="forum-cat-desc">${esc(category.description)}</span>` : ''}
    </span>
    <span class="forum-cat-stats">
      <span>${esc(m.site_forum_topics_count({ count: formatNumber(category.topicCount, ctx.locale) }, o))}</span>
      ${category.lastPostAt ? `<span class="card-meta">${timeTag(category.lastPostAt, ctx.locale, 'medium')}</span>` : ''}
      ${category.mode === 'MIRROR' ? `<span class="tag">${esc(m.site_forum_synced({}, o))}</span>` : ''}
    </span>
  </a>
</li>`,
        )
        .join('')}</ul>`
    : emptyState(m.site_forum_empty({}, o));
  return {
    title: m.site_forum_title({}, o),
    lead: m.site_forum_lead({}, o),
    main: `<div data-forum-live="index" data-forum-kind="index">${list}</div>`,
    path: base,
    breadcrumbs: [{ label: m.site_home({}, o), href: ctx.basePath }, { label: m.site_forum_title({}, o) }],
    noindex: categories.length === 0,
  };
}

// ─── Catégorie ──────────────────────────────────────────────────────────────

function solvedPill(o: { locale: SiteLocale }): string {
  return `<span class="pill pill-ok">${siteIconSvg('check', 12)} ${esc(m.site_forum_solved({}, o))}</span>`;
}

export async function renderForumTopics(ctx: BlockContext, category: SiteForumCategory, page: number): Promise<string> {
  const o = { locale: ctx.locale };
  const { topics, pages } = await listForumTopics(category.id, page);
  if (topics.length === 0) return emptyState(m.site_forum_no_topics({}, o));
  const base = `${ctx.basePath}/forum/${category.slug}`;
  const ids = [...new Set(topics.flatMap((t) => [t.authorId, t.lastPostBy].filter((id): id is string => Boolean(id))))];
  const [people, hidden] = await Promise.all([getMemberIdentities(ctx.client, ctx.site.guildId, ids), hiddenAuthors(ctx.site.guildId, ids)]);
  const name = (id: string | null) => (!id ? '' : hidden.has(id) ? m.site_forum_hidden_member({}, o) : people.get(id)?.displayName ?? m.site_forum_someone({}, o));
  const rows = topics
    .map(
      (topic) => `<li class="${cls('forum-topic', topic.pinned && 'is-pinned', topic.locked && 'is-locked', topic.solved && 'is-solved')}">
  <div class="forum-topic-main">
    <a class="forum-topic-title"${attrs({ href: topicPath(ctx.basePath, category.slug, topic) })}>${topic.pinned ? `${siteIconSvg('star', 14)} ` : ''}${topic.locked ? `${siteIconSvg('lock', 14)} ` : ''}${esc(topic.title)}</a>
    <span class="card-meta">${topic.solved ? `${solvedPill(o)} ` : ''}${esc(m.site_forum_by({ name: name(topic.authorId) }, o))} · ${timeTag(topic.createdAt, ctx.locale, 'medium')}</span>
  </div>
  <span class="forum-topic-count">${esc(m.site_forum_replies({ count: formatNumber(topic.replyCount, ctx.locale) }, o))}</span>
  <span class="forum-topic-last card-meta">${timeTag(topic.lastPostAt, ctx.locale, 'short')}${topic.lastPostBy ? `<br>${esc(name(topic.lastPostBy))}` : ''}</span>
</li>`,
    )
    .join('');
  return `<ul class="forum-topics">${rows}</ul>${pager(base, page, pages, o)}`;
}

export async function forumCategoryPage(ctx: BlockContext, slug: string, page: number): Promise<ForumPage | null> {
  const o = { locale: ctx.locale };
  const category = await getForumCategoryBySlug(ctx.site.id, slug);
  if (!category) return null;
  const base = `${ctx.basePath}/forum/${category.slug}`;
  const form = `<details class="forum-new"${attrs({ 'data-staff-only': category.staffTopicsOnly ? '1' : null })}>
  <summary class="btn btn-primary btn-sm">${esc(m.site_forum_new_topic({}, o))}</summary>
  <form class="forum-form"${attrs({ 'data-forum-topic': category.id, 'data-requires-login': '1' })}>
    <div class="field"><label for="forum-title">${esc(m.site_forum_topic_title({}, o))}</label><input${attrs({ id: 'forum-title', name: 'title', maxlength: FORUM_LIMITS.title, required: true })}></div>
    <div class="field"><label for="forum-content">${esc(m.site_forum_message({}, o))}</label><textarea${attrs({ id: 'forum-content', name: 'content', rows: 6, maxlength: FORUM_LIMITS.content, required: true })}></textarea><p class="field-help">${esc(category.mode === 'MIRROR' ? m.site_forum_mirror_hint({}, o) : m.site_forum_markdown_hint({}, o))}</p></div>
    <p class="form-status" role="status" aria-live="polite"></p>
    <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(m.site_forum_publish({}, o))}</button></div>
  </form>
</details>`;
  return {
    title: category.name,
    lead: category.description || undefined,
    description: category.description || undefined,
    main: `<div class="forum-toolbar">${form}</div><div${attrs({ 'data-forum-live': category.id, 'data-forum-kind': 'topics', 'data-page': page })}>${await renderForumTopics(ctx, category, page)}</div>`,
    path: page > 1 ? `${base}?page=${page}` : base,
    breadcrumbs: [{ label: m.site_home({}, o), href: ctx.basePath }, { label: m.site_forum_title({}, o), href: `${ctx.basePath}/forum` }, { label: category.name }],
    noindex: page > 1 || !isForumCategoryIndexable(ctx.guild, category),
  };
}

// ─── Sujet ──────────────────────────────────────────────────────────────────

export async function renderForumPosts(ctx: BlockContext, category: SiteForumCategory, topic: SiteForumTopic, page: number): Promise<{ html: string; pages: number }> {
  const o = { locale: ctx.locale };
  const { posts, pages } = await listForumPosts(topic.id, page);
  const base = topicPath(ctx.basePath, category.slug, topic);
  const hidden = await hiddenAuthors(ctx.site.guildId, posts.map((p) => p.authorId));
  const firstId = page === 1 ? posts[0]?.id : null;
  const items = posts
    .map((post) => {
      const author = shownAuthor(post, hidden, ctx.basePath, ctx.locale);
      const accepted = topic.acceptedPostId === post.id;
      const files = Array.isArray(post.attachments) ? (post.attachments as Array<{ name?: string }>) : [];
      const discordLink =
        post.messageId && topic.threadId
          ? `<a class="card-meta"${attrs({ href: discordMessageUrl(ctx.site.guildId, topic.threadId, post.messageId), target: '_blank', rel: 'noopener' })}>${esc(m.site_forum_on_discord({}, o))}</a>`
          : '';
      // Proposé à l'auteur du sujet et au staff par le script, jamais sur le message d'ouverture.
      const acceptButton =
        post.id === firstId
          ? ''
          : `<button type="button" class="btn btn-ghost btn-sm" hidden${attrs({ 'data-forum-accept': post.id, 'data-topic': topic.id, 'data-topic-author': topic.authorId, 'data-accepted': accepted ? '1' : null })}>${esc(accepted ? m.site_forum_unaccept({}, o) : m.site_forum_accept({}, o))}</button>`;
      const name = author.href ? `<a${attrs({ href: author.href, rel: 'nofollow' })}><strong>${esc(author.name)}</strong></a>` : `<strong>${esc(author.name)}</strong>`;
      return `<li${attrs({ class: cls('forum-post', accepted && 'is-accepted'), id: `p-${post.id}` })}>
  ${avatar(author.avatar, author.name, 'md')}
  <div class="forum-post-body">
    ${accepted ? `<p class="forum-accepted-label">${siteIconSvg('check', 14)} ${esc(m.site_forum_accepted({}, o))}</p>` : ''}
    <p class="forum-post-head">${name} <span class="card-meta">${timeTag(post.createdAt, ctx.locale, 'medium')}${post.editedAt ? ` · ${esc(m.site_forum_edited({}, o))}` : ''}</span></p>
    <div class="rich">${parseDiscordMarkdown(post.content, ctx.guild)}</div>
    ${files.length ? `<p class="card-meta">${siteIconSvg('file-text', 14)} ${esc(m.site_forum_attachments({ count: files.length }, o))}</p>` : ''}
    <p class="forum-post-actions">${discordLink}${acceptButton}<button type="button" class="btn btn-ghost btn-sm" hidden${attrs({ 'data-forum-delete': post.id, 'data-author': post.authorId })}>${esc(m.site_forum_delete({}, o))}</button></p>
  </div>
</li>`;
    })
    .join('');
  return { html: posts.length ? `<ol class="forum-posts">${items}</ol>${pager(base, page, pages, o)}` : emptyState(m.site_forum_no_posts({}, o)), pages };
}

/**
 * Balisage du sujet pour les moteurs de recherche : questions-réponses quand
 * il est résolu et qu'il a au moins une réponse, discussion sinon.
 */
export function forumTopicJsonLd(input: {
  topic: Pick<SiteForumTopic, 'title' | 'solved' | 'acceptedPostId' | 'replyCount' | 'createdAt' | 'lastPostAt'>;
  url: string;
  first: { text: string; author: string; createdAt: Date } | null;
  replies: Array<{ id: string; text: string; author: string; createdAt: Date }>;
}): Record<string, unknown> | null {
  const { topic, url, first, replies } = input;
  if (!first) return null;
  const person = (name: string) => ({ '@type': 'Person', name });
  const answer = (r: (typeof replies)[number]) => ({
    '@type': 'Answer',
    text: r.text,
    dateCreated: r.createdAt.toISOString(),
    url: `${url}#p-${r.id}`,
    author: person(r.author),
  });
  if (topic.solved && replies.length > 0) {
    const accepted = replies.find((r) => r.id === topic.acceptedPostId) ?? null;
    const suggested = replies.filter((r) => r !== accepted).slice(0, 5);
    return {
      '@context': 'https://schema.org',
      '@type': 'QAPage',
      mainEntity: {
        '@type': 'Question',
        name: topic.title,
        text: first.text || topic.title,
        answerCount: topic.replyCount,
        dateCreated: first.createdAt.toISOString(),
        author: person(first.author),
        ...(accepted ? { acceptedAnswer: answer(accepted) } : {}),
        ...(suggested.length ? { suggestedAnswer: suggested.map(answer) } : {}),
      },
    };
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: topic.title,
    text: first.text || topic.title,
    url,
    datePublished: first.createdAt.toISOString(),
    dateModified: topic.lastPostAt.toISOString(),
    author: person(first.author),
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: topic.replyCount },
    comment: replies.slice(0, 10).map((r) => ({ '@type': 'Comment', text: r.text, datePublished: r.createdAt.toISOString(), url: `${url}#p-${r.id}`, author: person(r.author) })),
  };
}

/** Encart pour qui arrive d'un moteur de recherche : la discussion vient d'un serveur Discord vivant. */
async function joinCallout(ctx: BlockContext, inviteUrl: string | null, serverName: string): Promise<string> {
  if (!inviteUrl) return '';
  const o = { locale: ctx.locale };
  const counts = ctx.guild ? await getGuildCounts(ctx).catch(() => null) : null;
  const meta = counts ? m.site_forum_cta_meta({ members: formatNumber(counts.members, ctx.locale), online: formatNumber(counts.online, ctx.locale) }, o) : '';
  return `<aside class="forum-cta">
  <div><p class="forum-cta-title">${esc(m.site_forum_cta_title({ name: serverName }, o))}</p><p class="card-meta">${esc(meta || m.site_forum_cta_text({}, o))}</p></div>
  <a class="btn btn-primary btn-sm btn-discord"${attrs({ href: inviteUrl, rel: 'noopener', target: '_blank', 'data-join': 'forum' })}>${esc(m.site_join_discord({}, o))}</a>
</aside>`;
}

export async function forumTopicPage(
  ctx: BlockContext,
  slug: string,
  segment: string,
  page: number,
  options: { inviteUrl?: string | null; serverName?: string; origin?: string } = {},
): Promise<ForumPage | null> {
  const o = { locale: ctx.locale };
  const topicId = parseTopicSegment(segment);
  if (!topicId) return null;
  const category = await getForumCategoryBySlug(ctx.site.id, slug);
  if (!category) return null;
  const topic = await getForumTopic(category.id, topicId);
  if (!topic) return null;
  const base = topicPath(ctx.basePath, category.slug, topic);
  if (segment !== topicSegment(topic)) return { title: topic.title, main: '', path: base, breadcrumbs: [], redirect: page > 1 ? `${base}?page=${page}` : base };

  const [posts, related, firstPage] = await Promise.all([
    renderForumPosts(ctx, category, topic, page),
    listRelatedTopics(category.id, topic.id),
    page === 1 ? listForumPosts(topic.id, 1) : Promise.resolve(null),
  ]);
  const indexable = isForumCategoryIndexable(ctx.guild, category) && page === 1 && (firstPage?.posts.length ?? 0) > 0;

  // Description et balisage, à partir de la première page seulement.
  let description: string | undefined;
  let jsonLd: Record<string, unknown> | null = null;
  if (firstPage && firstPage.posts.length > 0) {
    const hidden = await hiddenAuthors(ctx.site.guildId, firstPage.posts.map((p) => p.authorId));
    const authorName = (p: SiteForumPost) => shownAuthor(p, hidden, ctx.basePath, ctx.locale).name;
    const [first, ...rest] = firstPage.posts;
    const accepted = topic.acceptedPostId && !rest.some((p) => p.id === topic.acceptedPostId)
      ? await prisma.siteForumPost.findFirst({ where: { id: topic.acceptedPostId, topicId: topic.id, deletedAt: null } })
      : null;
    const replies = [...(accepted ? [accepted] : []), ...rest].map((p) => ({ id: p.id, text: plainDiscordText(p.content, 1500), author: authorName(p), createdAt: p.createdAt }));
    description = plainDiscordText(first.content, 155) || undefined;
    jsonLd = forumTopicJsonLd({
      topic,
      url: `${options.origin ?? ''}${base}`,
      first: { text: plainDiscordText(first.content, 1500), author: authorName(first), createdAt: first.createdAt },
      replies,
    });
  }

  const reply = `<form class="forum-form forum-reply"${attrs({ 'data-forum-reply': topic.id, 'data-requires-login': '1', 'data-locked': topic.locked ? '1' : null })}>
  <div class="field"><label for="forum-reply">${esc(m.site_forum_reply({}, o))}</label><textarea${attrs({ id: 'forum-reply', name: 'content', rows: 4, maxlength: FORUM_LIMITS.content, required: true })}></textarea></div>
  <p class="form-status" role="status" aria-live="polite"></p>
  <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(m.site_forum_send({}, o))}</button></div>
</form>${topic.locked ? `<p class="card-meta forum-locked">${siteIconSvg('lock', 14)} ${esc(m.site_forum_locked({}, o))}</p>` : ''}`;

  const jump = topic.acceptedPostId ? `<p class="forum-jump"><a${attrs({ href: `#p-${topic.acceptedPostId}` })}>${siteIconSvg('check', 14)} ${esc(m.site_forum_jump_answer({}, o))}</a></p>` : '';
  const relatedHtml = related.length
    ? `<nav class="forum-related" aria-labelledby="forum-related-title"><h2 id="forum-related-title">${esc(m.site_forum_related({}, o))}</h2><ul>${related
        .map((r) => `<li><a${attrs({ href: topicPath(ctx.basePath, category.slug, r) })}>${esc(r.title)}</a><span class="card-meta">${r.solved ? `${solvedPill(o)} ` : ''}${esc(m.site_forum_replies({ count: formatNumber(r.replyCount, ctx.locale) }, o))}</span></li>`)
        .join('')}</ul></nav>`
    : '';

  return {
    title: topic.title,
    description,
    jsonLd,
    main: `${await joinCallout(ctx, options.inviteUrl ?? null, options.serverName ?? '')}${topic.solved ? `<p class="forum-status">${solvedPill(o)}</p>` : ''}${jump}<div${attrs({ 'data-forum-live': topic.id, 'data-forum-kind': 'posts', 'data-page': page, 'data-pages': posts.pages })}>${posts.html}</div>${reply}${relatedHtml}`,
    path: page > 1 ? `${base}?page=${page}` : base,
    breadcrumbs: [
      { label: m.site_home({}, o), href: ctx.basePath },
      { label: m.site_forum_title({}, o), href: `${ctx.basePath}/forum` },
      { label: category.name, href: `${ctx.basePath}/forum/${category.slug}` },
      { label: topic.title },
    ],
    noindex: !indexable,
  };
}

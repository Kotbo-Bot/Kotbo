/**
 * Pages du forum : liste des catégories, sujets d'une catégorie, messages
 * d'un sujet. Le rendu serveur est anonyme (la session vit sur l'API) : les
 * formulaires s'affichent pour tous et le script du site les réserve aux
 * membres connectés, ainsi que les boutons de suppression.
 *
 * Les listes de sujets et de messages sont des fragments rechargés par le
 * script à chaque signal `forum:<catégorie|sujet>`.
 */

import type { SiteForumCategory, SiteForumTopic } from '@prisma/client';
import { siteIconSvg } from '@kotbo/shared';
import * as m from '../../lib/paraglide/messages.js';
import { parseDiscordMarkdown } from '../../api/shared/markdown.js';
import { getMemberIdentities } from '../moderation/memberIdentityService.js';
import { attrs, cls, esc } from './siteHtml.js';
import { avatar, discordMessageUrl, emptyState, formatNumber, timeTag, type BlockContext } from './blocks/blockContext.js';
import type { Breadcrumb } from './siteLayout.js';
import { FORUM_LIMITS, getForumCategoryBySlug, getForumTopic, listForumCategories, listForumPosts, listForumTopics } from './siteForumService.js';

export interface ForumPage {
  title: string;
  lead?: string;
  main: string;
  path: string;
  breadcrumbs: Breadcrumb[];
  noindex?: boolean;
}

function pager(base: string, page: number, pages: number, o: { locale: 'fr' | 'en' }): string {
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
  };
}

// ─── Catégorie ──────────────────────────────────────────────────────────────

export async function renderForumTopics(ctx: BlockContext, category: SiteForumCategory, page: number): Promise<string> {
  const o = { locale: ctx.locale };
  const { topics, pages } = await listForumTopics(category.id, page);
  if (topics.length === 0) return emptyState(m.site_forum_no_topics({}, o));
  const base = `${ctx.basePath}/forum/${category.slug}`;
  const people = await getMemberIdentities(ctx.client, ctx.site.guildId, [...new Set(topics.flatMap((t) => [t.authorId, t.lastPostBy].filter((id): id is string => Boolean(id))))]);
  const name = (id: string | null) => (id ? people.get(id)?.displayName ?? m.site_forum_someone({}, o) : '');
  const rows = topics
    .map(
      (topic) => `<li class="${cls('forum-topic', topic.pinned && 'is-pinned', topic.locked && 'is-locked')}">
  <div class="forum-topic-main">
    <a class="forum-topic-title"${attrs({ href: `${base}/${topic.id}` })}>${topic.pinned ? `${siteIconSvg('star', 14)} ` : ''}${topic.locked ? `${siteIconSvg('lock', 14)} ` : ''}${esc(topic.title)}</a>
    <span class="card-meta">${esc(m.site_forum_by({ name: name(topic.authorId) }, o))} · ${timeTag(topic.createdAt, ctx.locale, 'medium')}</span>
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
    main: `<div class="forum-toolbar">${form}</div><div${attrs({ 'data-forum-live': category.id, 'data-forum-kind': 'topics', 'data-page': page })}>${await renderForumTopics(ctx, category, page)}</div>`,
    path: page > 1 ? `${base}?page=${page}` : base,
    breadcrumbs: [{ label: m.site_home({}, o), href: ctx.basePath }, { label: m.site_forum_title({}, o), href: `${ctx.basePath}/forum` }, { label: category.name }],
    noindex: page > 1,
  };
}

// ─── Sujet ──────────────────────────────────────────────────────────────────

export async function renderForumPosts(ctx: BlockContext, category: SiteForumCategory, topic: SiteForumTopic, page: number): Promise<{ html: string; pages: number }> {
  const o = { locale: ctx.locale };
  const { posts, pages } = await listForumPosts(topic.id, page);
  const base = `${ctx.basePath}/forum/${category.slug}/${topic.id}`;
  const items = posts
    .map((post) => {
      const files = Array.isArray(post.attachments) ? (post.attachments as Array<{ name?: string }>) : [];
      const discordLink =
        post.messageId && topic.threadId
          ? `<a class="card-meta"${attrs({ href: discordMessageUrl(ctx.site.guildId, topic.threadId, post.messageId), target: '_blank', rel: 'noopener' })}>${esc(m.site_forum_on_discord({}, o))}</a>`
          : '';
      return `<li class="forum-post"${attrs({ id: `p-${post.id}` })}>
  ${avatar(post.authorAvatar, post.authorName, 'md')}
  <div class="forum-post-body">
    <p class="forum-post-head"><a${attrs({ href: `${ctx.basePath}/u/${post.authorId}` })}><strong>${esc(post.authorName)}</strong></a> <span class="card-meta">${timeTag(post.createdAt, ctx.locale, 'medium')}${post.editedAt ? ` · ${esc(m.site_forum_edited({}, o))}` : ''}</span></p>
    <div class="rich">${parseDiscordMarkdown(post.content, ctx.guild)}</div>
    ${files.length ? `<p class="card-meta">${siteIconSvg('file-text', 14)} ${esc(m.site_forum_attachments({ count: files.length }, o))}</p>` : ''}
    <p class="forum-post-actions">${discordLink}<button type="button" class="btn btn-ghost btn-sm" hidden${attrs({ 'data-forum-delete': post.id, 'data-author': post.authorId })}>${esc(m.site_forum_delete({}, o))}</button></p>
  </div>
</li>`;
    })
    .join('');
  return { html: posts.length ? `<ol class="forum-posts">${items}</ol>${pager(base, page, pages, o)}` : emptyState(m.site_forum_no_posts({}, o)), pages };
}

export async function forumTopicPage(ctx: BlockContext, slug: string, topicId: string, page: number): Promise<ForumPage | null> {
  const o = { locale: ctx.locale };
  const category = await getForumCategoryBySlug(ctx.site.id, slug);
  if (!category) return null;
  const topic = await getForumTopic(category.id, topicId);
  if (!topic) return null;
  const base = `${ctx.basePath}/forum/${category.slug}/${topic.id}`;
  const posts = await renderForumPosts(ctx, category, topic, page);
  const reply = `<form class="forum-form forum-reply"${attrs({ 'data-forum-reply': topic.id, 'data-requires-login': '1', 'data-locked': topic.locked ? '1' : null })}>
  <div class="field"><label for="forum-reply">${esc(m.site_forum_reply({}, o))}</label><textarea${attrs({ id: 'forum-reply', name: 'content', rows: 4, maxlength: FORUM_LIMITS.content, required: true })}></textarea></div>
  <p class="form-status" role="status" aria-live="polite"></p>
  <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(m.site_forum_send({}, o))}</button></div>
</form>${topic.locked ? `<p class="card-meta forum-locked">${siteIconSvg('lock', 14)} ${esc(m.site_forum_locked({}, o))}</p>` : ''}`;
  return {
    title: topic.title,
    main: `<div${attrs({ 'data-forum-live': topic.id, 'data-forum-kind': 'posts', 'data-page': page, 'data-pages': posts.pages })}>${posts.html}</div>${reply}`,
    path: page > 1 ? `${base}?page=${page}` : base,
    breadcrumbs: [
      { label: m.site_home({}, o), href: ctx.basePath },
      { label: m.site_forum_title({}, o), href: `${ctx.basePath}/forum` },
      { label: category.name, href: `${ctx.basePath}/forum/${category.slug}` },
      { label: topic.title },
    ],
    noindex: page > 1,
  };
}

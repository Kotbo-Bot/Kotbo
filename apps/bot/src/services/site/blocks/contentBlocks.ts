/**
 * Blocs de contenus (sommaire du wiki, derniers articles, recherche) et
 * espace du membre connecté.
 *
 * Une liste ne montre que les pages que le visiteur pourrait ouvrir : le titre
 * d'une page réservée au staff ne doit pas apparaître dans un sommaire public.
 */

import prisma from '../../../utils/db.js';
import * as m from '../../../lib/paraglide/messages.js';
import { attrs, cls, esc, truncate } from '../siteHtml.js';
import { checkPageAccess, listPublishedPages, type PageSummary, type SiteViewer } from '../siteService.js';
import { avatar, emptyState, formatNumber, timeTag, type BlockContext, type BlockRegistry } from './blockContext.js';

export function pageUrl(basePath: string, page: Pick<PageSummary, 'kind' | 'slug'>): string {
  if (page.kind === 'WIKI') return `${basePath}/wiki/${page.slug}`;
  if (page.kind === 'BLOG') return `${basePath}/blog/${page.slug}`;
  return `${basePath}/${page.slug}`;
}

export function visiblePages<T extends Pick<PageSummary, 'visibility' | 'visibleRoleIds'>>(pages: T[], viewer: SiteViewer | null): T[] {
  return pages.filter((p) => checkPageAccess(p, viewer) === 'allowed');
}

// ─── Wiki ───────────────────────────────────────────────────────────────────

/** Arbre du wiki en `<ul>` imbriqués, à partir d'une page ou de la racine. */
export function renderWikiTree(pages: PageSummary[], basePath: string, rootId: string | null, currentId: string | null = null, depth = 0): string {
  if (depth > 6) return '';
  const children = pages.filter((p) => (p.parentId ?? null) === rootId);
  if (children.length === 0) return '';
  const items = children
    .map((p) => {
      const sub = renderWikiTree(pages, basePath, p.id, currentId, depth + 1);
      const current = p.id === currentId;
      return `<li${attrs({ class: cls(sub && 'has-children', current && 'is-current') })}><a${attrs({ href: pageUrl(basePath, p), 'aria-current': current ? 'page' : null })}>${p.icon ? `<span aria-hidden="true">${esc(p.icon)}</span> ` : ''}${esc(p.publishedTitle ?? p.slug)}</a>${sub}</li>`;
    })
    .join('');
  return `<ul class="wiki-tree">${items}</ul>`;
}

async function renderWikiIndex(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const pages = visiblePages(await listPublishedPages(ctx.site, 'WIKI'), ctx.viewer);
  const rootId = typeof config.parentId === 'string' && config.parentId ? config.parentId : null;
  // Une page dont le parent est masqué au visiteur remonte à la racine plutôt que de disparaître.
  const ids = new Set(pages.map((p) => p.id));
  const reparented = pages.map((p) => (p.parentId && !ids.has(p.parentId) ? { ...p, parentId: null } : p));
  const tree = renderWikiTree(reparented, ctx.basePath, rootId);
  return tree || emptyState(m.site_wiki_empty({}, { locale: ctx.locale }));
}

// ─── Blog ───────────────────────────────────────────────────────────────────

export function renderArticleCards(ctx: Pick<BlockContext, 'basePath' | 'locale'>, articles: PageSummary[], layout: 'cards' | 'list' = 'cards'): string {
  const cards = articles
    .map((a) => {
      const url = pageUrl(ctx.basePath, a);
      const cover = a.coverUrl ? `<img class="card-cover"${attrs({ src: a.coverUrl, alt: '', loading: 'lazy', decoding: 'async' })}>` : '';
      const tags = a.tags.length > 0 ? `<p class="tags">${a.tags.slice(0, 4).map((t) => `<a class="tag"${attrs({ href: `${ctx.basePath}/blog/tag/${encodeURIComponent(t)}` })}>${esc(t)}</a>`).join('')}</p>` : '';
      return `<article class="article-card">
  ${cover ? `<a${attrs({ href: url, tabindex: -1, 'aria-hidden': 'true' })}>${cover}</a>` : ''}
  <div class="card-body">
    <p class="card-kicker">${timeTag(a.firstPublishedAt ?? a.publishedAt, ctx.locale, 'medium')}</p>
    <h3 class="card-title"><a${attrs({ href: url })}>${esc(a.publishedTitle ?? a.slug)}</a></h3>
    ${a.excerpt ? `<p class="card-text">${esc(truncate(a.excerpt, 240))}</p>` : ''}
    ${tags}
  </div>
</article>`;
    })
    .join('');
  return `<div class="${layout === 'list' ? 'stack' : 'card-grid'}">${cards}</div>`;
}

async function renderBlogList(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const tag = typeof config.tag === 'string' ? config.tag : '';
  let articles = visiblePages(await listPublishedPages(ctx.site, 'BLOG'), ctx.viewer);
  if (tag) articles = articles.filter((a) => a.tags.includes(tag));
  articles = articles.slice(0, Number(config.limit) || 6);
  if (articles.length === 0) return emptyState(m.site_blog_empty({}, { locale: ctx.locale }));
  return renderArticleCards(ctx, articles, config.layout === 'list' ? 'list' : 'cards');
}

// ─── Recherche ──────────────────────────────────────────────────────────────

export function renderSearchForm(basePath: string, locale: BlockContext['locale'], query = ''): string {
  const o = { locale };
  return `<form class="search-form" role="search"${attrs({ action: `${basePath}/search`, method: 'get' })}>
  <label class="sr-only" for="site-search-q">${esc(m.site_search({}, o))}</label>
  <input id="site-search-q" type="search" name="q" minlength="2" maxlength="100"${attrs({ value: query, placeholder: m.site_search_placeholder({}, o) })}>
  <button type="submit" class="btn btn-primary">${esc(m.site_search({}, o))}</button>
</form>`;
}

async function renderSearch(ctx: BlockContext): Promise<string> {
  return renderSearchForm(ctx.basePath, ctx.locale);
}

// ─── Espace du membre ───────────────────────────────────────────────────────

async function renderProfile(ctx: BlockContext): Promise<string> {
  const o = { locale: ctx.locale };
  const viewer = ctx.viewer;
  if (!viewer) {
    return `<div class="profile" data-profile><p class="empty">${esc(m.site_profile_login({}, o))}</p><p class="btn-row"><a class="btn btn-primary" data-login href="#">${esc(m.site_login({}, o))}</a></p></div>`;
  }
  const guildId = ctx.site.guildId;
  const [level, rpg, rep] = await Promise.all([
    prisma.memberLevel.findUnique({ where: { guildId_userId: { guildId, userId: viewer.userId } }, select: { xp: true, level: true } }),
    prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId: viewer.userId } }, select: { balance: true, level: true } }),
    prisma.reputationVote.aggregate({ where: { guildId, receiverId: viewer.userId }, _sum: { value: true } }),
  ]);
  const rank = level ? (await prisma.memberLevel.count({ where: { guildId, xp: { gt: level.xp } } })) + 1 : null;

  const tiles: string[] = [];
  const tile = (value: string, label: string) => `<div class="stat"><p class="stat-value">${esc(value)}</p><p class="stat-label">${esc(label)}</p></div>`;
  if (level) {
    tiles.push(tile(m.site_level({ level: level.level }, o), `${formatNumber(level.xp, ctx.locale)} XP`));
    if (rank) tiles.push(tile(`#${formatNumber(rank, ctx.locale)}`, m.site_leaderboard_xp({}, o)));
  }
  if (rpg) tiles.push(tile(formatNumber(rpg.balance, ctx.locale), m.site_coins({ value: '' }, o).trim()));
  const repTotal = rep._sum.value ?? 0;
  if (repTotal) tiles.push(tile(formatNumber(repTotal, ctx.locale), m.site_rep({ value: '' }, o).trim()));

  return `<div class="profile">
  <div class="profile-head">${avatar(viewer.avatarUrl, viewer.displayName, 'lg')}<div><p class="profile-name">${esc(viewer.displayName)}</p><p class="card-meta">@${esc(viewer.username)}${viewer.isStaff ? ` · <span class="pill">${esc(m.site_staff_other({}, o))}</span>` : ''}</p></div></div>
  ${tiles.length > 0 ? `<div class="stats">${tiles.join('')}</div>` : ''}
</div>`;
}

export const contentBlocks: BlockRegistry = {
  wikiIndex: renderWikiIndex,
  blogList: renderBlogList,
  search: renderSearch,
  profile: renderProfile,
};

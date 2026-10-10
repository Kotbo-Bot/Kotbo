/**
 * Routeur public des sites communautaires : tout ce qui vit sous `/s/`.
 *
 *   /s/_/site.css · /s/_/site.js · /s/_/a/<id>.<ext>   fichiers communs, images
 *   /s/sitemap.xml                                    index des plans de site
 *   /s/<slug>                                         accueil
 *   /s/<slug>/<page>                                  page libre
 *   /s/<slug>/wiki[/<page>] · /blog[/<article>|/tag/<étiquette>]
 *   /s/<slug>/search?q= · /me · /form/<id>
 *   /s/<slug>/rss.xml · /sitemap.xml · /_/theme.css
 *   /s/<slug>/embed/<page>/<bloc> · /preview/<jeton>
 *
 * Indépendant de HTTP : la route Hono ne fait que traduire la requête et la
 * réponse. Le rendu ne connaît jamais le visiteur (voir siteService).
 */

import type { Client, Guild } from 'discord.js';
import type { SitePageKind } from '@prisma/client';
import {
  collectSiteHeadings,
  collectSiteModules,
  estimateReadingMinutes,
  extractSiteDocumentText,
  normalizeSiteDocument,
  prepareSiteCss,
  SITE_ASSET_PATH_PREFIX,
  siteIconSvg,
  type SiteDocument,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import * as m from '../../lib/paraglide/messages.js';
import { getModuleStates } from '../core/moduleGate.js';
import { getMemberIdentities } from '../moderation/memberIdentityService.js';
import { attrs, createNonce, esc } from './siteHtml.js';
import { renderSiteDocument } from './siteRenderer.js';
import { renderDocumentBlocks, renderBlock } from './blocks/index.js';
import { formatDate, formatNumber, timeTag, type BlockContext, type SiteLocale } from './blocks/blockContext.js';
import { getGuildCounts } from './blocks/vitrineBlocks.js';
import { getSiteInviteUrl } from './blocks/discordBlocks.js';
import { pageUrl, renderArticleCards, renderSearchForm, renderWikiTree, visiblePages } from './blocks/contentBlocks.js';
import { loadSiteForm, renderSiteForm } from './blocks/demarchesBlocks.js';
import { renderSiteShell, renderThemeCss, safeBannerUrl, type Breadcrumb, type SiteIdentity } from './siteLayout.js';
import { getPublicMemberProfile } from './siteMemberService.js';
import { getSiteScript, getSiteStylesheet } from './siteAssets.js';
import { readSiteAsset, mimeForExtension } from './siteUploads.js';
import { searchSite } from './siteSearch.js';
import { forumCategoryPage, forumIndexPage, forumTopicPage, parseForumPage, type ForumPage } from './siteForumPages.js';
import { verifyPreviewToken } from './sitePreview.js';
import { recordSiteHit } from './siteAnalyticsService.js';
import {
  checkPageAccess,
  getPublishedPage,
  getPublishedPageById,
  listPublishedPages,
  lookupSite,
  type PageSummary,
  type PublishedPage,
  type SiteRecord,
  type SiteViewer,
} from './siteService.js';

export interface SiteHttpRequest {
  client: Client;
  /** Segments après `/s/`, décodés. */
  segments: string[];
  query: URLSearchParams;
  acceptLanguage: string | null;
  /** Origine publique du dashboard : `https://dash.kotbo.fr`. */
  origin: string;
  host: string;
  apiOrigin: string;
  userAgent: string | null;
  referrer: string | null;
  ip: string;
}

export interface SiteHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

// ─── Réponses ───────────────────────────────────────────────────────────────

const FRAME_SOURCES = 'https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com';

export function siteCsp(nonce: string, apiOrigin: string, embed = false): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https:",
    'font-src https://fonts.gstatic.com',
    // Signaux temps réel du site : le WebSocket vit sur l'origine de l'API.
    `connect-src 'self' ${apiOrigin} ${apiOrigin.replace(/^http/, 'ws')}`,
    `frame-src ${FRAME_SOURCES}`,
    `form-action 'self' ${apiOrigin}`,
    "base-uri 'none'",
    "object-src 'none'",
    embed ? 'frame-ancestors *' : "frame-ancestors 'none'",
  ].join('; ');
}

function html(status: number, body: string, nonce: string, apiOrigin: string, options: { embed?: boolean; cacheSeconds?: number; noindex?: boolean } = {}): SiteHttpResponse {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': siteCsp(nonce, apiOrigin, options.embed),
    'Cache-Control': options.cacheSeconds ? `public, max-age=${options.cacheSeconds}` : 'no-store',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  };
  if (options.noindex) headers['X-Robots-Tag'] = 'noindex, nofollow';
  return { status, headers, body };
}

function redirect(location: string, permanent = true): SiteHttpResponse {
  return { status: permanent ? 301 : 302, headers: { Location: location, 'Cache-Control': 'public, max-age=300' }, body: '' };
}

function plain(status: number, body: string | Uint8Array, type: string, cacheControl: string): SiteHttpResponse {
  return { status, headers: { 'Content-Type': type, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' }, body };
}

export function pickLocale(query: URLSearchParams, acceptLanguage: string | null): SiteLocale {
  const forced = query.get('lang');
  if (forced === 'fr' || forced === 'en') return forced;
  const preferred = (acceptLanguage ?? '').split(',').map((part) => part.trim().slice(0, 2).toLowerCase());
  const known = preferred.find((lang) => lang === 'fr' || lang === 'en');
  return (known as SiteLocale | undefined) ?? 'fr';
}

// ─── Contexte d'une requête sur un site ─────────────────────────────────────

export interface SiteCtx {
  req: SiteHttpRequest;
  site: SiteRecord;
  guild: Guild | null;
  identity: SiteIdentity;
  locale: SiteLocale;
  basePath: string;
  nonce: string;
  block: BlockContext;
  pages: Record<SitePageKind, PageSummary[]>;
  /** Invitation Discord du site (pages HTML seulement), pour la bannière et le pied de page. */
  inviteUrl: string | null;
}

export function siteIdentity(site: SiteRecord, guild: Guild | null): SiteIdentity {
  return {
    name: site.name || guild?.name || site.slug,
    iconUrl: guild?.iconURL({ size: 256, extension: 'png' }) ?? null,
    bannerUrl: guild?.bannerURL({ size: 1024 }) ?? guild?.splashURL({ size: 1024 }) ?? null,
  };
}

export async function buildSiteCtx(
  req: Pick<SiteHttpRequest, 'client' | 'query' | 'acceptLanguage'> & Partial<SiteHttpRequest>,
  site: SiteRecord,
  viewer: SiteViewer | null = null,
  viewerKnown = false,
): Promise<SiteCtx> {
  const guild = req.client.guilds.cache.get(site.guildId) ?? null;
  const locale = pickLocale(req.query, req.acceptLanguage);
  const basePath = `/s/${site.slug}`;
  const [moduleStates, pagesList, wikiPages, blogPages] = await Promise.all([
    getModuleStates(site.guildId),
    listPublishedPages(site, 'PAGE'),
    listPublishedPages(site, 'WIKI'),
    listPublishedPages(site, 'BLOG'),
  ]);
  // Wiki ou blog éteint au Centre de gestion : la section disparaît du site,
  // menu, index, recherche et plan du site compris.
  const wiki = moduleStates.site_wiki === false ? [] : wikiPages;
  const blog = moduleStates.site_blog === false ? [] : blogPages;
  return {
    req: req as SiteHttpRequest,
    site,
    guild,
    identity: siteIdentity(site, guild),
    locale,
    basePath,
    nonce: createNonce(),
    block: { client: req.client, site, guild, locale, basePath, viewer, viewerKnown, moduleStates },
    pages: { PAGE: pagesList, WIKI: wiki, BLOG: blog },
    inviteUrl: null,
  };
}

/** Pages que le menu et les index peuvent citer devant un anonyme. */
function publicPages(ctx: SiteCtx): PageSummary[] {
  return [...ctx.pages.PAGE, ...ctx.pages.WIKI, ...ctx.pages.BLOG].filter((p) => p.visibility === 'PUBLIC');
}

function shell(
  ctx: SiteCtx,
  options: {
    path: string;
    title: string;
    main: string;
    description?: string | null;
    image?: string | null;
    noindex?: boolean;
    ogType?: 'website' | 'article';
    pageId?: string | null;
    activeKey?: string | null;
    breadcrumbs?: Breadcrumb[];
    jsonLd?: Record<string, unknown> | null;
    previewNotice?: boolean;
    hero?: string;
  },
): string {
  return renderSiteShell({
    site: ctx.site,
    identity: ctx.identity,
    locale: ctx.locale,
    basePath: ctx.basePath,
    origin: ctx.req.origin,
    apiOrigin: ctx.req.apiOrigin,
    nonce: ctx.nonce,
    navPages: publicPages(ctx),
    hasWiki: ctx.pages.WIKI.some((p) => p.visibility === 'PUBLIC'),
    hasBlog: ctx.pages.BLOG.some((p) => p.visibility === 'PUBLIC'),
    inviteUrl: ctx.inviteUrl,
    ...options,
  });
}

// ─── Documents virtuels ─────────────────────────────────────────────────────

const mod = (module: string, config: Record<string, unknown> = {}) => ({ type: 'module', attrs: { module, config } });

/** Accueil généré quand le propriétaire n'a pas désigné de page d'accueil. */
export const AUTO_HOME_ID = '_home';
export const ME_PAGE_ID = '_me';
export const VOTES_PAGE_ID = '_votes';
export const SHOP_PAGE_ID = '_shop';

export function virtualDocument(pageId: string): SiteDocument | null {
  if (pageId === AUTO_HOME_ID) {
    return normalizeSiteDocument({
      type: 'doc',
      // Chiffres, bouton Rejoindre et derniers articles sont dans la bannière d'accueil.
      content: [mod('wikiIndex')],
    });
  }
  if (pageId === VOTES_PAGE_ID) {
    return normalizeSiteDocument({ type: 'doc', content: [mod('vote'), mod('voteLeaderboard', { limit: 10 })] });
  }
  if (pageId === SHOP_PAGE_ID) {
    return normalizeSiteDocument({ type: 'doc', content: [mod('shop')] });
  }
  if (pageId === ME_PAGE_ID) {
    const cell = (module: string) => ({ type: 'gridCell', attrs: { span: 1, rowSpan: 1, surface: true }, content: [mod(module)] });
    return normalizeSiteDocument({
      type: 'doc',
      content: [
        mod('profile'),
        { type: 'grid', attrs: { columns: 2 }, content: [cell('memberRewards'), cell('memberSettings')] },
        mod('memberInventory'),
        mod('memberPurchases'),
        mod('ticket'),
      ],
    });
  }
  return null;
}

// ─── Rendu d'un document ────────────────────────────────────────────────────

export async function renderDocumentHtml(ctx: SiteCtx, doc: SiteDocument, pageId: string): Promise<string> {
  const moduleHtml = await renderDocumentBlocks(ctx.block, doc, pageId);
  return renderSiteDocument(doc, {
    basePath: ctx.basePath,
    host: ctx.req.host ?? '',
    moduleHtml,
    labels: { toc: m.site_toc({}, { locale: ctx.locale }), video: m.site_video({}, { locale: ctx.locale }), gallery: m.site_gallery({}, { locale: ctx.locale }) },
  });
}

function publishedDoc(page: Pick<PublishedPage, 'publishedContent'>): SiteDocument {
  return normalizeSiteDocument(page.publishedContent);
}

// ─── Contenu de chaque type de page ─────────────────────────────────────────

function hero(title: string, lead?: string | null, meta?: string, cover?: string | null): string {
  return `<header class="page-hero">
  ${cover ? `<img class="page-banner"${attrs({ src: cover, alt: '' })}>` : ''}
  <h1 class="page-title">${esc(title)}</h1>
  ${lead ? `<p class="page-lead">${esc(lead)}</p>` : ''}
  ${meta ? `<p class="page-meta">${meta}</p>` : ''}
</header>`;
}

function wikiParents(ctx: SiteCtx, page: Pick<PageSummary, 'parentId'>): PageSummary[] {
  const byId = new Map(ctx.pages.WIKI.map((p) => [p.id, p]));
  const chain: PageSummary[] = [];
  let current = page.parentId ? byId.get(page.parentId) : undefined;
  while (current && chain.length < 8) {
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}

export function breadcrumbsFor(ctx: SiteCtx, page: PublishedPage | PageSummary): Breadcrumb[] {
  const o = { locale: ctx.locale };
  const crumbs: Breadcrumb[] = [{ label: m.site_home({}, o), href: ctx.basePath }];
  if (page.kind === 'WIKI') {
    crumbs.push({ label: m.site_wiki({}, o), href: `${ctx.basePath}/wiki` });
    for (const parent of wikiParents(ctx, page)) crumbs.push({ label: parent.publishedTitle ?? parent.slug, href: pageUrl(ctx.basePath, parent) });
  } else if (page.kind === 'BLOG') {
    crumbs.push({ label: m.site_blog({}, o), href: `${ctx.basePath}/blog` });
  }
  crumbs.push({ label: page.publishedTitle ?? page.slug });
  return crumbs;
}

async function authorName(ctx: SiteCtx, authorId: string): Promise<string | null> {
  const identities = await getMemberIdentities(ctx.req.client, ctx.site.guildId, [authorId]).catch(() => new Map());
  return identities.get(authorId)?.displayName ?? null;
}

export async function renderCommentsSection(pageId: string, enabled: boolean, locale: SiteLocale): Promise<string> {
  const o = { locale };
  const comments = await prisma.siteComment.findMany({
    where: { pageId, status: 'VISIBLE' },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: { id: true, authorName: true, authorAvatar: true, content: true, createdAt: true },
  });
  const list = comments.length
    ? `<ul class="comment-list">${comments
        .map(
          (c) => `<li class="comment" id="c-${esc(c.id)}">${c.authorAvatar ? `<img class="avatar avatar-md"${attrs({ src: c.authorAvatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })}>` : `<span class="avatar avatar-md avatar-fallback" aria-hidden="true">${esc(c.authorName.slice(0, 1).toUpperCase())}</span>`}<div><p class="card-meta"><strong>${esc(c.authorName)}</strong> · ${timeTag(c.createdAt, locale, 'medium')}</p><p class="rich">${esc(c.content)}</p></div></li>`,
        )
        .join('')}</ul>`
    : `<p class="empty">${esc(m.site_comments_empty({}, o))}</p>`;
  const form = enabled
    ? `<form class="site-form"${attrs({ 'data-comment': pageId, 'data-requires-login': '1' })} novalidate>
  <p class="form-auth" data-login-hint>${esc(m.site_comment_login({}, o))}</p>
  <label class="sr-only" for="comment-${esc(pageId)}">${esc(m.site_comment_placeholder({}, o))}</label>
  <textarea id="comment-${esc(pageId)}" name="content" rows="3" maxlength="2000" required${attrs({ placeholder: m.site_comment_placeholder({}, o) })}></textarea>
  <p class="form-status" role="status" aria-live="polite"></p>
  <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(m.site_comment_send({}, o))}</button></div>
</form>`
    : '';
  return `<section class="comments"${attrs({ 'data-comments': pageId })}><h2>${esc(m.site_comments({}, o))}</h2>${list}${form}</section>`;
}

/**
 * Contenu principal d'une page publiée, selon son type. Sert au rendu serveur
 * (pages publiques) et à l'API (pages réservées, avec le visiteur).
 */
export async function renderPageMain(ctx: SiteCtx, page: PublishedPage): Promise<string> {
  const o = { locale: ctx.locale };
  const doc = publishedDoc(page);
  const body = await renderDocumentHtml(ctx, doc, page.id);
  const title = page.publishedTitle ?? page.slug;

  if (page.kind === 'WIKI') {
    const visible = visiblePages(ctx.pages.WIKI, ctx.block.viewer);
    const ids = new Set(visible.map((p) => p.id));
    const tree = renderWikiTree(visible.map((p) => (p.parentId && !ids.has(p.parentId) ? { ...p, parentId: null } : p)), ctx.basePath, null, page.id);
    const children = visible.filter((p) => p.parentId === page.id);
    const subpages = children.length
      ? `<nav class="mod"><p class="mod-title">${esc(m.site_wiki_subpages({}, o))}</p>${renderWikiTree(children.map((c) => ({ ...c, parentId: null })), ctx.basePath, null)}</nav>`
      : '';
    const headings = collectSiteHeadings(doc).filter((h) => h.level <= 3);
    const toc = headings.length >= 3
      ? `<nav class="toc" aria-label="${esc(m.site_toc({}, o))}"><p class="toc-title">${esc(m.site_toc({}, o))}</p><ol>${headings.map((h) => `<li class="toc-l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ol></nav>`
      : '';
    const meta = page.publishedAt ? esc(m.site_updated_on({ date: formatDate(page.publishedAt, ctx.locale, 'long') }, o)) : '';
    const readMark = `<div class="read-mark"${attrs({ 'data-read-page': page.id })} aria-hidden="true"></div>`;
    return `<div class="wiki-layout">
  <nav aria-label="${esc(m.site_wiki({}, o))}">${tree}</nav>
  <div class="with-aside">
    <article>${hero(title, page.excerpt, meta)}<div class="prose">${body}</div>${subpages}${readMark}</article>
    <aside>${toc}</aside>
  </div>
</div>`;
  }

  if (page.kind === 'BLOG') {
    const text = extractSiteDocumentText(doc);
    const author = await authorName(ctx, page.authorId);
    const meta = [
      timeTag(page.firstPublishedAt ?? page.publishedAt, ctx.locale, 'long'),
      author ? esc(m.site_by_author({ name: author }, o)) : '',
      esc(m.site_reading_time({ minutes: estimateReadingMinutes(text) }, o)),
    ]
      .filter(Boolean)
      .join(' · ');
    const tags = page.tags.length ? `<p class="tags">${page.tags.map((t) => `<a class="tag"${attrs({ href: `${ctx.basePath}/blog/tag/${encodeURIComponent(t)}` })}>${esc(t)}</a>`).join('')}</p>` : '';
    const articles = visiblePages(ctx.pages.BLOG, ctx.block.viewer);
    const index = articles.findIndex((a) => a.id === page.id);
    const newer = index > 0 ? articles[index - 1] : null;
    const older = index >= 0 && index < articles.length - 1 ? articles[index + 1] : null;
    const pager =
      newer || older
        ? `<nav class="pager">${older ? `<a class="prev"${attrs({ href: pageUrl(ctx.basePath, older) })}><small>${esc(m.site_previous_article({}, o))}</small>${esc(older.publishedTitle ?? older.slug)}</a>` : '<span></span>'}${newer ? `<a class="next"${attrs({ href: pageUrl(ctx.basePath, newer) })}><small>${esc(m.site_next_article({}, o))}</small>${esc(newer.publishedTitle ?? newer.slug)}</a>` : ''}</nav>`
        : '';
    const share = `<p class="btn-row"><button type="button" class="btn btn-ghost btn-sm" data-copy>${esc(m.site_copy_link({}, o))}</button></p>`;
    const comments = page.commentsEnabled ? await renderCommentsSection(page.id, true, ctx.locale) : '';
    return `<article>${hero(title, page.excerpt, meta, page.coverUrl)}${tags}<div class="prose">${body}</div>${share}${pager}${comments}</article>`;
  }

  const readMark = page.id === ctx.site.homePageId ? '' : `<div class="read-mark"${attrs({ 'data-read-page': page.id })} aria-hidden="true"></div>`;
  return `<article class="doc-wide">${page.id === ctx.site.homePageId ? '' : hero(title, page.excerpt, undefined, page.coverUrl)}<div class="prose wide">${body}</div>${readMark}</article>`;
}

// ─── Pages ──────────────────────────────────────────────────────────────────

function restrictedMain(ctx: SiteCtx, page: PublishedPage): string {
  const o = { locale: ctx.locale };
  const message =
    page.visibility === 'STAFF' ? m.site_restricted_staff({}, o) : page.visibility === 'ROLES' ? m.site_restricted_roles({}, o) : m.site_restricted_members({}, o);
  return `<div${attrs({ 'data-restricted': page.id })}>
  ${hero(m.site_restricted_title({}, o))}
  <p class="empty" data-restricted-message>${esc(message)}</p>
  <p class="btn-row" data-restricted-login hidden><a class="btn btn-primary btn-discord" data-login href="#">${esc(m.site_login({}, o))}</a></p>
</div>`;
}

/**
 * Invitation du site pour la bannière et le pied de page. L'absence est mise
 * en cache elle aussi : sans droit d'inviter, chaque page vue relancerait sinon
 * une tentative de création.
 */
async function pageInviteUrl(ctx: SiteCtx): Promise<string | null> {
  if (!ctx.guild) return null;
  const url = await cache.wrap(`guild:${ctx.site.guildId}:site-invite-url`, 600, async () => (await getSiteInviteUrl(ctx.block).catch(() => null)) ?? '');
  return url || null;
}

/** Bannière d'accueil : image du serveur, nom, accroche, membres, bouton Rejoindre. */
async function homeHero(ctx: SiteCtx): Promise<string> {
  const o = { locale: ctx.locale };
  const banner = safeBannerUrl(ctx.site.bannerUrl ?? ctx.identity.bannerUrl);
  const logo = ctx.site.logoUrl ?? ctx.identity.iconUrl;
  const counts = ctx.guild ? await getGuildCounts(ctx.block).catch(() => null) : null;
  const stats = counts
    ? `<p class="hero-stats"><span class="presence-dot" aria-hidden="true"></span><span>${esc(m.site_members_online({ count: formatNumber(counts.online, ctx.locale) }, o))}</span><span class="hero-sep" aria-hidden="true">·</span><span>${esc(m.site_members_total({ count: formatNumber(counts.members, ctx.locale) }, o))}</span></p>`
    : '';
  const join = ctx.inviteUrl
    ? `<p class="hero-actions"><a class="btn btn-primary btn-lg btn-discord"${attrs({ href: ctx.inviteUrl, rel: 'noopener', target: '_blank' })}>${esc(m.site_join_discord({}, o))}</a></p>`
    : '';
  return `<section${attrs({ class: banner ? 'site-hero has-image' : 'site-hero', style: banner ? `--hero-image:url("${banner}")` : null })}>
  <div class="container hero-inner">
    ${logo ? `<img class="hero-logo"${attrs({ src: logo, alt: '', width: 96, height: 96 })}>` : ''}
    <h1 class="hero-title">${esc(ctx.identity.name)}</h1>
    ${ctx.site.tagline ? `<p class="hero-lead">${esc(ctx.site.tagline)}</p>` : ''}
    ${stats}
    ${join}
  </div>
</section>`;
}

/** Trois derniers articles sous la bannière, sauf si la page d'accueil liste déjà le blog. */
function homeNews(ctx: SiteCtx, doc: SiteDocument): string {
  const modules = collectSiteModules(doc);
  if (modules.includes('blogList')) return '';
  const articles = visiblePages(ctx.pages.BLOG, null).slice(0, 3);
  if (articles.length === 0) return '';
  const o = { locale: ctx.locale };
  return `<section class="home-section">
  <div class="section-head"><h2>${esc(m.site_latest_news({}, o))}</h2><a${attrs({ href: `${ctx.basePath}/blog` })}>${esc(m.site_all_news({}, o))}${siteIconSvg('arrow-right', 16)}</a></div>
  ${renderArticleCards(ctx.block, articles)}
</section>`;
}

async function pageResponse(ctx: SiteCtx, page: PublishedPage, path: string, home?: { hero: string; before: string }): Promise<SiteHttpResponse> {
  const title = page.publishedTitle ?? page.slug;
  if (checkPageAccess(page, null) !== 'allowed') {
    // Ni titre ni contenu : une page réservée ne se dévoile pas à qui n'y a pas droit.
    const body = shell(ctx, { path, title: m.site_restricted_title({}, { locale: ctx.locale }), main: restrictedMain(ctx, page), noindex: true, pageId: page.id });
    return html(200, body, ctx.nonce, ctx.req.apiOrigin, { noindex: true });
  }
  const main = (home?.before ?? '') + (await renderPageMain(ctx, page));
  const isArticle = page.kind === 'BLOG';
  const description = page.seoDescription ?? page.excerpt ?? null;
  const absolute = `${ctx.req.origin}${path}`;
  const jsonLd = isArticle
    ? {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: page.seoTitle ?? title,
        description: description ?? undefined,
        datePublished: (page.firstPublishedAt ?? page.publishedAt)?.toISOString(),
        dateModified: page.publishedAt?.toISOString(),
        image: page.coverUrl ? (page.coverUrl.startsWith('/') ? `${ctx.req.origin}${page.coverUrl}` : page.coverUrl) : undefined,
        mainEntityOfPage: absolute,
        publisher: { '@type': 'Organization', name: ctx.identity.name },
      }
    : null;
  const body = shell(ctx, {
    path,
    title: page.seoTitle ?? title,
    description,
    image: page.coverUrl,
    ogType: isArticle ? 'article' : 'website',
    pageId: page.id,
    activeKey: page.kind === 'PAGE' ? (page.id === ctx.site.homePageId ? 'home' : page.id) : page.kind === 'WIKI' ? 'wiki' : 'blog',
    breadcrumbs: page.kind === 'PAGE' ? undefined : breadcrumbsFor(ctx, page),
    jsonLd,
    main,
    hero: home?.hero,
  });
  return html(200, body, ctx.nonce, ctx.req.apiOrigin, { cacheSeconds: 30 });
}

async function homeResponse(ctx: SiteCtx): Promise<SiteHttpResponse> {
  const heroHtml = await homeHero(ctx);
  if (ctx.site.homePageId) {
    const page = await getPublishedPageById(ctx.site.id, ctx.site.homePageId);
    // Page réservée en accueil : pas de bannière, la page explique l'accès.
    if (page && checkPageAccess(page, null) === 'allowed') return pageResponse(ctx, page, ctx.basePath, { hero: heroHtml, before: homeNews(ctx, publishedDoc(page)) });
    if (page) return pageResponse(ctx, page, ctx.basePath);
  }
  const doc = virtualDocument(AUTO_HOME_ID)!;
  const body = await renderDocumentHtml(ctx, doc, AUTO_HOME_ID);
  const main = `${homeNews(ctx, doc)}<div class="prose wide">${body}</div>`;
  const jsonLd = { '@context': 'https://schema.org', '@type': 'WebSite', name: ctx.identity.name, url: `${ctx.req.origin}${ctx.basePath}` };
  return html(200, shell(ctx, { path: ctx.basePath, title: ctx.identity.name, description: ctx.site.tagline, main, hero: heroHtml, activeKey: 'home', pageId: AUTO_HOME_ID, jsonLd }), ctx.nonce, ctx.req.apiOrigin, { cacheSeconds: 30 });
}

function wikiIndexResponse(ctx: SiteCtx): SiteHttpResponse {
  const o = { locale: ctx.locale };
  const pages = ctx.pages.WIKI.filter((p) => p.visibility === 'PUBLIC');
  const ids = new Set(pages.map((p) => p.id));
  const tree = renderWikiTree(pages.map((p) => (p.parentId && !ids.has(p.parentId) ? { ...p, parentId: null } : p)), ctx.basePath, null);
  const main = `${hero(m.site_wiki({}, o))}${renderSearchForm(ctx.basePath, ctx.locale)}<div class="mod">${tree || `<p class="empty">${esc(m.site_wiki_empty({}, o))}</p>`}</div>`;
  const path = `${ctx.basePath}/wiki`;
  return html(200, shell(ctx, { path, title: m.site_wiki({}, o), main, activeKey: 'wiki', breadcrumbs: [{ label: m.site_home({}, o), href: ctx.basePath }, { label: m.site_wiki({}, o) }] }), ctx.nonce, ctx.req.apiOrigin, { cacheSeconds: 30 });
}

function blogIndexResponse(ctx: SiteCtx, tag: string | null): SiteHttpResponse {
  const o = { locale: ctx.locale };
  let articles = ctx.pages.BLOG.filter((p) => p.visibility === 'PUBLIC');
  if (tag) articles = articles.filter((a) => a.tags.includes(tag));
  const title = tag ? m.site_tag_title({ tag }, o) : m.site_blog({}, o);
  const main = `${hero(title)}${articles.length ? renderArticleCards(ctx.block, articles.slice(0, 60)) : `<p class="empty">${esc(m.site_blog_empty({}, o))}</p>`}`;
  const path = tag ? `${ctx.basePath}/blog/tag/${encodeURIComponent(tag)}` : `${ctx.basePath}/blog`;
  const crumbs: Breadcrumb[] = [{ label: m.site_home({}, o), href: ctx.basePath }, { label: m.site_blog({}, o), href: tag ? `${ctx.basePath}/blog` : undefined }];
  if (tag) crumbs.push({ label: tag });
  return html(200, shell(ctx, { path, title, main, activeKey: 'blog', breadcrumbs: crumbs, noindex: Boolean(tag) }), ctx.nonce, ctx.req.apiOrigin, { cacheSeconds: 30 });
}

async function searchResponse(ctx: SiteCtx): Promise<SiteHttpResponse> {
  const o = { locale: ctx.locale };
  const query = (ctx.req.query.get('q') ?? '').trim().slice(0, 100);
  let results = '';
  if (query.length >= 2) {
    const states = ctx.block.moduleStates;
    const hits = (await searchSite(ctx.site.id, query)).filter(
      (hit) => hit.visibility === 'PUBLIC' && !(hit.kind === 'WIKI' && states.site_wiki === false) && !(hit.kind === 'BLOG' && states.site_blog === false),
    );
    results = hits.length
      ? `<p class="mod-meta">${esc(m.site_search_results({ query }, o))}</p><ul class="search-results">${hits
          .map((hit) => `<li><a${attrs({ href: pageUrl(ctx.basePath, hit) })}>${esc(hit.title)}</a><p>${hit.snippetHtml}</p></li>`)
          .join('')}</ul>`
      : `<p class="empty">${esc(m.site_search_empty({}, o))}</p>`;
  } else if (query) {
    results = `<p class="empty">${esc(m.site_search_hint({}, o))}</p>`;
  }
  const main = `${hero(m.site_search({}, o))}${renderSearchForm(ctx.basePath, ctx.locale, query)}${results}`;
  return html(200, shell(ctx, { path: `${ctx.basePath}/search`, title: m.site_search({}, o), main, activeKey: 'search', noindex: true }), ctx.nonce, ctx.req.apiOrigin, { noindex: true });
}

async function meResponse(ctx: SiteCtx): Promise<SiteHttpResponse> {
  const o = { locale: ctx.locale };
  const body = await renderDocumentHtml(ctx, virtualDocument(ME_PAGE_ID)!, ME_PAGE_ID);
  const main = `${hero(m.site_my_space({}, o))}<div class="prose wide">${body}</div>`;
  return html(200, shell(ctx, { path: `${ctx.basePath}/me`, title: m.site_my_space({}, o), main, activeKey: 'me', noindex: true, pageId: ME_PAGE_ID }), ctx.nonce, ctx.req.apiOrigin, { noindex: true });
}

/** Profil public d'un membre (masquable par le membre, non indexé). */
/** Pages du forum, habillées comme les autres pages du site. */
function forumResponse(ctx: SiteCtx, page: ForumPage | null): SiteHttpResponse {
  if (!page) return notFound(ctx);
  const main = `${hero(page.title, page.lead ?? null)}<div class="forum">${page.main}</div>`;
  return html(200, shell(ctx, { path: page.path, title: page.title, main, activeKey: 'forum', breadcrumbs: page.breadcrumbs, noindex: page.noindex }), ctx.nonce, ctx.req.apiOrigin, {
    cacheSeconds: 15,
    noindex: page.noindex,
  });
}

/** Boutique du serveur. */
async function shopResponse(ctx: SiteCtx): Promise<SiteHttpResponse> {
  const o = { locale: ctx.locale };
  const body = await renderDocumentHtml(ctx, virtualDocument(SHOP_PAGE_ID)!, SHOP_PAGE_ID);
  const main = `${hero(m.site_shop_page_title({}, o), m.site_shop_page_lead({}, o))}<div class="prose wide">${body}</div>`;
  return html(200, shell(ctx, { path: `${ctx.basePath}/shop`, title: m.site_shop_page_title({}, o), main, activeKey: 'shop', pageId: SHOP_PAGE_ID }), ctx.nonce, ctx.req.apiOrigin, { cacheSeconds: 30 });
}

/** Page des votes : où voter, statut du membre, meilleurs votants du mois. */
async function votesResponse(ctx: SiteCtx): Promise<SiteHttpResponse> {
  const o = { locale: ctx.locale };
  const body = await renderDocumentHtml(ctx, virtualDocument(VOTES_PAGE_ID)!, VOTES_PAGE_ID);
  const main = `${hero(m.site_vote_page_title({}, o), m.site_vote_page_lead({}, o))}<div class="prose wide">${body}</div>`;
  return html(200, shell(ctx, { path: `${ctx.basePath}/votes`, title: m.site_vote_page_title({}, o), main, activeKey: 'votes', pageId: VOTES_PAGE_ID }), ctx.nonce, ctx.req.apiOrigin, { cacheSeconds: 30 });
}

async function memberProfileResponse(ctx: SiteCtx, userId: string): Promise<SiteHttpResponse> {
  const o = { locale: ctx.locale };
  const profile = await getPublicMemberProfile(ctx.req.client, ctx.site.guildId, userId);
  if (!profile) return statePage(ctx, 404, m.site_member_profile_missing_title({}, o), m.site_member_profile_missing_desc({}, o));
  const tile = (value: string, label: string) => `<div class="stat"><p class="stat-value">${esc(value)}</p><p class="stat-label">${esc(label)}</p></div>`;
  const tiles = [
    profile.level ? tile(m.site_level({ level: profile.level.level }, o), `${formatNumber(profile.level.xp, ctx.locale)} XP`) : '',
    profile.level ? tile(`#${formatNumber(profile.level.rank, ctx.locale)}`, m.site_leaderboard_xp({}, o)) : '',
    profile.reputation ? tile(formatNumber(profile.reputation, ctx.locale), m.site_rep({ value: '' }, o).trim()) : '',
    tile(formatNumber(profile.messageCount, ctx.locale), m.site_member_messages({}, o)),
    profile.voiceHours ? tile(formatNumber(profile.voiceHours, ctx.locale), m.site_member_voice_hours({}, o)) : '',
  ].join('');
  const meta = [
    profile.username ? `@${esc(profile.username)}` : '',
    profile.joinedAt ? esc(m.site_member_since({ date: formatDate(profile.joinedAt, ctx.locale, 'long') }, o)) : '',
    profile.isStaff ? `<span class="pill">${esc(m.site_staff_other({}, o))}</span>` : '',
  ].filter(Boolean).join(' · ');
  const avatarHtml = profile.avatarUrl
    ? `<img class="member-avatar"${attrs({ src: profile.avatarUrl, alt: '', width: 96, height: 96 })}>`
    : `<span class="member-avatar" aria-hidden="true">${esc(profile.displayName.slice(0, 1).toUpperCase())}</span>`;
  const main = `<article class="member-profile">
  <header class="member-head">${avatarHtml}<div><h1 class="page-title">${esc(profile.displayName)}</h1><p class="page-meta">${meta}</p></div></header>
  ${profile.bio ? `<p class="member-bio">${esc(profile.bio)}</p>` : ''}
  <div class="stats">${tiles}</div>
</article>`;
  return html(200, shell(ctx, { path: `${ctx.basePath}/u/${profile.userId}`, title: profile.displayName, main, image: profile.avatarUrl, noindex: true }), ctx.nonce, ctx.req.apiOrigin, { cacheSeconds: 60, noindex: true });
}

async function formResponse(ctx: SiteCtx, formId: string): Promise<SiteHttpResponse> {
  const form = /^[a-z0-9]{20,32}$/i.test(formId) ? await loadSiteForm(ctx.site.guildId, formId) : null;
  if (!form || ctx.block.moduleStates.custom_forms === false) return notFound(ctx);
  const eventId = ctx.req.query.get('event');
  const main = `${hero(form.name, form.description)}${renderSiteForm(form, ctx.locale, { eventId: eventId && /^[a-z0-9]{20,32}$/i.test(eventId) ? eventId : null })}`;
  return html(200, shell(ctx, { path: `${ctx.basePath}/form/${form.id}`, title: form.name, description: form.description, main }), ctx.nonce, ctx.req.apiOrigin);
}

function statePage(ctx: SiteCtx, status: number, title: string, description: string): SiteHttpResponse {
  const o = { locale: ctx.locale };
  const main = `<div class="state-page"><h1>${esc(title)}</h1><p>${esc(description)}</p><p><a class="btn btn-secondary"${attrs({ href: ctx.basePath })}>${esc(m.site_back_home({}, o))}</a></p></div>`;
  return html(status, shell(ctx, { path: ctx.basePath, title, main, noindex: true }), ctx.nonce, ctx.req.apiOrigin, { noindex: true });
}

function notFound(ctx: SiteCtx): SiteHttpResponse {
  const o = { locale: ctx.locale };
  return statePage(ctx, 404, m.site_not_found_title({}, o), m.site_not_found_desc({}, o));
}

/** Page d'état hors de tout site (slug inconnu) : pas de thème de serveur, le thème par défaut. */
function bareStatePage(req: SiteHttpRequest, status: number, title: string, description: string): SiteHttpResponse {
  const nonce = createNonce();
  const body = `<!doctype html><html lang="${pickLocale(req.query, req.acceptLanguage)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/s/_/site.css"><style nonce="${nonce}">:root{--site-bg:#0b0d12;--site-surface:rgba(255,255,255,.05);--site-surface-strong:rgba(255,255,255,.08);--site-text:#e9ebf1;--site-muted:#9aa2b1;--site-border:rgba(255,255,255,.09);--site-accent:#7c6cff;--site-on-accent:#fff;--site-radius:16px;--site-font:system-ui;--site-heading-font:system-ui}</style></head><body><main class="state-page"><h1>${esc(title)}</h1><p>${esc(description)}</p></main></body></html>`;
  const response = html(status, body, nonce, req.apiOrigin, { noindex: true });
  // La page d'état pose ses variables dans une balise à nonce.
  response.headers['Content-Security-Policy'] = response.headers['Content-Security-Policy'].replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`);
  return response;
}

// ─── Fichiers : flux, plan du site, thème, intégration ──────────────────────

function xmlEscape(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);
}

async function rssResponse(ctx: SiteCtx): Promise<SiteHttpResponse> {
  const articles = ctx.pages.BLOG.filter((p) => p.visibility === 'PUBLIC').slice(0, 30);
  const news =
    ctx.block.moduleStates.news === false
      ? []
      : await prisma.newsArticle.findMany({
          where: { guildId: ctx.site.guildId, published: true },
          orderBy: { publishedAt: 'desc' },
          take: 20,
          select: { id: true, title: true, summary: true, content: true, publishedAt: true },
        });
  const items = [
    ...articles.map((a) => ({
      title: a.publishedTitle ?? a.slug,
      link: `${ctx.req.origin}${pageUrl(ctx.basePath, a)}`,
      guid: `${ctx.req.origin}${pageUrl(ctx.basePath, a)}`,
      description: a.excerpt ?? '',
      date: a.firstPublishedAt ?? a.publishedAt ?? new Date(),
    })),
    ...news.map((n) => ({
      title: n.title,
      link: `${ctx.req.origin}${ctx.basePath}`,
      guid: `kotbo-news-${n.id}`,
      description: n.summary ?? n.content.slice(0, 400),
      date: n.publishedAt,
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xmlEscape(ctx.identity.name)}</title>
<link>${xmlEscape(`${ctx.req.origin}${ctx.basePath}`)}</link>
<description>${xmlEscape(ctx.site.tagline ?? ctx.identity.name)}</description>
<language>${ctx.locale}</language>
<atom:link href="${xmlEscape(`${ctx.req.origin}${ctx.basePath}/rss.xml`)}" rel="self" type="application/rss+xml"/>
${items
  .map(
    (i) => `<item><title>${xmlEscape(i.title)}</title><link>${xmlEscape(i.link)}</link><guid isPermaLink="${i.guid.startsWith('http') ? 'true' : 'false'}">${xmlEscape(i.guid)}</guid><pubDate>${i.date.toUTCString()}</pubDate><description>${xmlEscape(i.description)}</description></item>`,
  )
  .join('\n')}
</channel>
</rss>`;
  return plain(200, xml, 'application/rss+xml; charset=utf-8', 'public, max-age=600');
}

function sitemapResponse(ctx: SiteCtx): SiteHttpResponse {
  const urls: Array<{ loc: string; lastmod?: Date | null }> = [{ loc: ctx.basePath, lastmod: ctx.site.updatedAt }];
  if (ctx.pages.WIKI.some((p) => p.visibility === 'PUBLIC')) urls.push({ loc: `${ctx.basePath}/wiki` });
  if (ctx.pages.BLOG.some((p) => p.visibility === 'PUBLIC')) urls.push({ loc: `${ctx.basePath}/blog` });
  for (const page of publicPages(ctx)) {
    if (page.id === ctx.site.homePageId) continue;
    urls.push({ loc: pageUrl(ctx.basePath, page), lastmod: page.publishedAt });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${xmlEscape(`${ctx.req.origin}${u.loc}`)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.toISOString().slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`;
  return plain(200, xml, 'application/xml; charset=utf-8', 'public, max-age=3600');
}

async function sitemapIndexResponse(req: SiteHttpRequest): Promise<SiteHttpResponse> {
  const sites = await prisma.communitySite.findMany({
    where: { published: true, suspendedAt: null },
    select: { slug: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 50_000,
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sites.map((s) => `<sitemap><loc>${xmlEscape(`${req.origin}/s/${s.slug}/sitemap.xml`)}</loc><lastmod>${s.updatedAt.toISOString().slice(0, 10)}</lastmod></sitemap>`).join('\n')}
</sitemapindex>`;
  return plain(200, xml, 'application/xml; charset=utf-8', 'public, max-age=3600');
}

/** `robots.txt` du dashboard : tout reste indexable, le plan des sites est annoncé. */
export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /s/*/preview/\nDisallow: /s/*/me\n\nSitemap: ${origin}/s/sitemap.xml\n`;
}

function themeCssResponse(ctx: SiteCtx): SiteHttpResponse {
  // Repassé au filtre au service : le CSS stocké l'a déjà été, mais une règle
  // ajoutée au filtre depuis s'applique ainsi sans réenregistrer chaque site.
  const custom = prepareSiteCss(ctx.site.customCss ?? '', SITE_ASSET_PATH_PREFIX);
  const css = renderThemeCss({ ...ctx.site, customCss: custom }, ctx.identity.bannerUrl);
  return plain(200, css, 'text/css; charset=utf-8', ctx.req.query.get('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
}

async function embedResponse(ctx: SiteCtx, pageId: string, indexRaw: string): Promise<SiteHttpResponse> {
  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isInteger(index) || index < 0) return notFound(ctx);
  let doc: SiteDocument | null = virtualDocument(pageId);
  if (!doc) {
    const page = await getPublishedPageById(ctx.site.id, pageId);
    if (!page || page.visibility !== 'PUBLIC') return notFound(ctx);
    doc = publishedDoc(page);
  }
  const { findModuleNode } = await import('./blocks/index.js');
  const node = findModuleNode(doc, index);
  if (!node) return notFound(ctx);
  const block = await renderBlock(ctx.block, node.key, node.config, { pageId, index });
  const o = { locale: ctx.locale };
  const nonce = ctx.nonce;
  const updated = ctx.site.updatedAt instanceof Date ? ctx.site.updatedAt.getTime() : 0;
  const body = `<!doctype html>
<html lang="${ctx.locale}"${attrs({ 'data-site': ctx.site.id, 'data-guild': ctx.site.guildId, 'data-base': ctx.basePath, 'data-api': ctx.req.apiOrigin, 'data-page': pageId })}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(ctx.identity.name)}</title>
<link rel="stylesheet" href="/s/_/site.css"><link rel="stylesheet"${attrs({ href: `${ctx.basePath}/_/theme.css?v=${updated}` })}>
<script defer${attrs({ src: '/s/_/site.js', nonce })}></script>
</head>
<body class="embed"><div class="site-root" style="isolation:isolate !important;padding:8px">${block}</div>
<div class="kotbo-bar"><a class="kotbo-mark"${attrs({ href: `${ctx.req.origin}${ctx.basePath}`, target: '_blank', rel: 'noopener' })}>${esc(ctx.identity.name)} · ${esc(m.site_powered_by({}, o))}</a></div>
</body></html>`;
  return html(200, body, nonce, ctx.req.apiOrigin, { embed: true, cacheSeconds: 60, noindex: true });
}

async function previewResponse(ctx: SiteCtx, token: string): Promise<SiteHttpResponse> {
  const pageId = verifyPreviewToken(token);
  if (!pageId) return notFound(ctx);
  const page = await prisma.sitePage.findFirst({
    where: { id: pageId, siteId: ctx.site.id },
    select: { id: true, kind: true, slug: true, title: true, draftContent: true, excerpt: true, coverUrl: true, parentId: true, tags: true, authorId: true },
  });
  if (!page) return notFound(ctx);
  const doc = normalizeSiteDocument(page.draftContent);
  const body = await renderDocumentHtml(ctx, doc, page.id);
  const main = `${hero(page.title, page.excerpt, undefined, page.coverUrl)}<div class="${page.kind === 'PAGE' ? 'prose wide' : 'prose'}">${body}</div>`;
  return html(200, shell(ctx, { path: `${ctx.basePath}/preview/${token}`, title: page.title, main, noindex: true, previewNotice: true }), ctx.nonce, ctx.req.apiOrigin, { noindex: true });
}

// ─── Point d'entrée ─────────────────────────────────────────────────────────

const ASSET_FILE = /^([a-z0-9]{20,32})\.(webp|gif|png|jpg|avif)$/;

async function commonFile(req: SiteHttpRequest, rest: string[]): Promise<SiteHttpResponse | null> {
  const versioned = Boolean(req.query.get('v'));
  const cache = versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  if (rest.length === 1 && rest[0] === 'site.css') return plain(200, getSiteStylesheet().body, 'text/css; charset=utf-8', cache);
  if (rest.length === 1 && rest[0] === 'site.js') return plain(200, getSiteScript().body, 'text/javascript; charset=utf-8', cache);
  if (rest.length === 2 && rest[0] === 'a') {
    const match = ASSET_FILE.exec(rest[1]);
    const asset = match ? await readSiteAsset(match[1], match[2]) : null;
    if (!asset) return plain(404, 'Not found', 'text/plain; charset=utf-8', 'no-store');
    const mime = mimeForExtension(match![2]) ?? asset.mimeType;
    return {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
      body: asset.body,
    };
  }
  return null;
}

export async function handleSiteRequest(req: SiteHttpRequest): Promise<SiteHttpResponse> {
  const [first, ...rest] = req.segments;
  const o = { locale: pickLocale(req.query, req.acceptLanguage) };
  if (!first) return bareStatePage(req, 404, m.site_not_found_title({}, o), m.site_not_found_desc({}, o));
  if (first === '_') {
    return (await commonFile(req, rest)) ?? plain(404, 'Not found', 'text/plain; charset=utf-8', 'no-store');
  }
  if (first === 'sitemap.xml' && rest.length === 0) return sitemapIndexResponse(req);

  const lookup = await lookupSite(first);
  if (lookup.kind === 'missing') return bareStatePage(req, 404, m.site_not_found_title({}, o), m.site_not_found_desc({}, o));
  if (lookup.kind === 'redirect') {
    const suffix = rest.length ? `/${rest.map(encodeURIComponent).join('/')}` : '';
    const search = req.query.toString();
    return redirect(`/s/${lookup.slug}${suffix}${search ? `?${search}` : ''}`);
  }

  const site = lookup.site;
  if (site.suspendedAt) return bareStatePage(req, 451, m.site_suspended_title({}, o), m.site_suspended_desc({}, o));

  const ctx = await buildSiteCtx(req, site);
  ctx.inviteUrl = await pageInviteUrl(ctx);
  const [section, a, b] = rest;

  // Les fichiers techniques et l'aperçu restent servis avant la publication :
  // c'est le moyen de relire un site en construction.
  if (section === '_' && a === 'theme.css' && rest.length === 2) return themeCssResponse(ctx);
  if (section === 'preview' && a && rest.length === 2) return previewResponse(ctx, a);
  if (!site.published || ctx.block.moduleStates.site === false) return statePage(ctx, 404, m.site_unpublished_title({}, o), m.site_unpublished_desc({}, o));
  const wikiOn = ctx.block.moduleStates.site_wiki !== false;
  const blogOn = ctx.block.moduleStates.site_blog !== false;
  if ((section === 'wiki' && !wikiOn) || (section === 'blog' && !blogOn)) return notFound(ctx);

  let response: SiteHttpResponse;
  let trackPath: string | null = `/${rest.join('/')}`;
  try {
    if (rest.length === 0) response = await homeResponse(ctx);
    else if (section === 'rss.xml' && rest.length === 1) (response = await rssResponse(ctx)), (trackPath = null);
    else if (section === 'sitemap.xml' && rest.length === 1) (response = sitemapResponse(ctx)), (trackPath = null);
    else if (section === 'embed' && a && b && rest.length === 3) (response = await embedResponse(ctx, a, b)), (trackPath = null);
    else if (section === 'search' && rest.length === 1) response = await searchResponse(ctx);
    else if (section === 'me' && rest.length === 1) response = await meResponse(ctx);
    else if (section === 'u' && a && rest.length === 2) response = await memberProfileResponse(ctx, a);
    else if (section === 'votes' && rest.length === 1) response = await votesResponse(ctx);
    else if ((section === 'shop' || section === 'boutique') && rest.length === 1) response = await shopResponse(ctx);
    else if (section === 'forum' && rest.length === 1) response = forumResponse(ctx, await forumIndexPage(ctx.block));
    else if (section === 'forum' && a && rest.length === 2) response = forumResponse(ctx, await forumCategoryPage(ctx.block, a, parseForumPage(ctx.req.query.get('page'))));
    else if (section === 'forum' && a && b && /^[a-z0-9]{20,32}$/.test(b) && rest.length === 3) {
      response = forumResponse(ctx, await forumTopicPage(ctx.block, a, b, parseForumPage(ctx.req.query.get('page'))));
    }
    else if (section === 'form' && a && rest.length === 2) response = await formResponse(ctx, a);
    else if (section === 'wiki' && rest.length === 1) response = wikiIndexResponse(ctx);
    else if (section === 'wiki' && a && rest.length === 2) {
      const page = await getPublishedPage(site.id, 'WIKI', a);
      response = page ? await pageResponse(ctx, page, `${ctx.basePath}/wiki/${page.slug}`) : notFound(ctx);
    } else if (section === 'blog' && rest.length === 1) response = blogIndexResponse(ctx, null);
    else if (section === 'blog' && a === 'tag' && b && rest.length === 3) response = blogIndexResponse(ctx, b.slice(0, 40));
    else if (section === 'blog' && a && rest.length === 2) {
      const page = await getPublishedPage(site.id, 'BLOG', a);
      response = page ? await pageResponse(ctx, page, `${ctx.basePath}/blog/${page.slug}`) : notFound(ctx);
    } else if (rest.length === 1) {
      const page = await getPublishedPage(site.id, 'PAGE', section);
      // La page d'accueil n'a qu'une adresse : la racine du site.
      if (page && page.id === site.homePageId) return redirect(ctx.basePath);
      response = page ? await pageResponse(ctx, page, `${ctx.basePath}/${page.slug}`) : notFound(ctx);
    } else {
      response = notFound(ctx);
    }
  } catch (err) {
    logger.error('Site', `Rendu de ${req.segments.join('/')} impossible :`, err);
    response = statePage(ctx, 500, m.site_error_generic({}, o), '');
  }

  if (trackPath !== null && response.status === 200 && String(response.headers['Content-Type']).startsWith('text/html')) {
    void recordSiteHit({
      siteId: site.id,
      guildId: site.guildId,
      path: trackPath || '/',
      referrer: req.referrer,
      userAgent: req.userAgent,
      ip: req.ip,
      host: req.host,
    }).catch(() => null);
  }
  return response;
}

/**
 * Gabarit d'une page du site communautaire : `<head>`, barre de navigation (ou
 * menu latéral selon le thème), bannière d'accueil, contenu, pied de page en
 * colonnes, habillage Kotbo.
 *
 * La racine du contenu (`.site-root`) porte un style en ligne `!important`
 * qu'aucune feuille ne peut écraser : elle crée son propre contexte
 * d'empilement, si bien que rien du contenu (CSS libre compris) ne peut passer
 * au-dessus de `.kotbo-bar`, rendue après elle et hors d'elle.
 */

import {
  normalizeSiteNavigation,
  resolveSiteTheme,
  siteFontStylesheetUrl,
  siteIconSvg,
  siteThemeColorCss,
  type ResolvedSiteTheme,
  type SiteNavItem,
} from '@kotbo/shared';
import * as m from '../../lib/paraglide/messages.js';
import { attrs, cls, esc } from './siteHtml.js';
import type { SiteLocale } from './blocks/blockContext.js';
import type { PageSummary, SiteRecord } from './siteService.js';
import { pageUrl } from './blocks/contentBlocks.js';
import { getSiteAssetVersions } from './siteAssets.js';
import { renderSearchForm } from './blocks/contentBlocks.js';

export interface SiteIdentity {
  name: string;
  iconUrl: string | null;
  bannerUrl: string | null;
}

export interface Breadcrumb {
  label: string;
  href?: string;
}

export interface ShellOptions {
  site: SiteRecord;
  identity: SiteIdentity;
  locale: SiteLocale;
  basePath: string;
  /** Origine publique du dashboard, pour les URL canoniques. */
  origin: string;
  /** Origine de l'API, que le script du site appelle avec les identifiants. */
  apiOrigin: string;
  nonce: string;
  path: string;
  title: string;
  description?: string | null;
  image?: string | null;
  noindex?: boolean;
  ogType?: 'website' | 'article';
  pageId?: string | null;
  /** Section active du menu : identifiant de page, ou `wiki`/`blog`/`search`/`me`/`home`. */
  activeKey?: string | null;
  breadcrumbs?: Breadcrumb[];
  /** Pages publiées, pour résoudre les entrées du menu. */
  navPages: PageSummary[];
  hasWiki: boolean;
  hasBlog: boolean;
  /** Invitation Discord du site, reprise dans le pied de page. */
  inviteUrl?: string | null;
  /** Bannière pleine largeur entre la barre et le contenu (accueil). */
  hero?: string;
  main: string;
  /** Données structurées schema.org, sérialisées dans une balise à nonce. */
  jsonLd?: Record<string, unknown> | null;
  /** Aperçu de brouillon : bandeau d'avertissement. */
  previewNotice?: boolean;
}

interface ResolvedNavItem {
  label: string;
  href: string | null;
  key: string | null;
  external: boolean;
  children: ResolvedNavItem[];
}

function resolveNav(items: SiteNavItem[], opts: ShellOptions): ResolvedNavItem[] {
  const pageById = new Map(opts.navPages.map((p) => [p.id, p]));
  const resolve = (item: SiteNavItem): ResolvedNavItem | null => {
    const children = item.children.map(resolve).filter((c): c is ResolvedNavItem => c !== null);
    let href: string | null = null;
    let key: string | null = null;
    let external = false;
    const target = item.target;
    if (target?.type === 'page') {
      const page = pageById.get(target.pageId);
      if (page) {
        href = page.id === opts.site.homePageId ? opts.basePath : pageUrl(opts.basePath, page);
        key = page.id;
      }
    } else if (target?.type === 'section') {
      key = target.section;
      href = target.section === 'home' ? opts.basePath : `${opts.basePath}/${target.section}`;
      if (target.section === 'wiki' && !opts.hasWiki) href = null;
      if (target.section === 'blog' && !opts.hasBlog) href = null;
    } else if (target?.type === 'url') {
      href = target.href;
      external = true;
    }
    if (!href && children.length === 0) return null;
    return { label: item.label, href, key, external, children };
  };
  return items.map(resolve).filter((i): i is ResolvedNavItem => i !== null);
}

/** Menu par défaut, quand le propriétaire n'en a composé aucun. */
function defaultNav(opts: ShellOptions): SiteNavItem[] {
  const items: SiteNavItem[] = [{ id: 'home', label: m.site_home({}, { locale: opts.locale }), target: { type: 'section', section: 'home' }, children: [] }];
  for (const page of opts.navPages.filter((p) => p.kind === 'PAGE' && p.id !== opts.site.homePageId && !p.parentId).slice(0, 5)) {
    items.push({ id: page.id, label: page.publishedTitle ?? page.slug, target: { type: 'page', pageId: page.id }, children: [] });
  }
  if (opts.hasWiki) items.push({ id: 'wiki', label: m.site_wiki({}, { locale: opts.locale }), target: { type: 'section', section: 'wiki' }, children: [] });
  if (opts.hasBlog) items.push({ id: 'blog', label: m.site_blog({}, { locale: opts.locale }), target: { type: 'section', section: 'blog' }, children: [] });
  return items;
}

function navLink(item: ResolvedNavItem, activeKey: string | null | undefined): string {
  if (!item.href) return '';
  const current = item.key !== null && item.key === activeKey;
  return `<a${attrs({ href: item.href, 'aria-current': current ? 'page' : null, rel: item.external ? 'noopener noreferrer' : null, target: item.external ? '_blank' : null })}>${esc(item.label)}</a>`;
}

function renderNavItems(items: ResolvedNavItem[], activeKey: string | null | undefined): string {
  return items
    .map((item) => {
      if (item.children.length === 0) return navLink(item, activeKey);
      const open = item.children.some((c) => c.key !== null && c.key === activeKey);
      return `<details${open ? ' data-current' : ''}><summary>${esc(item.label)}${siteIconSvg('chevron-down', 16)}</summary><div>${navLink(item, activeKey)}${renderNavItems(item.children, activeKey)}</div></details>`;
    })
    .join('');
}

/** Liens du menu à plat, pour le pied de page. */
function flatLinks(items: ResolvedNavItem[]): ResolvedNavItem[] {
  return items.flatMap((item) => [item, ...flatLinks(item.children)]).filter((item) => item.href);
}

function brand(opts: ShellOptions, size = 36): string {
  const logo = opts.site.logoUrl ?? opts.identity.iconUrl;
  const mark = logo
    ? `<img${attrs({ src: logo, alt: '', width: size, height: size })}>`
    : `<span class="brand-fallback" aria-hidden="true">${esc(opts.identity.name.slice(0, 1).toUpperCase())}</span>`;
  return `<a class="brand"${attrs({ href: opts.basePath })}>${mark}<span class="brand-name">${esc(opts.identity.name)}</span></a>`;
}

function modeToggle(opts: ShellOptions): string {
  const label = m.site_mode_toggle({}, { locale: opts.locale });
  return `<button type="button" class="icon-btn mode-toggle" data-mode-toggle${attrs({ 'aria-label': label, title: label })}>${siteIconSvg('moon', 20, 'icon icon-moon')}${siteIconSvg('sun', 20, 'icon icon-sun')}</button>`;
}

function headerTop(opts: ShellOptions, nav: ResolvedNavItem[]): string {
  const o = { locale: opts.locale };
  return `<header class="site-header"><div class="container site-header-inner">
  ${brand(opts)}
  <nav id="site-nav" class="nav" aria-label="${esc(m.site_menu({}, o))}">${renderNavItems(nav, opts.activeKey)}</nav>
  <div class="header-actions">
    <a class="icon-btn"${attrs({ href: `${opts.basePath}/search`, 'aria-label': m.site_search({}, o), title: m.site_search({}, o) })}>${siteIconSvg('search')}</a>
    ${modeToggle(opts)}
    <span class="viewer-slot" data-viewer-slot></span>
    <button type="button" class="icon-btn menu-toggle" data-menu-toggle aria-controls="site-nav" aria-expanded="false" aria-label="${esc(m.site_menu({}, o))}">${siteIconSvg('menu')}</button>
  </div>
</div></header>`;
}

function sideNav(opts: ShellOptions, nav: ResolvedNavItem[]): string {
  const o = { locale: opts.locale };
  return `<div class="side-top">${brand(opts)}<div class="header-actions">${modeToggle(opts)}<button type="button" class="icon-btn" data-menu-toggle aria-controls="site-side" aria-expanded="false" aria-label="${esc(m.site_menu({}, o))}">${siteIconSvg('menu')}</button></div></div>
<aside id="site-side" class="side-nav">
  <div class="side-brand">${brand(opts)}${modeToggle(opts)}</div>
  ${renderSearchForm(opts.basePath, opts.locale)}
  <nav class="nav" aria-label="${esc(m.site_menu({}, o))}">${renderNavItems(nav, opts.activeKey)}</nav>
  <div class="viewer-slot" data-viewer-slot></div>
</aside>`;
}

function breadcrumbs(opts: ShellOptions): string {
  if (!opts.breadcrumbs || opts.breadcrumbs.length === 0) return '';
  const items = opts.breadcrumbs
    .map((crumb, i, all) =>
      crumb.href && i < all.length - 1 ? `<li><a${attrs({ href: crumb.href })}>${esc(crumb.label)}</a></li>` : `<li aria-current="page">${esc(crumb.label)}</li>`,
    )
    .join('');
  return `<nav class="breadcrumb" aria-label="${esc(m.site_breadcrumb({}, { locale: opts.locale }))}"><ol>${items}</ol></nav>`;
}

function footer(opts: ShellOptions, nav: ResolvedNavItem[]): string {
  const o = { locale: opts.locale };
  const links = flatLinks(nav)
    .slice(0, 8)
    .map((item) => `<li>${navLink(item, null)}</li>`)
    .join('');
  const community = [
    opts.inviteUrl ? `<li><a${attrs({ href: opts.inviteUrl, rel: 'noopener', target: '_blank' })}>${esc(m.site_join_discord({}, o))}</a></li>` : '',
    `<li><a${attrs({ href: `${opts.basePath}/search` })}>${esc(m.site_search({}, o))}</a></li>`,
    opts.hasBlog ? `<li><a${attrs({ href: `${opts.basePath}/rss.xml` })}>${esc(m.site_rss_feed({}, o))}</a></li>` : '',
  ].join('');
  const about = opts.site.tagline ? `<p>${esc(opts.site.tagline)}</p>` : '';
  return `<footer class="site-footer">
  <div class="container footer-grid">
    <div class="footer-about">${brand(opts, 32)}${about}</div>
    ${links ? `<nav class="footer-col" aria-label="${esc(m.site_footer_navigation({}, o))}"><h2>${esc(m.site_footer_navigation({}, o))}</h2><ul>${links}</ul></nav>` : ''}
    <div class="footer-col"><h2>${esc(m.site_footer_community({}, o))}</h2><ul>${community}</ul></div>
  </div>
  <div class="container footer-bottom">© ${new Date().getFullYear()} ${esc(opts.identity.name)}</div>
</footer>`;
}

function kotboBar(opts: ShellOptions): string {
  const o = { locale: opts.locale };
  const reasons = ['scam', 'illegal', 'hate', 'impersonation', 'other'] as const;
  const reasonLabel = (r: (typeof reasons)[number]) =>
    ({
      scam: m.site_report_reason_scam,
      illegal: m.site_report_reason_illegal,
      hate: m.site_report_reason_hate,
      impersonation: m.site_report_reason_impersonation,
      other: m.site_report_reason_other,
    })[r]({}, o);
  // Styles en ligne `!important` : plus forts que toute règle d'une feuille, CSS libre compris.
  return `<div class="kotbo-bar" style="display:flex !important;visibility:visible !important;opacity:1 !important;position:relative !important;z-index:2147483647 !important;transform:none !important;clip-path:none !important;filter:none !important">
  <a class="kotbo-mark" href="https://kotbo.fr" rel="noopener" target="_blank">${esc(m.site_powered_by({}, o))}</a>
  <button type="button" data-report-open>${esc(m.site_report({}, o))}</button>
</div>
<dialog class="kotbo-dialog" id="kotbo-report" aria-labelledby="kotbo-report-title">
  <form method="dialog" data-report-form>
    <h2 id="kotbo-report-title">${esc(m.site_report_title({}, o))}</h2>
    <p>${esc(m.site_report_intro({}, o))}</p>
    <div class="field"><label for="kotbo-report-reason">${esc(m.site_report_reason({}, o))}</label>
      <select id="kotbo-report-reason" name="reason" required>${reasons.map((r) => `<option value="${r}">${esc(reasonLabel(r))}</option>`).join('')}</select></div>
    <div class="field"><label for="kotbo-report-details">${esc(m.site_report_details({}, o))}</label>
      <textarea id="kotbo-report-details" name="details" rows="4" maxlength="2000"></textarea></div>
    <p class="form-status" role="status" aria-live="polite"></p>
    <div class="form-actions"><button type="button" class="btn btn-ghost" data-report-cancel>${esc(m.site_cancel({}, o))}</button><button type="submit" class="btn btn-primary">${esc(m.site_report_send({}, o))}</button></div>
  </form>
</dialog>`;
}

/** Textes dont le script du site a besoin, servis en JSON non exécutable. */
function clientStrings(locale: SiteLocale): Record<string, string> {
  const o = { locale };
  return {
    login: m.site_login({}, o),
    logout: m.site_logout({}, o),
    mySpace: m.site_my_space({}, o),
    loading: m.site_loading({}, o),
    error: m.site_error_generic({}, o),
    restrictedDenied: m.site_restricted_denied({}, o),
    formSent: m.site_form_sent({}, o),
    formRequired: m.site_form_required({}, o),
    formLogin: m.site_form_login_required({}, o),
    suggestionSent: m.site_suggestion_sent({}, o),
    marketBought: m.site_market_bought({}, o),
    reportSent: m.site_report_sent({}, o),
    linkCopied: m.site_link_copied({}, o),
    commentPending: m.site_comment_pending({}, o),
    forumDeleteConfirm: m.site_forum_delete_confirm({}, o),
    commentLogin: m.site_comment_login({}, o),
    commentsEmpty: m.site_comments_empty({}, o),
    commentSend: m.site_comment_send({}, o),
    commentPlaceholder: m.site_comment_placeholder({}, o),
    ticketType: m.site_ticket_type({}, o),
    ticketSubject: m.site_ticket_subject({}, o),
    ticketMessage: m.site_ticket_message({}, o),
    ticketOpen: m.site_ticket_open({}, o),
    ticketMine: m.site_ticket_mine({}, o),
    ticketNone: m.site_ticket_none({}, o),
    ticketReply: m.site_ticket_reply({}, o),
    ticketStatusOpen: m.site_ticket_status_open({}, o),
    ticketStatusClosed: m.site_ticket_status_closed({}, o),
    ticketStaff: m.site_ticket_staff({}, o),
    appealDisabled: m.site_appeal_disabled({}, o),
    agentActive: m.site_agent_active({ key: '{key}' }, o),
    agentInterrupt: m.site_agent_interrupt({}, o),
    agentInterrupted: m.site_agent_interrupted({}, o),
    rewardCoins: m.site_reward_coins({ count: '{count}' }, o),
    rewardXp: m.site_reward_xp({ count: '{count}' }, o),
    rewardDaily: m.site_reward_toast_daily({}, o),
    rewardRead: m.site_reward_toast_read({}, o),
    rewardOther: m.site_reward_toast_other({}, o),
    rewardStreak: m.site_reward_toast_streak({ count: '{count}' }, o),
  };
}

/** JSON sûr dans une balise `<script>` : `<` échappé, la balise ne peut pas se fermer. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Applique le mode choisi par le visiteur avant le premier rendu, pour éviter
 * un flash de l'autre palette. `data-effective` sert à l'icône de la bascule.
 */
function modeBootScript(siteId: string, defaultMode: string): string {
  return `(function(){var d=document.documentElement,k=${safeJson(`kotbo-site-mode:${siteId}`)},m=null;try{m=localStorage.getItem(k)}catch(e){}if(m==='light'||m==='dark')d.setAttribute('data-mode',m);var e=m||${safeJson(defaultMode)};if(e==='auto')e=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';d.setAttribute('data-effective',e)})();`;
}

/** Image de bannière utilisable en `url()` : HTTPS ou image du site, sans caractère qui casse la règle. */
export function safeBannerUrl(url: string | null | undefined): string | null {
  return url && /^(https:\/\/|\/s\/_\/a\/)[^"'()\s\\]+$/.test(url) ? url : null;
}

export function renderSiteShell(opts: ShellOptions): string {
  const theme: ResolvedSiteTheme = resolveSiteTheme(opts.site.theme, opts.site.themeSettings);
  const versions = getSiteAssetVersions();
  const o = { locale: opts.locale };
  const configured = normalizeSiteNavigation(opts.site.navigation);
  const nav = resolveNav(configured.length > 0 ? configured : defaultNav(opts), opts);
  const canonical = `${opts.origin}${opts.path}`;
  const fullTitle = opts.title === opts.identity.name ? opts.identity.name : `${opts.title} · ${opts.identity.name}`;
  const description = opts.description ?? opts.site.tagline ?? '';
  const image = opts.image ?? opts.site.bannerUrl ?? opts.identity.bannerUrl ?? opts.site.logoUrl ?? opts.identity.iconUrl;
  const absoluteImage = image && image.startsWith('/') ? `${opts.origin}${image}` : image;
  const favicon = opts.site.faviconUrl ?? opts.site.logoUrl ?? opts.identity.iconUrl;
  const updated = opts.site.updatedAt instanceof Date ? opts.site.updatedAt.getTime() : Date.parse(String(opts.site.updatedAt));

  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
${description ? `<meta name="description"${attrs({ content: description })}>` : ''}
<link rel="canonical"${attrs({ href: canonical })}>
${opts.noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta name="theme-color"${attrs({ content: theme.initial.header })}>
<meta name="color-scheme"${attrs({ content: theme.mode === 'auto' ? 'light dark' : theme.mode })}>
<meta property="og:site_name"${attrs({ content: opts.identity.name })}>
<meta property="og:title"${attrs({ content: opts.title })}>
<meta property="og:type"${attrs({ content: opts.ogType ?? 'website' })}>
<meta property="og:url"${attrs({ content: canonical })}>
<meta property="og:locale"${attrs({ content: opts.locale === 'fr' ? 'fr_FR' : 'en_GB' })}>
${description ? `<meta property="og:description"${attrs({ content: description })}>` : ''}
${absoluteImage ? `<meta property="og:image"${attrs({ content: absoluteImage })}><meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
${favicon ? `<link rel="icon"${attrs({ href: favicon })}>` : ''}
<link rel="alternate" type="application/rss+xml"${attrs({ title: opts.identity.name, href: `${opts.basePath}/rss.xml` })}>
<script${attrs({ nonce: opts.nonce })}>${modeBootScript(opts.site.id, theme.mode)}</script>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet"${attrs({ href: siteFontStylesheetUrl(theme) })}>
<link rel="stylesheet"${attrs({ href: `/s/_/site.css?v=${versions.css}` })}>
<link rel="stylesheet"${attrs({ href: `${opts.basePath}/_/theme.css?v=${updated}` })}>
${opts.jsonLd ? `<script type="application/ld+json"${attrs({ nonce: opts.nonce })}>${safeJson(opts.jsonLd)}</script>` : ''}
<script type="application/json" id="site-i18n"${attrs({ nonce: opts.nonce })}>${safeJson(clientStrings(opts.locale))}</script>
<script defer${attrs({ src: `/s/_/site.js?v=${versions.js}`, nonce: opts.nonce })}></script>`;

  const preview = opts.previewNotice ? `<div class="notice" role="note">${esc(m.site_draft_preview({}, o))}</div>` : '';
  const main = `<main id="contenu" class="main container" tabindex="-1">${preview}${breadcrumbs(opts)}${opts.main}</main>`;
  const hero = opts.hero ?? '';

  const body =
    theme.navLayout === 'side'
      ? `${sideNav(opts, nav)}<div class="layout-side-main">${hero}${main}${footer(opts, nav)}</div>`
      : `${headerTop(opts, nav)}${hero}${main}${footer(opts, nav)}`;

  return `<!doctype html>
<html${attrs({
    lang: opts.locale,
    'data-site': opts.site.id,
    'data-guild': opts.site.guildId,
    'data-base': opts.basePath,
    'data-api': opts.apiOrigin,
    'data-page': opts.pageId ?? null,
    'data-default-mode': theme.mode,
  })}>
<head>
${head}
</head>
<body${attrs({ 'data-background': theme.background, 'data-nav': theme.navLayout, 'data-theme': theme.key })}>
<a class="skip-link" href="#contenu">${esc(m.site_skip_to_content({}, o))}</a>
<div class="${cls('site-root', theme.navLayout === 'side' && 'layout-side')}" style="isolation:isolate !important;position:relative !important;z-index:0 !important">
${body}
</div>
${kotboBar(opts)}
</body>
</html>`;
}

/** Variables du thème, puis CSS libre du site : le contenu de `<base>/_/theme.css`. */
export function renderThemeCss(site: Pick<SiteRecord, 'theme' | 'themeSettings' | 'customCss' | 'bannerUrl'>, bannerUrl: string | null): string {
  const t = resolveSiteTheme(site.theme, site.themeSettings);
  const banner = safeBannerUrl(site.bannerUrl ?? bannerUrl);
  const vars = `:root{
  --site-accent:${t.accent};
  --site-on-accent:${t.onAccent};
  --site-radius:${t.radius}px;
  --site-font:"${t.font}";
  --site-heading-font:"${t.headingFont}";
  --discord-logo:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.3 18.3 0 0 0-5.5 0L8.6 3a19.7 19.7 0 0 0-4.9 1.4C.5 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2.1a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.7ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.4 8 10.4s2.2 1.1 2.2 2.5-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.5 2.2-2.5 2.2 1.1 2.2 2.5-1 2.4-2.2 2.4Z'/%3E%3C/svg%3E");
}
${siteThemeColorCss(t)}
${t.background === 'banner' && banner ? `body[data-background="banner"]{background:linear-gradient(color-mix(in srgb,var(--site-bg) 86%,transparent),var(--site-bg) 480px),url("${banner}") top center / 100% auto no-repeat,var(--site-bg)}` : ''}`;
  return `${vars}\n${site.customCss ?? ''}\n`;
}

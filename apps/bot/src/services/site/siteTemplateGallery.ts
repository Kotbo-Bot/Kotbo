/**
 * Galerie de modèles de site, partagée entre serveurs.
 *
 *  - Modèles officiels : les plans de départ de Kotbo (siteTemplates.ts),
 *    toujours en tête, remplis d'après les modules du serveur qui les applique.
 *  - Modèles partagés : un serveur publie son site tel quel (thème, menu,
 *    pages libres), publication directe. Les textes deviennent des textes
 *    d'exemple et les blocs de modules reviennent à leurs réglages par défaut
 *    (ils désignent des salons, formulaires ou rôles propres au serveur). Les
 *    images sont copiées vers le site qui applique le modèle.
 *
 * Appliquer un modèle remplace le thème, le menu et l'accueil, et crée ses
 * pages à côté de celles qui existent (rien n'est supprimé). L'état d'avant
 * est gardé dans `settings.templateUndo` : « Annuler » le rétablit et retire
 * les pages créées.
 */

import type { Client } from 'discord.js';
import { Prisma } from '@prisma/client';
import {
  extractSiteDocumentText,
  foldSearchText,
  normalizeModuleConfig,
  normalizeSiteDocument,
  normalizeSiteThemeSettings,
  isSiteModuleKey,
  sectionizeSiteDocument,
  SITE_THEME_KEYS,
  type SiteDocument,
  type SiteNavItem,
  type SiteNode,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import { getModuleStates } from '../core/moduleGate.js';
import { SiteAdminError, uniquePageSlug } from './siteAdminService.js';
import { invalidateSiteCache } from './siteService.js';
import { buildSiteBlueprint, SITE_TEMPLATES, type SiteTemplateKey } from './siteTemplates.js';
import { readSiteAsset, storeSiteAsset } from './siteUploads.js';

export const TEMPLATE_CATEGORIES = ['general', 'gaming', 'rp', 'esport', 'etude', 'autre'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

const MAX_TEMPLATES_PER_GUILD = 5;
const MAX_TEMPLATE_PAGES = 20;
/** Au-delà, un modèle partagé disparaît de la galerie en attendant l'administration Kotbo. */
const HIDE_AFTER_REPORTS = 5;
const OFFICIAL_PREFIX = 'official:';

type Lang = 'fr' | 'en';

const PLACEHOLDER: Record<Lang, { heading: string; text: string; question: string; name: string; code: string }> = {
  fr: { heading: 'Ton titre ici', text: 'Remplace ce texte par le tien : présente ton serveur, ce qu’on y fait et pourquoi le rejoindre.', question: 'Ta question ici ?', name: 'Un membre', code: '…' },
  en: { heading: 'Your title here', text: 'Replace this text with yours: introduce your server, what people do there and why they should join.', question: 'Your question here?', name: 'A member', code: '…' },
};

interface TemplatePageData {
  key: string;
  title: string;
  slug: string;
  content: SiteDocument;
  isHome: boolean;
  inNav: boolean;
}

type TemplateNavItem = { label: string; pageKey?: string; section?: 'home' | 'wiki' | 'blog' | 'search' | 'me' };

// ─── Document d'exemple ─────────────────────────────────────────────────────

const isInternalHref = (href: unknown) => typeof href === 'string' && (href.startsWith('/~') || href.startsWith('#'));

/**
 * Le document tel qu'il part dans la galerie : même mise en page, textes
 * d'exemple, modules aux réglages par défaut, liens externes retirés.
 */
export function toTemplateDocument(doc: SiteDocument, lang: Lang): SiteDocument {
  const ph = PLACEHOLDER[lang];
  const walk = (node: SiteNode): SiteNode => {
    const next: SiteNode = { ...node, attrs: node.attrs ? { ...node.attrs } : undefined };
    switch (node.type) {
      case 'heading':
        return { ...next, content: node.content?.length ? [{ type: 'text', text: ph.heading }] : undefined };
      case 'paragraph':
        return { ...next, content: node.content?.some((c) => c.type === 'text') ? [{ type: 'text', text: ph.text }] : undefined };
      case 'codeBlock':
        return { ...next, content: [{ type: 'text', text: ph.code }] };
      case 'faqItem':
        next.attrs = { ...next.attrs, question: ph.question };
        break;
      case 'testimonial':
        next.attrs = { ...next.attrs, name: ph.name, role: '' };
        break;
      case 'button':
        if (!isInternalHref(node.attrs?.href)) next.attrs = { ...next.attrs, href: '/~/' };
        break;
      case 'module': {
        const key = node.attrs?.module;
        if (isSiteModuleKey(key)) next.attrs = { module: key, config: normalizeModuleConfig(key, {}) };
        break;
      }
      case 'section':
        next.attrs = { ...next.attrs };
        break;
    }
    if (node.content) next.content = node.content.map(walk);
    return next;
  };
  return normalizeSiteDocument({ type: 'doc', content: doc.content.map(walk) });
}

// ─── Images ─────────────────────────────────────────────────────────────────

const ASSET_URL = /^\/s\/_\/a\/([a-z0-9]{20,32})\.(png|jpe?g|gif|webp|avif)$/;

/** Applique `map` à chaque adresse d'image du document (image, galerie, bannière, avatar, fond de section). */
export function mapDocumentImages(doc: SiteDocument, map: (url: string) => string): SiteDocument {
  const walk = (node: SiteNode): SiteNode => {
    const a = node.attrs;
    let attrs = a;
    if (a) {
      attrs = { ...a };
      for (const key of ['src', 'image', 'avatar', 'bgImage']) {
        if (typeof attrs[key] === 'string' && attrs[key]) attrs[key] = map(attrs[key] as string);
      }
      if (Array.isArray(a.images)) attrs.images = (a.images as Array<Record<string, unknown>>).map((img) => ({ ...img, src: typeof img.src === 'string' ? map(img.src) : img.src }));
    }
    return { ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.map(walk) } : {}) };
  };
  return { type: 'doc', content: doc.content.map(walk) };
}

/** Copie les images du site d'origine vers le site cible ; une image disparue est retirée. */
async function copyImages(pages: TemplatePageData[], target: { id: string; guildId: string }, userId: string): Promise<TemplatePageData[]> {
  const copies = new Map<string, string>();
  for (const page of pages) {
    mapDocumentImages(page.content, (url) => {
      if (ASSET_URL.test(url)) copies.set(url, '');
      return url;
    });
  }
  for (const url of copies.keys()) {
    const [, id, ext] = ASSET_URL.exec(url)!;
    const file = await readSiteAsset(id, ext).catch(() => null);
    if (!file) continue;
    const stored = await storeSiteAsset(target, { bytes: new Uint8Array(file.body), fileName: `modele-${id.slice(0, 8)}.${ext}`, uploadedById: userId }).catch(() => null);
    if (stored?.ok) copies.set(url, stored.asset.url);
  }
  // Images externes (https) gardées telles quelles ; images du site d'origine disparues : vidées.
  return pages.map((page) => ({ ...page, content: normalizeSiteDocument(mapDocumentImages(page.content, (url) => (ASSET_URL.test(url) ? (copies.get(url) ?? '') : url))) }));
}

// ─── Galerie ────────────────────────────────────────────────────────────────

export interface GalleryTemplate {
  id: string;
  official: boolean;
  name: string;
  description: string | null;
  category: string;
  lang: string;
  theme: string;
  themeSettings: unknown;
  /** Accueil du modèle, pour dessiner sa vignette. */
  home: SiteDocument | null;
  pageCount: number;
  uses: number;
  mine: boolean;
  createdAt: string | null;
}

async function guildLang(client: Client, guildId: string): Promise<Lang> {
  return (await resolveGuildLocale(guildId, client.guilds.cache.get(guildId)?.preferredLocale)) === 'en' ? 'en' : 'fr';
}

/** Tous les modules allumés : la vignette d'un modèle officiel montre tout ce qu'il sait faire. */
const ALL_MODULES_ON: Record<string, boolean> = new Proxy({}, { get: () => true });

function officialTemplates(lang: Lang): GalleryTemplate[] {
  return SITE_TEMPLATES.map((key) => {
    const blueprint = buildSiteBlueprint(key, lang, ALL_MODULES_ON);
    const home = blueprint.pages.find((p) => p.isHome);
    return {
      id: `${OFFICIAL_PREFIX}${key}`,
      official: true,
      name: key,
      description: blueprint.tagline,
      category: key,
      lang,
      theme: blueprint.theme,
      themeSettings: {},
      home: home ? home.content : null,
      pageCount: blueprint.pages.filter((p) => p.kind === 'PAGE').length,
      uses: 0,
      mine: false,
      createdAt: null,
    };
  });
}

export async function listGallery(client: Client, guildId: string, filter: { category?: string; q?: string } = {}): Promise<GalleryTemplate[]> {
  const lang = await guildLang(client, guildId);
  const q = foldSearchText(filter.q ?? '');
  const category = TEMPLATE_CATEGORIES.includes(filter.category as TemplateCategory) ? filter.category : undefined;
  const rows = await prisma.siteTemplate.findMany({
    where: { OR: [{ hidden: false }, { authorGuildId: guildId }], ...(category ? { category } : {}) },
    orderBy: [{ uses: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });
  const shared = rows.map((row): GalleryTemplate => {
    const pages = (Array.isArray(row.pages) ? row.pages : []) as unknown as TemplatePageData[];
    const home = pages.find((p) => p.isHome) ?? pages[0];
    return {
      id: row.id,
      official: false,
      name: row.name,
      description: row.description,
      category: row.category,
      lang: row.lang,
      theme: row.theme,
      themeSettings: row.themeSettings,
      home: home ? normalizeSiteDocument(home.content) : null,
      pageCount: pages.length,
      uses: row.uses,
      mine: row.authorGuildId === guildId,
      createdAt: row.createdAt.toISOString(),
    };
  });
  const officials = officialTemplates(lang).filter((t) => !category || t.category === category);
  return [...officials, ...shared].filter((t) => !q || foldSearchText(`${t.name} ${t.description ?? ''}`).includes(q));
}

export async function publishTemplate(client: Client, guildId: string, userId: string, input: { name?: unknown; description?: unknown; category?: unknown }) {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
  if (!name) throw new SiteAdminError('invalid_field', 400, 'name');
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 300) || null : null;
  const category = TEMPLATE_CATEGORIES.includes(input.category as TemplateCategory) ? (input.category as TemplateCategory) : 'autre';

  const site = await prisma.communitySite.findUnique({ where: { guildId } });
  if (!site) throw new SiteAdminError('site_missing', 404);
  if ((await prisma.siteTemplate.count({ where: { authorGuildId: guildId } })) >= MAX_TEMPLATES_PER_GUILD) throw new SiteAdminError('too_many_templates', 409);

  const lang = await guildLang(client, guildId);
  const rows = await prisma.sitePage.findMany({
    where: { siteId: site.id, kind: 'PAGE' },
    orderBy: { sortOrder: 'asc' },
    take: MAX_TEMPLATE_PAGES,
    select: { id: true, slug: true, title: true, draftContent: true, publishedContent: true },
  });
  if (rows.length === 0) throw new SiteAdminError('template_empty', 422);
  const navIds = new Set(collectNavPageIdsShallow(site.navigation));
  const pages: TemplatePageData[] = rows.map((row, index) => ({
    key: `p${index}`,
    title: row.title,
    slug: row.slug,
    // Version publiée de préférence : c'est le site que les visiteurs voient.
    content: toTemplateDocument(sectionizeSiteDocument(normalizeSiteDocument(row.publishedContent ?? row.draftContent)), lang),
    isHome: row.id === site.homePageId,
    inNav: navIds.has(row.id),
  }));
  const keyById = new Map(rows.map((row, index) => [row.id, `p${index}`]));
  const navigation: TemplateNavItem[] = [];
  for (const item of (Array.isArray(site.navigation) ? site.navigation : []) as unknown as SiteNavItem[]) {
    const target = item?.target as { type?: string; pageId?: string; section?: string } | undefined;
    if (target?.type === 'page' && target.pageId && keyById.has(target.pageId)) navigation.push({ label: String(item.label).slice(0, 40), pageKey: keyById.get(target.pageId) });
    else if (target?.type === 'section' && ['home', 'wiki', 'blog', 'search', 'me'].includes(String(target.section))) navigation.push({ label: String(item.label).slice(0, 40), section: target.section as TemplateNavItem['section'] });
  }

  return prisma.siteTemplate.create({
    data: {
      name,
      description,
      category,
      lang,
      authorGuildId: guildId,
      authorUserId: userId,
      sourceSiteId: site.id,
      theme: site.theme,
      themeSettings: normalizeSiteThemeSettings(site.themeSettings) as Prisma.InputJsonValue,
      navigation: navigation as unknown as Prisma.InputJsonValue,
      pages: pages as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, name: true },
  });
}

function collectNavPageIdsShallow(navigation: unknown): string[] {
  const ids: string[] = [];
  const visit = (items: unknown) => {
    for (const item of Array.isArray(items) ? items : []) {
      const target = (item as { target?: { type?: string; pageId?: string } })?.target;
      if (target?.type === 'page' && target.pageId) ids.push(target.pageId);
      visit((item as { children?: unknown })?.children);
    }
  };
  visit(navigation);
  return ids;
}

export async function deleteTemplate(guildId: string, templateId: string) {
  const result = await prisma.siteTemplate.deleteMany({ where: { id: templateId, authorGuildId: guildId } });
  if (result.count === 0) throw new SiteAdminError('template_missing', 404);
}

export async function reportTemplate(templateId: string, userId: string) {
  const row = await prisma.siteTemplate.findUnique({ where: { id: templateId }, select: { reporterIds: true } });
  if (!row) throw new SiteAdminError('template_missing', 404);
  if (row.reporterIds.includes(userId)) return;
  const reporters = [...row.reporterIds, userId];
  await prisma.siteTemplate.update({ where: { id: templateId }, data: { reporterIds: reporters, ...(reporters.length >= HIDE_AFTER_REPORTS ? { hidden: true } : {}) } });
}

/** Administration Kotbo : masquer ou rétablir un modèle partagé. */
export async function setTemplateHidden(templateId: string, hidden: boolean) {
  await prisma.siteTemplate.update({ where: { id: templateId }, data: { hidden, ...(hidden ? {} : { reporterIds: [] }) } });
}

export async function listReportedTemplates() {
  return prisma.siteTemplate.findMany({
    where: { OR: [{ hidden: true }, { NOT: { reporterIds: { isEmpty: true } } }] },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: { id: true, name: true, authorGuildId: true, hidden: true, reporterIds: true, uses: true, createdAt: true },
  });
}

// ─── Appliquer, annuler ─────────────────────────────────────────────────────

interface TemplateUndo {
  templateId: string;
  theme: string;
  themeSettings: unknown;
  navigation: unknown;
  homePageId: string | null;
  createdPageIds: string[];
  appliedAt: string;
}

async function resolveTemplate(client: Client, guildId: string, templateId: string, userId: string, target: { id: string; guildId: string }) {
  if (templateId.startsWith(OFFICIAL_PREFIX)) {
    const key = templateId.slice(OFFICIAL_PREFIX.length) as SiteTemplateKey;
    if (!(SITE_TEMPLATES as readonly string[]).includes(key)) throw new SiteAdminError('template_missing', 404);
    const blueprint = buildSiteBlueprint(key, await guildLang(client, guildId), await getModuleStates(guildId));
    const pages = blueprint.pages
      .filter((p) => p.kind === 'PAGE')
      .map((p): TemplatePageData => ({ key: p.key, title: p.title, slug: p.slug, content: sectionizeSiteDocument(p.content), isHome: Boolean(p.isHome), inNav: p.inNav }));
    const navigation: TemplateNavItem[] = blueprint.navigation.map((n) => (n.section ? { label: n.label, section: n.section } : { label: n.label, pageKey: n.pageKey }));
    return { theme: blueprint.theme, themeSettings: {}, pages, navigation, dbId: null as string | null };
  }
  const row = await prisma.siteTemplate.findFirst({ where: { id: templateId, OR: [{ hidden: false }, { authorGuildId: guildId }] } });
  if (!row) throw new SiteAdminError('template_missing', 404);
  const raw = (Array.isArray(row.pages) ? row.pages : []) as unknown as TemplatePageData[];
  const pages = await copyImages(
    raw.slice(0, MAX_TEMPLATE_PAGES).map((p, i) => ({
      key: typeof p.key === 'string' ? p.key : `p${i}`,
      title: String(p.title ?? '').slice(0, 140) || `Page ${i + 1}`,
      slug: String(p.slug ?? ''),
      content: normalizeSiteDocument(p.content),
      isHome: p.isHome === true,
      inNav: p.inNav === true,
    })),
    target,
    userId,
  );
  const navigation = ((Array.isArray(row.navigation) ? row.navigation : []) as unknown as TemplateNavItem[]).filter((n) => n && typeof n.label === 'string');
  return { theme: SITE_THEME_KEYS.includes(row.theme as never) ? row.theme : 'azur', themeSettings: normalizeSiteThemeSettings(row.themeSettings), pages, navigation, dbId: row.id };
}

export async function applyTemplate(client: Client, guildId: string, userId: string, templateId: string) {
  const site = await prisma.communitySite.findUnique({ where: { guildId } });
  if (!site) throw new SiteAdminError('site_missing', 404);
  const template = await resolveTemplate(client, guildId, templateId, userId, site);
  if (template.pages.length === 0) throw new SiteAdminError('template_empty', 422);

  const now = new Date();
  const pageIdByKey = new Map<string, string>();
  const createdPageIds: string[] = [];
  const last = await prisma.sitePage.findFirst({ where: { siteId: site.id, kind: 'PAGE' }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
  let sortOrder = (last?.sortOrder ?? 0) + 1;
  for (const page of template.pages) {
    const slug = await uniquePageSlug(site.id, 'PAGE', page.slug || page.title);
    const content = page.content as unknown as Prisma.InputJsonValue;
    // Publiées d'emblée : le menu du modèle pointe vers elles.
    const row = await prisma.sitePage.create({
      data: {
        siteId: site.id,
        guildId,
        kind: 'PAGE',
        slug,
        title: page.title,
        sortOrder: sortOrder++,
        draftContent: content,
        publishedContent: content,
        publishedTitle: page.title,
        publishedAt: now,
        firstPublishedAt: now,
        searchText: foldSearchText(`${page.title} ${extractSiteDocumentText(page.content)}`).slice(0, 200_000),
        authorId: userId,
        lastEditedById: userId,
      },
    });
    pageIdByKey.set(page.key, row.id);
    createdPageIds.push(row.id);
  }

  const homeKey = template.pages.find((p) => p.isHome)?.key ?? template.pages[0].key;
  const navigation: SiteNavItem[] = template.navigation
    .map((item, i): SiteNavItem | null => {
      if (item.section) return { id: `nav-${i}`, label: item.label, target: { type: 'section', section: item.section }, children: [] };
      const pageId = item.pageKey ? pageIdByKey.get(item.pageKey) : undefined;
      if (!pageId) return null;
      return { id: `nav-${i}`, label: item.label, target: item.pageKey === homeKey ? { type: 'section', section: 'home' } : { type: 'page', pageId }, children: [] };
    })
    .filter((item): item is SiteNavItem => item !== null);

  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const previous = settings.templateUndo as TemplateUndo | undefined;
  const undo: TemplateUndo = {
    templateId,
    // Deux modèles d'affilée : « Annuler » revient à l'état d'avant le premier.
    theme: previous?.theme ?? site.theme,
    themeSettings: previous?.themeSettings ?? site.themeSettings,
    navigation: previous?.navigation ?? site.navigation,
    homePageId: previous ? previous.homePageId : site.homePageId,
    createdPageIds: [...(previous?.createdPageIds ?? []), ...createdPageIds],
    appliedAt: now.toISOString(),
  };

  await prisma.communitySite.update({
    where: { id: site.id },
    data: {
      theme: template.theme,
      themeSettings: template.themeSettings as Prisma.InputJsonValue,
      navigation: navigation as unknown as Prisma.InputJsonValue,
      homePageId: pageIdByKey.get(homeKey) ?? site.homePageId,
      settings: { ...settings, templateId, templatePromptDismissed: true, templateUndo: undo } as unknown as Prisma.InputJsonValue,
    },
  });
  if (template.dbId) await prisma.siteTemplate.update({ where: { id: template.dbId }, data: { uses: { increment: 1 } } });
  await invalidateSiteCache(guildId, [site.slug]);
  return { pages: createdPageIds.length, homePageId: pageIdByKey.get(homeKey) ?? null };
}

export async function undoTemplate(guildId: string) {
  const site = await prisma.communitySite.findUnique({ where: { guildId } });
  if (!site) throw new SiteAdminError('site_missing', 404);
  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const undo = settings.templateUndo as TemplateUndo | undefined;
  if (!undo) throw new SiteAdminError('nothing_to_undo', 409);
  const { templateUndo: _undo, templateId: _id, ...rest } = settings;
  await prisma.$transaction([
    prisma.communitySite.update({
      where: { id: site.id },
      data: {
        theme: undo.theme,
        themeSettings: (undo.themeSettings ?? {}) as Prisma.InputJsonValue,
        navigation: (undo.navigation ?? []) as Prisma.InputJsonValue,
        homePageId: undo.homePageId,
        settings: rest as Prisma.InputJsonValue,
      },
    }),
    prisma.sitePage.deleteMany({ where: { siteId: site.id, id: { in: undo.createdPageIds } } }),
  ]);
  await invalidateSiteCache(guildId, [site.slug]);
}

/** L'annulation n'a plus de sens une fois le site retravaillé : « Garder » l'oublie. */
export async function keepTemplate(guildId: string) {
  const site = await prisma.communitySite.findUnique({ where: { guildId }, select: { id: true, settings: true } });
  if (!site) throw new SiteAdminError('site_missing', 404);
  const { templateUndo: _undo, ...rest } = (site.settings ?? {}) as Record<string, unknown>;
  await prisma.communitySite.update({ where: { id: site.id }, data: { settings: rest as Prisma.InputJsonValue } });
}

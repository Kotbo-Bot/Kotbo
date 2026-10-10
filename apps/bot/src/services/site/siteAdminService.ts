/**
 * Gestion d'un site communautaire : création, réglages, pages, publication,
 * révisions, commentaires, fiche staff, suspension.
 *
 * Chaque entrée est normalisée ici, jamais au niveau de la route : un réglage
 * qui atteint la base a déjà traversé la même liste blanche que le rendu.
 */

import { EmbedBuilder, type Client } from 'discord.js';
import { Prisma, type SitePageKind, type SiteVisibility } from '@prisma/client';
import {
  collectNavPageIds,
  extractSiteDocumentText,
  foldSearchText,
  canonicalSiteTheme,
  normalizeSiteDocument,
  normalizeSiteNavigation,
  normalizeSiteThemeSettings,
  sanitizeSiteCss,
  sanitizeSiteImageSrc,
  SITE_ASSET_PATH_PREFIX,
  SITE_CSS_MAX_LENGTH,
  slugify,
  validatePageSlug,
  validateSiteSlug,
  type SiteDocument,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getModuleStates } from '../core/moduleGate.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import { invalidateSiteCache } from './siteService.js';
import { findScamInDocument } from './siteModeration.js';
import { buildSiteBlueprint, blueprintNavigation, type SiteTemplateKey } from './siteTemplates.js';
import { readStaffPageSettings } from './blocks/vitrineBlocks.js';
import { afterCommentApproved } from './siteActivity.js';

export class SiteAdminError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly detail?: string,
  ) {
    super(code);
  }
}

const SNOWFLAKE = /^\d{17,20}$/;
const CUID = /^[a-z0-9]{20,32}$/;
const MAX_REVISIONS = 100;
const MAX_PAGES_PER_KIND = 2000;

// ─── Site ───────────────────────────────────────────────────────────────────

export async function getAdminSite(guildId: string) {
  return prisma.communitySite.findUnique({ where: { guildId } });
}

async function assertSlugFree(slug: string, siteId: string | null): Promise<void> {
  const error = validateSiteSlug(slug);
  if (error) throw new SiteAdminError(`slug_${error}`);
  const [taken, redirect] = await Promise.all([
    prisma.communitySite.findUnique({ where: { slug }, select: { id: true } }),
    prisma.siteSlugRedirect.findUnique({ where: { slug }, select: { siteId: true } }),
  ]);
  if (taken && taken.id !== siteId) throw new SiteAdminError('slug_taken', 409);
  // Un ancien slug d'un autre site reste à lui : ses liens partagés doivent continuer de marcher.
  if (redirect && redirect.siteId !== siteId) throw new SiteAdminError('slug_taken', 409);
}

/** Slug libre proposé à partir du nom du serveur. */
export async function suggestSiteSlug(name: string): Promise<string> {
  const base = slugify(name, 34) || 'communaute';
  const seed = /^\d+$/.test(base) || base.length < 3 ? `serveur-${base}`.slice(0, 34) : base;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? seed : `${seed}-${i + 1}`;
    if (validateSiteSlug(candidate)) continue;
    const [taken, redirect] = await Promise.all([
      prisma.communitySite.findUnique({ where: { slug: candidate }, select: { id: true } }),
      prisma.siteSlugRedirect.findUnique({ where: { slug: candidate }, select: { slug: true } }),
    ]);
    if (!taken && !redirect) return candidate;
  }
  return `${seed}-${Date.now().toString(36)}`.slice(0, 40);
}

export async function createSite(
  client: Client,
  guildId: string,
  userId: string,
  input: { slug: string; template: SiteTemplateKey },
) {
  if (await prisma.communitySite.findUnique({ where: { guildId }, select: { id: true } })) throw new SiteAdminError('site_exists', 409);
  const slug = input.slug.trim().toLowerCase();
  await assertSlugFree(slug, null);

  const guild = client.guilds.cache.get(guildId);
  const lang = (await resolveGuildLocale(guildId, guild?.preferredLocale)) === 'en' ? 'en' : 'fr';
  const blueprint = buildSiteBlueprint(input.template, lang, await getModuleStates(guildId));
  const now = new Date();

  const site = await prisma.$transaction(async (tx) => {
    const created = await tx.communitySite.create({
      data: { guildId, slug, theme: blueprint.theme, tagline: blueprint.tagline, createdById: userId },
    });
    const pageIdByKey = new Map<string, string>();
    let sortOrder = 0;
    for (const page of blueprint.pages) {
      const content = page.content as unknown as Prisma.InputJsonValue;
      const searchText = foldSearchText(`${page.title} ${extractSiteDocumentText(page.content)}`);
      const row = await tx.sitePage.create({
        data: {
          siteId: created.id,
          guildId,
          kind: page.kind,
          slug: page.slug,
          title: page.title,
          excerpt: page.excerpt ?? null,
          sortOrder: sortOrder++,
          draftContent: content,
          authorId: userId,
          lastEditedById: userId,
          hasUnpublishedChanges: !page.publish,
          ...(page.publish
            ? { publishedContent: content, publishedTitle: page.title, publishedAt: now, firstPublishedAt: now, searchText }
            : {}),
        },
      });
      pageIdByKey.set(page.key, row.id);
      if (page.publish) {
        await tx.sitePageRevision.create({ data: { pageId: row.id, guildId, title: page.title, content, authorId: userId, note: 'Modèle de départ' } });
      }
    }
    const homeId = pageIdByKey.get('home') ?? null;
    return tx.communitySite.update({
      where: { id: created.id },
      data: {
        homePageId: homeId,
        navigation: blueprintNavigation(blueprint, pageIdByKey) as unknown as Prisma.InputJsonValue,
      },
    });
  });
  await invalidateSiteCache(guildId, [slug]);
  return site;
}

export interface SitePatch {
  slug?: unknown;
  published?: unknown;
  name?: unknown;
  tagline?: unknown;
  logoUrl?: unknown;
  bannerUrl?: unknown;
  faviconUrl?: unknown;
  theme?: unknown;
  themeSettings?: unknown;
  customCss?: unknown;
  navigation?: unknown;
  homePageId?: unknown;
  staffPage?: unknown;
  settings?: unknown;
  wikiEditorRoleIds?: unknown;
  blogEditorRoleIds?: unknown;
  wikiAnnounceChannelId?: unknown;
  blogAnnounceChannelId?: unknown;
}

const optionalText = (value: unknown, max: number): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') throw new SiteAdminError('invalid_field');
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
};

const optionalImage = (value: unknown): string | null => {
  if (value === null || value === '') return null;
  const src = sanitizeSiteImageSrc(value);
  if (!src) throw new SiteAdminError('invalid_image');
  return src;
};

const snowflakes = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new SiteAdminError('invalid_field');
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && SNOWFLAKE.test(v)))].slice(0, 25);
};

const optionalChannel = (value: unknown): string | null => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw new SiteAdminError('invalid_field');
  return value;
};

/** Réglages libres du site : seules les clés connues passent. */
function normalizeSiteSettings(current: unknown, patch: unknown): Record<string, unknown> {
  const base = typeof current === 'object' && current !== null ? { ...(current as Record<string, unknown>) } : {};
  if (typeof patch !== 'object' || patch === null) return base;
  const p = patch as Record<string, unknown>;
  if (typeof p.commentsByDefault === 'boolean') base.commentsByDefault = p.commentsByDefault;
  if (typeof p.showMemberCount === 'boolean') base.showMemberCount = p.showMemberCount;
  return base;
}

export async function updateSite(guildId: string, patch: SitePatch) {
  const site = await prisma.communitySite.findUnique({ where: { guildId } });
  if (!site) throw new SiteAdminError('site_missing', 404);
  const data: Prisma.CommunitySiteUpdateInput = {};
  const oldSlug = site.slug;
  let newSlug: string | null = null;

  if (patch.slug !== undefined) {
    if (typeof patch.slug !== 'string') throw new SiteAdminError('invalid_field');
    const slug = patch.slug.trim().toLowerCase();
    if (slug !== site.slug) {
      await assertSlugFree(slug, site.id);
      newSlug = slug;
      data.slug = slug;
    }
  }
  if (patch.published !== undefined) {
    if (typeof patch.published !== 'boolean') throw new SiteAdminError('invalid_field');
    if (patch.published && site.suspendedAt) throw new SiteAdminError('site_suspended', 403);
    data.published = patch.published;
  }
  if (patch.name !== undefined) data.name = optionalText(patch.name, 60);
  if (patch.tagline !== undefined) data.tagline = optionalText(patch.tagline, 200);
  if (patch.logoUrl !== undefined) data.logoUrl = optionalImage(patch.logoUrl);
  if (patch.bannerUrl !== undefined) data.bannerUrl = optionalImage(patch.bannerUrl);
  if (patch.faviconUrl !== undefined) data.faviconUrl = optionalImage(patch.faviconUrl);
  if (patch.theme !== undefined) {
    // Les anciens noms (verre, clair…) restent acceptés et sont ramenés au thème actuel.
    const theme = canonicalSiteTheme(patch.theme);
    if (!theme) throw new SiteAdminError('invalid_theme');
    data.theme = theme;
  }
  if (patch.themeSettings !== undefined) data.themeSettings = normalizeSiteThemeSettings(patch.themeSettings) as Prisma.InputJsonValue;
  if (patch.customCss !== undefined) {
    if (patch.customCss !== null && typeof patch.customCss !== 'string') throw new SiteAdminError('invalid_field');
    if (typeof patch.customCss === 'string' && patch.customCss.length > SITE_CSS_MAX_LENGTH) throw new SiteAdminError('css_too_long');
    // Stocké filtré mais sans préfixe de portée : le propriétaire relit son propre CSS.
    data.customCss = patch.customCss ? sanitizeSiteCss(patch.customCss, SITE_ASSET_PATH_PREFIX) || null : null;
  }
  if (patch.navigation !== undefined) {
    const navigation = normalizeSiteNavigation(patch.navigation);
    const ids = collectNavPageIds(navigation);
    if (ids.length > 0) {
      const owned = await prisma.sitePage.count({ where: { siteId: site.id, id: { in: ids } } });
      if (owned !== new Set(ids).size) throw new SiteAdminError('invalid_navigation');
    }
    data.navigation = navigation as unknown as Prisma.InputJsonValue;
  }
  if (patch.homePageId !== undefined) {
    if (patch.homePageId === null) data.homePageId = null;
    else {
      const page = typeof patch.homePageId === 'string' && CUID.test(patch.homePageId)
        ? await prisma.sitePage.findFirst({ where: { id: patch.homePageId, siteId: site.id, kind: 'PAGE' }, select: { id: true } })
        : null;
      if (!page) throw new SiteAdminError('invalid_home');
      data.homePageId = page.id;
    }
  }
  if (patch.staffPage !== undefined) data.staffPage = readStaffPageSettings(patch.staffPage) as unknown as Prisma.InputJsonValue;
  if (patch.settings !== undefined) data.settings = normalizeSiteSettings(site.settings, patch.settings) as Prisma.InputJsonValue;
  if (patch.wikiEditorRoleIds !== undefined) data.wikiEditorRoleIds = snowflakes(patch.wikiEditorRoleIds);
  if (patch.blogEditorRoleIds !== undefined) data.blogEditorRoleIds = snowflakes(patch.blogEditorRoleIds);
  if (patch.wikiAnnounceChannelId !== undefined) data.wikiAnnounceChannelId = optionalChannel(patch.wikiAnnounceChannelId);
  if (patch.blogAnnounceChannelId !== undefined) data.blogAnnounceChannelId = optionalChannel(patch.blogAnnounceChannelId);

  const updated = await prisma.$transaction(async (tx) => {
    if (newSlug) {
      // L'ancien slug redirige ; s'il redevient le slug courant, sa redirection saute.
      await tx.siteSlugRedirect.deleteMany({ where: { slug: newSlug } });
      await tx.siteSlugRedirect.upsert({ where: { slug: oldSlug }, create: { slug: oldSlug, siteId: site.id }, update: { siteId: site.id } });
    }
    return tx.communitySite.update({ where: { id: site.id }, data });
  });
  await invalidateSiteCache(guildId, [oldSlug, ...(newSlug ? [newSlug] : [])]);
  return updated;
}

export async function deleteSite(guildId: string): Promise<void> {
  const site = await prisma.communitySite.findUnique({ where: { guildId }, select: { slug: true, id: true } });
  if (!site) return;
  const redirects = await prisma.siteSlugRedirect.findMany({ where: { siteId: site.id }, select: { slug: true } });
  await prisma.communitySite.delete({ where: { guildId } });
  await invalidateSiteCache(guildId, [site.slug, ...redirects.map((r) => r.slug)]);
}

// ─── Pages ──────────────────────────────────────────────────────────────────

export const PAGE_LIST_SELECT = {
  id: true,
  kind: true,
  slug: true,
  title: true,
  parentId: true,
  sortOrder: true,
  tags: true,
  visibility: true,
  publishedAt: true,
  firstPublishedAt: true,
  scheduledAt: true,
  hasUnpublishedChanges: true,
  archivedAt: true,
  authorId: true,
  lastEditedById: true,
  updatedAt: true,
} as const;

export async function listAdminPages(siteId: string, kinds?: SitePageKind[]) {
  return prisma.sitePage.findMany({
    where: { siteId, ...(kinds ? { kind: { in: kinds } } : {}) },
    select: PAGE_LIST_SELECT,
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    take: MAX_PAGES_PER_KIND * 3,
  });
}

export async function getAdminPage(siteId: string, pageId: string) {
  if (!CUID.test(pageId)) return null;
  return prisma.sitePage.findFirst({
    where: { id: pageId, siteId },
    select: {
      ...PAGE_LIST_SELECT,
      excerpt: true,
      coverUrl: true,
      icon: true,
      visibleRoleIds: true,
      draftContent: true,
      publishedTitle: true,
      commentsEnabled: true,
      seoTitle: true,
      seoDescription: true,
    },
  });
}

async function uniquePageSlug(siteId: string, kind: SitePageKind, wanted: string, exceptId: string | null = null): Promise<string> {
  const base = slugify(wanted, 70) || 'page';
  const seed = validatePageSlug(base) === 'reserved' ? `${base}-page` : base;
  for (let i = 0; i < 200; i++) {
    const candidate = i === 0 ? seed : `${seed}-${i + 1}`;
    const taken = await prisma.sitePage.findFirst({ where: { siteId, kind, slug: candidate, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${seed}-${Date.now().toString(36)}`;
}

/** Le nouveau parent n'est-il pas un descendant de la page (ce qui créerait une boucle) ? */
async function assertWikiParent(siteId: string, pageId: string | null, parentId: string | null): Promise<void> {
  if (!parentId) return;
  const parent = await prisma.sitePage.findFirst({ where: { id: parentId, siteId, kind: 'WIKI' }, select: { id: true, parentId: true } });
  if (!parent) throw new SiteAdminError('invalid_parent');
  let cursor: string | null = parent.id;
  for (let depth = 0; cursor && depth < 20; depth++) {
    if (cursor === pageId) throw new SiteAdminError('parent_cycle');
    const next: { parentId: string | null } | null = await prisma.sitePage.findUnique({ where: { id: cursor }, select: { parentId: true } });
    cursor = next?.parentId ?? null;
  }
}

export async function createPage(
  site: { id: string; guildId: string; settings: unknown },
  userId: string,
  input: { kind: unknown; title: unknown; slug?: unknown; parentId?: unknown; content?: unknown },
) {
  const kind = input.kind === 'WIKI' || input.kind === 'BLOG' ? input.kind : 'PAGE';
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 140) : '';
  if (!title) throw new SiteAdminError('title_required');
  const count = await prisma.sitePage.count({ where: { siteId: site.id, kind } });
  if (count >= MAX_PAGES_PER_KIND) throw new SiteAdminError('too_many_pages', 409);
  const parentId = kind === 'WIKI' && typeof input.parentId === 'string' && CUID.test(input.parentId) ? input.parentId : null;
  await assertWikiParent(site.id, null, parentId);
  const slug = await uniquePageSlug(site.id, kind, typeof input.slug === 'string' && input.slug.trim() ? input.slug : title);
  const content = normalizeSiteDocument(input.content ?? { type: 'doc', content: [] });
  const settings = (site.settings ?? {}) as Record<string, unknown>;
  const last = await prisma.sitePage.findFirst({ where: { siteId: site.id, kind, parentId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
  return prisma.sitePage.create({
    data: {
      siteId: site.id,
      guildId: site.guildId,
      kind,
      slug,
      title,
      parentId,
      sortOrder: (last?.sortOrder ?? -1) + 1,
      draftContent: content as unknown as Prisma.InputJsonValue,
      commentsEnabled: kind === 'BLOG' ? settings.commentsByDefault !== false : false,
      authorId: userId,
      lastEditedById: userId,
    },
    select: { id: true, kind: true, slug: true, title: true },
  });
}

export interface PagePatch {
  title?: unknown;
  slug?: unknown;
  excerpt?: unknown;
  coverUrl?: unknown;
  icon?: unknown;
  tags?: unknown;
  visibility?: unknown;
  visibleRoleIds?: unknown;
  commentsEnabled?: unknown;
  seoTitle?: unknown;
  seoDescription?: unknown;
  parentId?: unknown;
  draftContent?: unknown;
}

const VISIBILITIES: SiteVisibility[] = ['PUBLIC', 'MEMBERS', 'ROLES', 'STAFF'];

export async function updatePage(site: { id: string; guildId: string }, pageId: string, patch: PagePatch, userId: string) {
  const page = await prisma.sitePage.findFirst({ where: { id: pageId, siteId: site.id }, select: { id: true, kind: true, slug: true } });
  if (!page) throw new SiteAdminError('page_missing', 404);
  const data: Prisma.SitePageUpdateInput = {};
  let structural = false;

  if (patch.title !== undefined) {
    const title = typeof patch.title === 'string' ? patch.title.trim().slice(0, 140) : '';
    if (!title) throw new SiteAdminError('title_required');
    data.title = title;
  }
  if (patch.slug !== undefined) {
    if (typeof patch.slug !== 'string') throw new SiteAdminError('invalid_field');
    const wanted = patch.slug.trim().toLowerCase();
    if (wanted !== page.slug) {
      const error = validatePageSlug(wanted);
      if (error) throw new SiteAdminError(`slug_${error}`);
      const taken = await prisma.sitePage.findFirst({ where: { siteId: site.id, kind: page.kind, slug: wanted, id: { not: page.id } }, select: { id: true } });
      if (taken) throw new SiteAdminError('slug_taken', 409);
      data.slug = wanted;
      structural = true;
    }
  }
  if (patch.excerpt !== undefined) data.excerpt = optionalText(patch.excerpt, 400);
  if (patch.coverUrl !== undefined) data.coverUrl = optionalImage(patch.coverUrl);
  if (patch.icon !== undefined) data.icon = optionalText(patch.icon, 16);
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags)) throw new SiteAdminError('invalid_field');
    data.tags = [...new Set(patch.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 30)).filter(Boolean))].slice(0, 10);
  }
  if (patch.visibility !== undefined) {
    if (!VISIBILITIES.includes(patch.visibility as SiteVisibility)) throw new SiteAdminError('invalid_field');
    data.visibility = patch.visibility as SiteVisibility;
    structural = true;
  }
  if (patch.visibleRoleIds !== undefined) data.visibleRoleIds = snowflakes(patch.visibleRoleIds);
  if (patch.commentsEnabled !== undefined) data.commentsEnabled = patch.commentsEnabled === true;
  if (patch.seoTitle !== undefined) data.seoTitle = optionalText(patch.seoTitle, 70);
  if (patch.seoDescription !== undefined) data.seoDescription = optionalText(patch.seoDescription, 200);
  if (patch.parentId !== undefined && page.kind === 'WIKI') {
    const parentId = typeof patch.parentId === 'string' && CUID.test(patch.parentId) ? patch.parentId : null;
    await assertWikiParent(site.id, page.id, parentId);
    data.parent = parentId ? { connect: { id: parentId } } : { disconnect: true };
    structural = true;
  }
  if (patch.draftContent !== undefined) {
    data.draftContent = normalizeSiteDocument(patch.draftContent) as unknown as Prisma.InputJsonValue;
    data.hasUnpublishedChanges = true;
    // Brouillon réécrit hors de la session à plusieurs : l'état Yjs enregistré
    // ne lui correspond plus, la prochaine session repartira du brouillon.
    data.collabState = null;
  }
  if (data.title !== undefined) data.hasUnpublishedChanges = true;
  data.lastEditedById = userId;

  const updated = await prisma.sitePage.update({ where: { id: page.id }, data, select: { id: true, slug: true, title: true, updatedAt: true, hasUnpublishedChanges: true } });
  // Adresse, visibilité ou place dans l'arbre : le menu et les index publics changent tout de suite.
  if (structural) await invalidateSiteCache(site.guildId);
  return updated;
}

export async function deletePage(site: { id: string; guildId: string; homePageId: string | null }, pageId: string): Promise<void> {
  const page = await prisma.sitePage.findFirst({ where: { id: pageId, siteId: site.id }, select: { id: true, parentId: true } });
  if (!page) throw new SiteAdminError('page_missing', 404);
  await prisma.$transaction([
    // Les sous-pages remontent d'un cran plutôt que de devenir orphelines.
    prisma.sitePage.updateMany({ where: { parentId: page.id }, data: { parentId: page.parentId } }),
    ...(site.homePageId === page.id ? [prisma.communitySite.update({ where: { id: site.id }, data: { homePageId: null } })] : []),
    prisma.sitePage.delete({ where: { id: page.id } }),
  ]);
  await invalidateSiteCache(site.guildId);
}

export async function reorderPages(siteId: string, guildId: string, orderedIds: unknown): Promise<void> {
  if (!Array.isArray(orderedIds)) throw new SiteAdminError('invalid_field');
  const ids = orderedIds.filter((id): id is string => typeof id === 'string' && CUID.test(id)).slice(0, 500);
  const owned = await prisma.sitePage.count({ where: { siteId, id: { in: ids } } });
  if (owned !== ids.length) throw new SiteAdminError('invalid_field');
  await prisma.$transaction(ids.map((id, index) => prisma.sitePage.update({ where: { id }, data: { sortOrder: index } })));
  await invalidateSiteCache(guildId);
}

// ─── Publication ────────────────────────────────────────────────────────────

/** Résumé automatique d'un article sans résumé : les 220 premiers caractères. */
function autoExcerpt(doc: SiteDocument): string | null {
  const text = extractSiteDocumentText(doc, 2000);
  if (!text) return null;
  return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text;
}

export async function publishPage(client: Client, guildId: string, pageId: string, userId: string, note?: string | null) {
  const page = await prisma.sitePage.findFirst({
    where: { id: pageId, guildId },
    select: { id: true, siteId: true, kind: true, slug: true, title: true, tags: true, excerpt: true, draftContent: true, firstPublishedAt: true, visibility: true },
  });
  if (!page) throw new SiteAdminError('page_missing', 404);
  const doc = normalizeSiteDocument(page.draftContent);
  const scam = await findScamInDocument(guildId, doc);
  if (scam) throw new SiteAdminError('scam_link', 422, scam);

  const content = doc as unknown as Prisma.InputJsonValue;
  const now = new Date();
  const searchText = foldSearchText(`${page.title} ${page.tags.join(' ')} ${extractSiteDocumentText(doc)}`).slice(0, 200_000);
  const isFirst = !page.firstPublishedAt;

  const [published] = await prisma.$transaction([
    prisma.sitePage.update({
      where: { id: page.id },
      data: {
        publishedContent: content,
        publishedTitle: page.title,
        publishedAt: now,
        firstPublishedAt: page.firstPublishedAt ?? now,
        scheduledAt: null,
        archivedAt: null,
        hasUnpublishedChanges: false,
        searchText,
        ...(page.kind === 'BLOG' && !page.excerpt ? { excerpt: autoExcerpt(doc) } : {}),
      },
      select: { id: true, publishedAt: true, slug: true },
    }),
    prisma.sitePageRevision.create({ data: { pageId: page.id, guildId, title: page.title, content, authorId: userId, note: note?.slice(0, 200) ?? null } }),
  ]);

  // Historique borné : les plus anciennes révisions au-delà de la limite partent.
  const stale = await prisma.sitePageRevision.findMany({ where: { pageId: page.id }, orderBy: { createdAt: 'desc' }, skip: MAX_REVISIONS, select: { id: true } });
  if (stale.length > 0) await prisma.sitePageRevision.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });

  await invalidateSiteCache(guildId);
  if (page.visibility === 'PUBLIC' && (page.kind === 'WIKI' || page.kind === 'BLOG')) {
    void announcePublication(client, guildId, page.siteId, page.id, isFirst).catch((err) => logger.warn('Site', `Annonce de publication impossible sur ${guildId} :`, err));
  }
  return published;
}

export async function unpublishPage(guildId: string, pageId: string): Promise<void> {
  const page = await prisma.sitePage.findFirst({ where: { id: pageId, guildId }, select: { id: true } });
  if (!page) throw new SiteAdminError('page_missing', 404);
  await prisma.sitePage.update({ where: { id: page.id }, data: { publishedAt: null, publishedContent: Prisma.DbNull, searchText: '', hasUnpublishedChanges: true } });
  await invalidateSiteCache(guildId);
}

export async function schedulePage(guildId: string, pageId: string, at: unknown): Promise<Date | null> {
  const page = await prisma.sitePage.findFirst({ where: { id: pageId, guildId }, select: { id: true } });
  if (!page) throw new SiteAdminError('page_missing', 404);
  let when: Date | null = null;
  if (at !== null) {
    when = typeof at === 'string' ? new Date(at) : null;
    if (!when || Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) throw new SiteAdminError('invalid_date');
    if (when.getTime() > Date.now() + 366 * 24 * 3600 * 1000) throw new SiteAdminError('invalid_date');
  }
  await prisma.sitePage.update({ where: { id: page.id }, data: { scheduledAt: when } });
  return when;
}

/** Publications programmées arrivées à échéance (tâche planifiée, chaque minute). */
export async function publishDuePages(client: Client): Promise<number> {
  const due = await prisma.sitePage.findMany({
    where: { scheduledAt: { lte: new Date() } },
    select: { id: true, guildId: true, lastEditedById: true, authorId: true },
    take: 50,
  });
  let done = 0;
  for (const page of due) {
    try {
      await publishPage(client, page.guildId, page.id, page.lastEditedById ?? page.authorId, 'Publication programmée');
      done += 1;
    } catch (err) {
      // Une publication bloquée (lien d'arnaque…) ne doit pas repasser chaque minute.
      await prisma.sitePage.update({ where: { id: page.id }, data: { scheduledAt: null } }).catch(() => null);
      logger.warn('Site', `Publication programmée de ${page.id} impossible :`, err);
    }
  }
  return done;
}

export async function listRevisions(guildId: string, pageId: string) {
  return prisma.sitePageRevision.findMany({
    where: { pageId, guildId },
    orderBy: { createdAt: 'desc' },
    take: MAX_REVISIONS,
    select: { id: true, title: true, authorId: true, note: true, createdAt: true },
  });
}

export async function getRevision(guildId: string, pageId: string, revisionId: string) {
  return prisma.sitePageRevision.findFirst({ where: { id: revisionId, pageId, guildId }, select: { id: true, title: true, content: true, createdAt: true, authorId: true } });
}

/** Une révision redevient le brouillon ; la version publiée ne bouge qu'à la publication suivante. */
export async function restoreRevision(guildId: string, pageId: string, revisionId: string, userId: string) {
  const revision = await getRevision(guildId, pageId, revisionId);
  if (!revision) throw new SiteAdminError('revision_missing', 404);
  return prisma.sitePage.update({
    where: { id: pageId },
    data: { draftContent: revision.content as Prisma.InputJsonValue, title: revision.title, hasUnpublishedChanges: true, lastEditedById: userId, collabState: null },
    select: { id: true, title: true, draftContent: true },
  });
}

async function announcePublication(client: Client, guildId: string, siteId: string, pageId: string, isFirst: boolean): Promise<void> {
  const [site, page] = await Promise.all([
    prisma.communitySite.findUnique({ where: { id: siteId }, select: { slug: true, published: true, wikiAnnounceChannelId: true, blogAnnounceChannelId: true } }),
    prisma.sitePage.findUnique({ where: { id: pageId }, select: { kind: true, slug: true, publishedTitle: true, excerpt: true, coverUrl: true } }),
  ]);
  if (!site?.published || !page) return;
  const channelId = page.kind === 'WIKI' ? site.wikiAnnounceChannelId : site.blogAnnounceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return;
  const { getDashboardUrl } = await import('../../api/shared.js');
  const url = `${getDashboardUrl().replace(/\/$/, '')}/s/${site.slug}/${page.kind === 'WIKI' ? 'wiki' : 'blog'}/${page.slug}`;
  const locale = await resolveGuildLocale(guildId);
  const label =
    page.kind === 'WIKI'
      ? isFirst ? (locale === 'en' ? 'New wiki page' : 'Nouvelle page du wiki') : locale === 'en' ? 'Wiki page updated' : 'Page du wiki mise à jour'
      : locale === 'en' ? 'New article' : 'Nouvel article';
  // Un article republié après correction n'est pas réannoncé.
  if (page.kind === 'BLOG' && !isFirst) return;
  const embed = new EmbedBuilder()
    .setAuthor({ name: label })
    .setTitle((page.publishedTitle ?? page.slug).slice(0, 256))
    .setURL(url)
    .setColor(0x5865f2);
  if (page.excerpt) embed.setDescription(page.excerpt.slice(0, 400));
  if (page.coverUrl?.startsWith('https://')) embed.setImage(page.coverUrl);
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

// ─── Commentaires ───────────────────────────────────────────────────────────

export async function listComments(guildId: string, status: unknown) {
  const filter = status === 'PENDING' || status === 'HIDDEN' || status === 'VISIBLE' ? status : undefined;
  return prisma.siteComment.findMany({
    where: { guildId, ...(filter ? { status: filter } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, pageId: true, authorId: true, authorName: true, authorAvatar: true, content: true, status: true, moderationReason: true, createdAt: true, page: { select: { title: true, slug: true } } },
  });
}

export async function setCommentStatus(guildId: string, commentId: string, status: unknown): Promise<void> {
  if (status !== 'VISIBLE' && status !== 'HIDDEN') throw new SiteAdminError('invalid_field');
  const previous = await prisma.siteComment.findFirst({ where: { id: commentId, guildId }, select: { status: true } });
  if (!previous) throw new SiteAdminError('comment_missing', 404);
  await prisma.siteComment.update({ where: { id: commentId }, data: { status } });
  // Retenu par la modération puis affiché : récompense, MP à l'auteur et à celui de l'article.
  if (previous.status === 'PENDING' && status === 'VISIBLE') afterCommentApproved(commentId);
}

export async function deleteComment(guildId: string, commentId: string): Promise<void> {
  await prisma.siteComment.deleteMany({ where: { id: commentId, guildId } });
}

// ─── Fiche staff (réglée par chaque membre du staff) ────────────────────────

export async function getStaffProfile(guildId: string, userId: string) {
  const [profile, staff] = await Promise.all([
    prisma.siteStaffProfile.findUnique({ where: { guildId_userId: { guildId, userId } } }),
    prisma.staffMember.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { id: true } }),
  ]);
  return { isStaff: Boolean(staff), bio: profile?.bio ?? '', hidden: profile?.hidden ?? false };
}

export async function updateStaffProfile(guildId: string, userId: string, input: { bio?: unknown; hidden?: unknown }) {
  const staff = await prisma.staffMember.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { id: true } });
  if (!staff) throw new SiteAdminError('not_staff', 403);
  const bio = typeof input.bio === 'string' ? input.bio.trim().slice(0, 400) || null : undefined;
  const hidden = typeof input.hidden === 'boolean' ? input.hidden : undefined;
  const profile = await prisma.siteStaffProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, bio: bio ?? null, hidden: hidden ?? false },
    update: { ...(bio !== undefined ? { bio } : {}), ...(hidden !== undefined ? { hidden } : {}) },
  });
  const { cache } = await import('../../utils/cache.js');
  await cache.delete(`guild:${guildId}:site-staff`);
  return { bio: profile.bio ?? '', hidden: profile.hidden };
}

// ─── Administration Kotbo ───────────────────────────────────────────────────

export async function suspendSite(siteId: string, adminId: string, reason: string | null) {
  const site = await prisma.communitySite.update({
    where: { id: siteId },
    data: { suspendedAt: new Date(), suspendedById: adminId, suspendedReason: reason?.slice(0, 500) ?? null, published: false },
    select: { guildId: true, slug: true },
  });
  await invalidateSiteCache(site.guildId, [site.slug]);
  return site;
}

export async function unsuspendSite(siteId: string) {
  const site = await prisma.communitySite.update({
    where: { id: siteId },
    data: { suspendedAt: null, suspendedById: null, suspendedReason: null },
    select: { guildId: true, slug: true },
  });
  await invalidateSiteCache(site.guildId, [site.slug]);
  return site;
}

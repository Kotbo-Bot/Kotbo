/**
 * Lecture des sites communautaires : site par slug, pages publiées, visiteur.
 *
 * Le rendu public passe ici à chaque requête : les lectures sont en cache
 * court, sous le préfixe `guild:<id>:` pour que `cache.invalidateGuild` (que
 * toutes les écritures du dashboard déclenchent) les emporte. Le passage
 * slug → serveur a sa propre clé, purgée par `invalidateSiteCache`.
 */

import type { Client } from 'discord.js';
import type { CommunitySite, SitePage, SitePageKind, SiteVisibility } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { resolveDashboardAccess } from '../../api/shared.js';

const SITE_TTL_SECONDS = 30;
const SLUG_TTL_SECONDS = 300;

export type SiteRecord = Pick<
  CommunitySite,
  | 'id'
  | 'guildId'
  | 'slug'
  | 'published'
  | 'name'
  | 'tagline'
  | 'logoUrl'
  | 'bannerUrl'
  | 'faviconUrl'
  | 'theme'
  | 'themeSettings'
  | 'customCss'
  | 'navigation'
  | 'homePageId'
  | 'staffPage'
  | 'settings'
  | 'rewards'
  | 'wikiEditorRoleIds'
  | 'blogEditorRoleIds'
  | 'suspendedAt'
  | 'updatedAt'
>;

export const SITE_SELECT = {
  id: true,
  guildId: true,
  slug: true,
  published: true,
  name: true,
  tagline: true,
  logoUrl: true,
  bannerUrl: true,
  faviconUrl: true,
  theme: true,
  themeSettings: true,
  customCss: true,
  navigation: true,
  homePageId: true,
  staffPage: true,
  settings: true,
  rewards: true,
  wikiEditorRoleIds: true,
  blogEditorRoleIds: true,
  suspendedAt: true,
  updatedAt: true,
} as const;

/** Page telle que le rendu public la lit : jamais le brouillon ni l'état Yjs. */
export type PublishedPage = Pick<
  SitePage,
  | 'id'
  | 'kind'
  | 'slug'
  | 'parentId'
  | 'sortOrder'
  | 'tags'
  | 'visibility'
  | 'visibleRoleIds'
  | 'publishedContent'
  | 'publishedTitle'
  | 'publishedAt'
  | 'firstPublishedAt'
  | 'excerpt'
  | 'coverUrl'
  | 'icon'
  | 'commentsEnabled'
  | 'seoTitle'
  | 'seoDescription'
  | 'authorId'
  | 'searchText'
>;

export const PUBLISHED_PAGE_SELECT = {
  id: true,
  kind: true,
  slug: true,
  parentId: true,
  sortOrder: true,
  tags: true,
  visibility: true,
  visibleRoleIds: true,
  publishedContent: true,
  publishedTitle: true,
  publishedAt: true,
  firstPublishedAt: true,
  excerpt: true,
  coverUrl: true,
  icon: true,
  commentsEnabled: true,
  seoTitle: true,
  seoDescription: true,
  authorId: true,
  searchText: true,
} as const;

/** Entrée d'un index (menu, wiki, liste d'articles) : sans le contenu. */
export type PageSummary = Omit<PublishedPage, 'publishedContent' | 'searchText'>;

const SUMMARY_SELECT = { ...PUBLISHED_PAGE_SELECT, publishedContent: false, searchText: false } as const;

const siteKey = (guildId: string) => `guild:${guildId}:site`;
const slugKey = (slug: string) => `site-slug:${slug}`;
const pagesKey = (guildId: string, kind: SitePageKind) => `guild:${guildId}:site-pages:${kind}`;

/**
 * Le cache passe par Redis en JSON : les dates en ressortent en chaînes. Elles
 * sont reconverties ici, une fois, plutôt qu'à chaque lecture.
 */
function reviveDates<T extends object>(row: T, fields: ReadonlyArray<keyof T>): T {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string') (row as Record<keyof T, unknown>)[field] = new Date(value);
  }
  return row;
}

export async function getSiteByGuild(guildId: string): Promise<SiteRecord | null> {
  const site = await cache.wrap(siteKey(guildId), SITE_TTL_SECONDS, () =>
    prisma.communitySite.findUnique({ where: { guildId }, select: SITE_SELECT }),
  );
  return site ? reviveDates(site, ['updatedAt', 'suspendedAt']) : null;
}

export type SiteLookup =
  | { kind: 'site'; site: SiteRecord }
  | { kind: 'redirect'; slug: string }
  | { kind: 'missing' };

/**
 * Site désigné par le premier segment de `/s/<segment>` : son slug, un ancien
 * slug (redirection), ou l'identifiant Discord du serveur (redirection).
 */
export async function lookupSite(segment: string): Promise<SiteLookup> {
  const value = segment.toLowerCase();
  if (/^\d{17,20}$/.test(value)) {
    const site = await getSiteByGuild(value);
    return site ? { kind: 'redirect', slug: site.slug } : { kind: 'missing' };
  }
  if (!/^[a-z0-9-]{3,40}$/.test(value)) return { kind: 'missing' };

  const target = await cache.wrap(slugKey(value), SLUG_TTL_SECONDS, async () => {
    const site = await prisma.communitySite.findUnique({ where: { slug: value }, select: { guildId: true } });
    if (site) return { guildId: site.guildId, redirect: null as string | null };
    const old = await prisma.siteSlugRedirect.findUnique({ where: { slug: value }, select: { site: { select: { slug: true } } } });
    return old ? { guildId: null, redirect: old.site.slug } : null;
  });
  if (!target) return { kind: 'missing' };
  if (target.redirect) return { kind: 'redirect', slug: target.redirect };
  const site = target.guildId ? await getSiteByGuild(target.guildId) : null;
  // Slug pris entre-temps par un autre site, ou site supprimé : le cache ment.
  if (!site || site.slug !== value) {
    await cache.delete(slugKey(value));
    return { kind: 'missing' };
  }
  return { kind: 'site', site };
}

/** Site désigné par son identifiant (API du script du site). */
export async function getSiteById(siteId: string): Promise<SiteRecord | null> {
  if (!/^[a-z0-9]{20,32}$/.test(siteId)) return null;
  const guildId = await cache.wrap(`site-id:${siteId}`, SLUG_TTL_SECONDS, async () => {
    const row = await prisma.communitySite.findUnique({ where: { id: siteId }, select: { guildId: true } });
    return row?.guildId ?? null;
  });
  if (!guildId) return null;
  const site = await getSiteByGuild(guildId);
  return site?.id === siteId ? site : null;
}

export async function invalidateSiteCache(guildId: string, slugs: string[] = []): Promise<void> {
  await Promise.all([
    cache.delete(siteKey(guildId)),
    cache.delete(pagesKey(guildId, 'PAGE')),
    cache.delete(pagesKey(guildId, 'WIKI')),
    cache.delete(pagesKey(guildId, 'BLOG')),
    ...slugs.map((slug) => cache.delete(slugKey(slug))),
  ]);
}

/** Pages publiées d'un type, sans contenu : menu, sommaire du wiki, listes. */
export async function listPublishedPages(site: Pick<SiteRecord, 'id' | 'guildId'>, kind: SitePageKind): Promise<PageSummary[]> {
  const pages = await cache.wrap(pagesKey(site.guildId, kind), SITE_TTL_SECONDS, () =>
    prisma.sitePage.findMany({
      where: { siteId: site.id, kind, publishedAt: { not: null }, archivedAt: null },
      select: SUMMARY_SELECT,
      orderBy: kind === 'BLOG' ? [{ firstPublishedAt: 'desc' }] : [{ sortOrder: 'asc' }, { publishedTitle: 'asc' }],
      take: 2000,
    }),
  );
  return pages.map((page) => reviveDates(page, ['publishedAt', 'firstPublishedAt']));
}

export async function getPublishedPage(siteId: string, kind: SitePageKind, slug: string): Promise<PublishedPage | null> {
  return prisma.sitePage.findFirst({
    where: { siteId, kind, slug, publishedAt: { not: null }, archivedAt: null },
    select: PUBLISHED_PAGE_SELECT,
  });
}

export async function getPublishedPageById(siteId: string, pageId: string): Promise<PublishedPage | null> {
  return prisma.sitePage.findFirst({
    where: { id: pageId, siteId, publishedAt: { not: null }, archivedAt: null },
    select: PUBLISHED_PAGE_SELECT,
  });
}

// ─── Visiteur ───────────────────────────────────────────────────────────────

export interface SiteViewer {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isMember: boolean;
  roleIds: string[];
  /** Accès au dashboard du serveur (staff, modérateurs, admins). */
  isStaff: boolean;
  canManageSite: boolean;
}

/**
 * Ce que le site sait d'un utilisateur connecté, pour un serveur donné. Le
 * membre est relu depuis Discord (cache du client, sinon requête) : un rôle
 * retiré coupe l'accès dès que le cache du membre expire.
 */
export async function resolveSiteViewer(client: Client, guildId: string, userId: string): Promise<SiteViewer> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
  const user = member?.user ?? (await client.users.fetch(userId).catch(() => null));
  const access = await resolveDashboardAccess(client, guildId, userId).catch(() => null);
  return {
    userId,
    username: user?.username ?? userId,
    displayName: member?.displayName ?? user?.globalName ?? user?.username ?? userId,
    avatarUrl: (member ?? user)?.displayAvatarURL({ size: 128 }) ?? null,
    isMember: Boolean(member),
    roleIds: member ? [...member.roles.cache.keys()] : [],
    isStaff: Boolean(access?.canViewDashboard),
    canManageSite: Boolean(access?.canManageSettings),
  };
}

export type PageAccess = 'allowed' | 'login' | 'denied';

/** Une page se voit-elle, et sinon, une connexion y changerait-elle quelque chose ? */
export function checkPageAccess(
  page: { visibility: SiteVisibility; visibleRoleIds: string[] },
  viewer: SiteViewer | null,
): PageAccess {
  if (page.visibility === 'PUBLIC') return 'allowed';
  if (!viewer) return 'login';
  if (viewer.isStaff) return 'allowed';
  switch (page.visibility) {
    case 'MEMBERS':
      return viewer.isMember ? 'allowed' : 'denied';
    case 'ROLES':
      return viewer.isMember && page.visibleRoleIds.some((id) => viewer.roleIds.includes(id)) ? 'allowed' : 'denied';
    case 'STAFF':
    default:
      return 'denied';
  }
}

/** Le visiteur peut-il écrire dans le wiki ou le blog de ce site ? */
export function canEditSection(site: Pick<SiteRecord, 'wikiEditorRoleIds' | 'blogEditorRoleIds'>, kind: SitePageKind, viewer: SiteViewer | null): boolean {
  if (!viewer) return false;
  if (viewer.canManageSite) return true;
  const roles = kind === 'WIKI' ? site.wikiEditorRoleIds : kind === 'BLOG' ? site.blogEditorRoleIds : [];
  return viewer.isMember && roles.some((id) => viewer.roleIds.includes(id));
}

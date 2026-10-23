/**
 * Droits d'édition d'un site, partagés par l'API d'édition et le serveur
 * d'édition à plusieurs.
 *
 *  - site entier : gérer le serveur, ou « configurer » la section Site du
 *    Centre de gestion ;
 *  - wiki / blog : ce qui précède, ou configurer/modérer la section Wiki/Blog,
 *    ou porter un rôle rédacteur du site (sans accès au dashboard) ;
 *  - commentaires : gérer le site ou modérer la section Blog.
 */

import type { Client } from 'discord.js';
import type { SitePageKind } from '@prisma/client';
import prisma from '../../utils/db.js';
import { resolveDashboardAccess, resolveMemberFeatureAccess, type FeatureAccessMap } from '../../api/shared.js';
import { canEditSection, resolveSiteViewer, type SiteViewer } from './siteService.js';

export interface SiteRights {
  userId: string;
  viewer: SiteViewer;
  dashboard: boolean;
  manage: boolean;
  wiki: boolean;
  blog: boolean;
  moderateComments: boolean;
  viewStats: boolean;
  viaGlobalAdmin: boolean;
}

export async function resolveSiteRights(client: Client, guildId: string, userId: string): Promise<SiteRights> {
  const [access, viewer, site] = await Promise.all([
    resolveDashboardAccess(client, guildId, userId),
    resolveSiteViewer(client, guildId, userId),
    prisma.communitySite.findUnique({ where: { guildId }, select: { wikiEditorRoleIds: true, blogEditorRoleIds: true } }),
  ]);
  const features: FeatureAccessMap = access.canViewDashboard ? await resolveMemberFeatureAccess(client, guildId, access, userId) : {};
  const manage = access.canManageSettings || Boolean(features.site?.canConfigure);
  const writes = (key: string) => Boolean(features[key]?.canConfigure || features[key]?.canModerate);
  const roleEditor = (kind: SitePageKind) => Boolean(site && canEditSection(site, kind, viewer));
  return {
    userId,
    viewer,
    dashboard: access.canViewDashboard,
    manage,
    wiki: manage || writes('site_wiki') || roleEditor('WIKI'),
    blog: manage || writes('site_blog') || roleEditor('BLOG'),
    moderateComments: manage || Boolean(features.site_blog?.canModerate),
    viewStats: manage || Boolean(features.site?.canView && access.canViewDashboard),
    viaGlobalAdmin: Boolean(access.viaGlobalAdmin),
  };
}

export function canEditKind(rights: SiteRights, kind: SitePageKind): boolean {
  if (kind === 'WIKI') return rights.wiki;
  if (kind === 'BLOG') return rights.blog;
  return rights.manage;
}

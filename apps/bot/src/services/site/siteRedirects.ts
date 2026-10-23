/**
 * Redirection des anciennes pages publiques vers le site du serveur.
 *
 * Quand un serveur a un site joignable, ses pages publiques historiques du
 * dashboard (appel de sanction, formulaire, classements, giveaways, clans,
 * actualités) renvoient vers la page du site qui porte le bloc équivalent.
 * Sans site joignable (hors ligne, suspendu, module Site coupé), sans page
 * équivalente publique, ou quand le serveur a coupé la redirection
 * (`settings.legacyRedirect`), rien ne change : l'ancienne page reste servie,
 * et les liens déjà envoyés (MP d'appel notamment) continuent de marcher.
 */

import { normalizeSiteDocument, type SiteNode } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { getSiteByGuild, isSiteReachable, type SiteRecord } from './siteService.js';
import { pageUrl } from './blocks/contentBlocks.js';

export const LEGACY_PAGE_KINDS = ['appeal', 'news', 'leaderboard-xp', 'leaderboard-prestige', 'clans', 'clans-rpg', 'giveaways'] as const;
export type LegacyPageKind = (typeof LEGACY_PAGE_KINDS)[number];

const TARGETS: Record<LegacyPageKind, { module: string; variant?: string }> = {
  appeal: { module: 'appeal' },
  news: { module: 'news' },
  'leaderboard-xp': { module: 'leaderboard', variant: 'xp' },
  'leaderboard-prestige': { module: 'leaderboard', variant: 'prestige' },
  clans: { module: 'clans', variant: 'leveling' },
  'clans-rpg': { module: 'clans', variant: 'rpg' },
  giveaways: { module: 'giveaways' },
};

function documentHas(content: unknown, target: { module: string; variant?: string }): boolean {
  const doc = normalizeSiteDocument(content);
  let found = false;
  const visit = (node: SiteNode) => {
    if (found) return;
    if (node.type === 'module' && node.attrs?.module === target.module) {
      const config = (node.attrs.config ?? {}) as { variant?: string };
      if (!target.variant || (config.variant ?? (target.module === 'clans' ? 'leveling' : 'xp')) === target.variant) found = true;
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of doc.content) visit(node);
  return found;
}

/** Redirection des anciennes pages voulue par le serveur (oui par défaut). */
export function legacyRedirectEnabled(site: Pick<SiteRecord, 'settings'>): boolean {
  const settings = (site.settings ?? {}) as { legacyRedirect?: unknown };
  return settings.legacyRedirect !== false;
}

/** Site vers lequel rediriger les anciennes pages d'un serveur, ou nul. */
async function redirectSite(guildId: string): Promise<SiteRecord | null> {
  const site = await getSiteByGuild(guildId);
  if (!site || !legacyRedirectEnabled(site) || !(await isSiteReachable(site))) return null;
  return site;
}

/** Chemin du site (`/s/<slug>/…`) qui remplace une ancienne page, ou nul. */
export async function resolveLegacyRedirect(guildId: string, kind: LegacyPageKind): Promise<string | null> {
  const site = await redirectSite(guildId);
  if (!site) return null;
  const basePath = `/s/${site.slug}`;
  return cache.wrap(`guild:${guildId}:site-redirect:${kind}`, 300, async () => {
    const pages = await prisma.sitePage.findMany({
      where: { siteId: site.id, publishedAt: { not: null }, archivedAt: null, visibility: 'PUBLIC', kind: { in: ['PAGE', 'WIKI'] } },
      select: { id: true, kind: true, slug: true, publishedContent: true },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
      take: 500,
    });
    // La page d'accueil d'abord : c'est elle que le visiteur doit trouver s'il y a doublon.
    pages.sort((a, b) => Number(b.id === site.homePageId) - Number(a.id === site.homePageId));
    const page = pages.find((p) => documentHas(p.publishedContent, TARGETS[kind]));
    if (!page) return '';
    return page.id === site.homePageId ? basePath : pageUrl(basePath, page);
  }).then((path) => path || null);
}

/** Formulaire public historique `/form/<id>` → page du formulaire sur le site. */
export async function resolveFormRedirect(formId: string): Promise<string | null> {
  if (!/^[a-z0-9]{20,32}$/i.test(formId)) return null;
  const form = await prisma.customForm.findFirst({ where: { id: formId, isActive: true }, select: { guildId: true } });
  if (!form) return null;
  const site = await redirectSite(form.guildId);
  return site ? `/s/${site.slug}/form/${formId}` : null;
}

/**
 * Galerie de thèmes partagés entre serveurs.
 *
 * Publication directe : un serveur partage son style (thème, couleurs,
 * polices, arrondis, CSS libre refiltré), des pages modèles et son menu.
 * Appliquer un thème copie le style, crée les pages modèles en brouillon et
 * reprend le menu en y branchant ces nouvelles pages.
 *
 * Les pages modèles sont rendues « portables » : un bloc qui désigne un salon,
 * un formulaire ou une hiérarchie du serveur d'origine perd ce réglage, que le
 * serveur qui l'installe choisira chez lui.
 */

import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import {
  canonicalSiteTheme,
  normalizeSiteDocument,
  normalizeSiteNavigation,
  normalizeSiteThemeSettings,
  resolveSiteTheme,
  sanitizeSiteCss,
  SITE_ASSET_PATH_PREFIX,
  SITE_NAV_SECTIONS,
  type SiteDocument,
  type SiteNavItem,
  type SiteNode,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { createPage, updateSite } from './siteAdminService.js';
import { getSiteByGuild } from './siteService.js';

export const GALLERY_LIMITS = { perGuild: 5, templates: 8, name: 60, description: 300, pageSize: 24, hideAfterReports: 5 } as const;

export type GalleryErrorCode = 'site_missing' | 'share_missing' | 'name_required' | 'too_many_shares' | 'nothing_to_share';

export class GalleryError extends Error {
  constructor(
    readonly code: GalleryErrorCode,
    readonly status = 400,
  ) {
    super(code);
  }
}

// ─── Portabilité ────────────────────────────────────────────────────────────

/** Réglages de bloc qui n'ont de sens que sur le serveur d'origine. */
const LOCAL_CONFIG_KEYS = ['channelId', 'formId', 'formIds', 'hierarchyIds', 'parentId'];

function portableNode(node: SiteNode): SiteNode {
  const next = { ...node } as SiteNode & { attrs?: Record<string, unknown>; content?: SiteNode[] };
  if (next.type === 'module' && next.attrs && typeof next.attrs.config === 'object' && next.attrs.config !== null) {
    const config = { ...(next.attrs.config as Record<string, unknown>) };
    for (const key of LOCAL_CONFIG_KEYS) delete config[key];
    next.attrs = { ...next.attrs, config };
  }
  if (Array.isArray(next.content)) next.content = next.content.map(portableNode);
  return next;
}

export function portableDocument(doc: SiteDocument): SiteDocument {
  return normalizeSiteDocument({ ...doc, content: (doc.content ?? []).map(portableNode) });
}

interface SharedNavItem {
  label: string;
  target: { type: 'template'; key: string } | { type: 'section'; section: string } | { type: 'url'; href: string } | null;
  children: SharedNavItem[];
}

function shareNavigation(items: SiteNavItem[], keyByPageId: Map<string, string>): SharedNavItem[] {
  const convert = (item: SiteNavItem): SharedNavItem | null => {
    const children = item.children.map(convert).filter((c): c is SharedNavItem => c !== null);
    let target: SharedNavItem['target'] = null;
    if (item.target?.type === 'page') {
      const key = keyByPageId.get(item.target.pageId);
      if (key) target = { type: 'template', key };
    } else if (item.target) {
      target = item.target;
    }
    if (!target && children.length === 0) return null;
    return { label: item.label, target, children };
  };
  return items.map(convert).filter((i): i is SharedNavItem => i !== null);
}

function installNavigation(items: unknown, pageIdByKey: Map<string, string>): SiteNavItem[] {
  if (!Array.isArray(items)) return [];
  const convert = (raw: SharedNavItem, i: number): unknown => ({
    id: `nav-gallery-${i}-${Math.random().toString(36).slice(2, 8)}`,
    label: raw.label,
    target:
      raw.target?.type === 'template'
        ? pageIdByKey.has(raw.target.key)
          ? { type: 'page', pageId: pageIdByKey.get(raw.target.key) }
          : null
        : raw.target?.type === 'section' && (SITE_NAV_SECTIONS as readonly string[]).includes(raw.target.section)
          ? raw.target
          : raw.target,
    children: Array.isArray(raw.children) ? raw.children.map(convert) : [],
  });
  return normalizeSiteNavigation((items as SharedNavItem[]).map(convert));
}

// ─── Publication ────────────────────────────────────────────────────────────

export interface ShareInput {
  name?: unknown;
  description?: unknown;
  includeCss?: unknown;
  includeMenu?: unknown;
  pageIds?: unknown;
}

export async function publishThemeShare(client: Client, guildId: string, userId: string, shareId: string | null, input: ShareInput) {
  const site = await getSiteByGuild(guildId);
  if (!site) throw new GalleryError('site_missing', 404);
  const existing = shareId ? await prisma.siteThemeShare.findFirst({ where: { id: shareId, guildId } }) : null;
  if (shareId && !existing) throw new GalleryError('share_missing', 404);
  if (!existing && (await prisma.siteThemeShare.count({ where: { guildId } })) >= GALLERY_LIMITS.perGuild) throw new GalleryError('too_many_shares', 409);

  const name = typeof input.name === 'string' ? input.name.trim().slice(0, GALLERY_LIMITS.name) : existing?.name ?? '';
  if (!name) throw new GalleryError('name_required');

  const pageIds = Array.isArray(input.pageIds) ? input.pageIds.filter((id): id is string => typeof id === 'string').slice(0, GALLERY_LIMITS.templates) : [];
  const pages = pageIds.length
    ? await prisma.sitePage.findMany({ where: { siteId: site.id, id: { in: pageIds }, kind: 'PAGE' }, select: { id: true, title: true, draftContent: true, publishedContent: true } })
    : [];
  const keyByPageId = new Map(pages.map((page, i) => [page.id, `p${i + 1}`]));
  const templates = pages.map((page) => ({
    key: keyByPageId.get(page.id)!,
    title: page.title,
    content: portableDocument(normalizeSiteDocument(page.publishedContent ?? page.draftContent)),
  }));
  const navigation = input.includeMenu === true ? shareNavigation(normalizeSiteNavigation(site.navigation), keyByPageId) : null;

  const data = {
    name,
    description: typeof input.description === 'string' ? input.description.trim().slice(0, GALLERY_LIMITS.description) : existing?.description ?? '',
    authorName: (client.guilds.cache.get(guildId)?.name ?? site.name ?? site.slug).slice(0, 100),
    authorId: userId,
    theme: canonicalSiteTheme(site.theme) ?? 'azur',
    themeSettings: normalizeSiteThemeSettings(site.themeSettings) as Prisma.InputJsonValue,
    customCss: input.includeCss === true && site.customCss ? sanitizeSiteCss(site.customCss, SITE_ASSET_PATH_PREFIX) || null : null,
    templates: templates as unknown as Prisma.InputJsonValue,
    navigation: (navigation ?? undefined) as Prisma.InputJsonValue | undefined,
  };
  return existing
    ? prisma.siteThemeShare.update({ where: { id: existing.id }, data })
    : prisma.siteThemeShare.create({ data: { ...data, guildId, siteId: site.id } });
}

export async function deleteThemeShare(guildId: string, shareId: string): Promise<void> {
  await prisma.siteThemeShare.deleteMany({ where: { id: shareId, guildId } });
}

export async function listOwnThemeShares(guildId: string) {
  return prisma.siteThemeShare.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' } });
}

// ─── Galerie ────────────────────────────────────────────────────────────────

export interface GalleryCard {
  id: string;
  name: string;
  description: string;
  authorName: string;
  installs: number;
  templates: Array<{ key: string; title: string }>;
  hasCss: boolean;
  hasMenu: boolean;
  createdAt: Date;
  preview: { mode: string; font: string; headingFont: string; radius: number; light: Record<string, string>; dark: Record<string, string> };
  installed: boolean;
  own: boolean;
}

export async function listGallery(guildId: string, options: { sort?: 'popular' | 'recent'; search?: string; page?: number }): Promise<{ items: GalleryCard[]; pages: number }> {
  const search = (options.search ?? '').trim().slice(0, 60);
  const where: Prisma.SiteThemeShareWhereInput = {
    hiddenAt: null,
    ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { authorName: { contains: search, mode: 'insensitive' } }] } : {}),
  };
  const page = Math.max(1, Math.min(500, Math.floor(options.page ?? 1)));
  const [total, rows, installed] = await Promise.all([
    prisma.siteThemeShare.count({ where }),
    prisma.siteThemeShare.findMany({
      where,
      orderBy: options.sort === 'recent' ? { createdAt: 'desc' } : [{ installs: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * GALLERY_LIMITS.pageSize,
      take: GALLERY_LIMITS.pageSize,
    }),
    prisma.siteThemeInstall.findMany({ where: { guildId }, select: { shareId: true } }),
  ]);
  const mine = new Set(installed.map((i) => i.shareId));
  const items = rows.map((row) => {
    const theme = resolveSiteTheme(row.theme, row.themeSettings);
    const pick = (p: typeof theme.light) => ({ bg: p.bg, surface: p.surface, text: p.text, muted: p.muted, border: p.border, header: p.header, accent: theme.accent });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      authorName: row.authorName,
      installs: row.installs,
      templates: (Array.isArray(row.templates) ? (row.templates as Array<{ key: string; title: string }>) : []).map((t) => ({ key: t.key, title: t.title })),
      hasCss: Boolean(row.customCss),
      hasMenu: Array.isArray(row.navigation) && (row.navigation as unknown[]).length > 0,
      createdAt: row.createdAt,
      preview: { mode: theme.mode, font: theme.font, headingFont: theme.headingFont, radius: theme.radius, light: pick(theme.light), dark: pick(theme.dark) },
      installed: mine.has(row.id),
      own: row.guildId === guildId,
    };
  });
  return { items, pages: Math.max(1, Math.ceil(total / GALLERY_LIMITS.pageSize)) };
}

// ─── Application ────────────────────────────────────────────────────────────

export interface InstallOptions {
  style?: unknown;
  css?: unknown;
  templates?: unknown;
  menu?: unknown;
}

export async function installThemeShare(guildId: string, userId: string, shareId: string, options: InstallOptions) {
  const site = await getSiteByGuild(guildId);
  if (!site) throw new GalleryError('site_missing', 404);
  const share = await prisma.siteThemeShare.findFirst({ where: { id: shareId, hiddenAt: null } });
  if (!share) throw new GalleryError('share_missing', 404);

  const style = options.style !== false;
  const css = options.css === true && Boolean(share.customCss);
  const wantTemplates = options.templates === true;
  const menu = options.menu === true && Array.isArray(share.navigation);
  if (!style && !css && !wantTemplates && !menu) throw new GalleryError('nothing_to_share');

  const pageIdByKey = new Map<string, string>();
  if (wantTemplates || menu) {
    const templates = Array.isArray(share.templates) ? (share.templates as Array<{ key: string; title: string; content: unknown }>) : [];
    for (const template of templates.slice(0, GALLERY_LIMITS.templates)) {
      // Brouillons : le serveur relit et règle ses blocs avant de publier.
      const page = await createPage(site, userId, { kind: 'PAGE', title: template.title, content: normalizeSiteDocument(template.content) });
      pageIdByKey.set(template.key, page.id);
    }
  }

  await updateSite(guildId, {
    ...(style ? { theme: share.theme, themeSettings: share.themeSettings } : {}),
    ...(css ? { customCss: share.customCss } : {}),
    ...(menu ? { navigation: installNavigation(share.navigation, pageIdByKey) } : {}),
  });

  const counted = await prisma.siteThemeInstall.createMany({ data: [{ shareId, guildId }], skipDuplicates: true });
  if (counted.count > 0 && share.guildId !== guildId) await prisma.siteThemeShare.update({ where: { id: shareId }, data: { installs: { increment: 1 } } });
  return { pagesCreated: pageIdByKey.size };
}

/** Un signalement par serveur ; masqué d'office à partir de quelques serveurs. */
export async function reportThemeShare(guildId: string, shareId: string, reason: unknown): Promise<void> {
  const share = await prisma.siteThemeShare.findUnique({ where: { id: shareId }, select: { id: true, guildId: true } });
  if (!share || share.guildId === guildId) throw new GalleryError('share_missing', 404);
  const created = await prisma.siteThemeReport.createMany({
    data: [{ shareId, guildId, reason: typeof reason === 'string' ? reason.trim().slice(0, 300) : '' }],
    skipDuplicates: true,
  });
  if (created.count === 0) return;
  const updated = await prisma.siteThemeShare.update({ where: { id: shareId }, data: { reports: { increment: 1 } }, select: { reports: true, hiddenAt: true } });
  if (!updated.hiddenAt && updated.reports >= GALLERY_LIMITS.hideAfterReports) await prisma.siteThemeShare.update({ where: { id: shareId }, data: { hiddenAt: new Date() } });
}

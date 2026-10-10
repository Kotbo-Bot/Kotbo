import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import type { SitePageKind } from '@prisma/client';
import { SITE_MODULE_KEYS, siteModuleBotDependency, getSiteModuleSpec } from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { deleteVoteSite, listAdminVoteSites, regenerateVoteWebhookSecret, reorderVoteSites, saveVoteSite, SiteVoteError, topVoters } from '../../../services/site/siteVoteService.js';
import { requireAuth } from '../middleware/auth.js';
import { getApiUrl, getDashboardUrl } from '../../shared.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { recordAdminAudit } from '../../../services/system/adminAuditService.js';
import { getModuleStates } from '../../../services/core/moduleGate.js';
import { canEditKind, resolveSiteRights, type SiteRights } from '../../../services/site/siteRights.js';
import {
  createPage,
  createSite,
  deleteComment,
  deletePage,
  deleteSite,
  getAdminPage,
  getAdminSite,
  getRevision,
  getStaffProfile,
  listAdminPages,
  listComments,
  listRevisions,
  publishPage,
  reorderPages,
  restoreRevision,
  schedulePage,
  setCommentStatus,
  SiteAdminError,
  suggestSiteSlug,
  unpublishPage,
  updatePage,
  updateSite,
  updateStaffProfile,
} from '../../../services/site/siteAdminService.js';
import { deleteSiteAsset, listSiteAssets, storeSiteAsset, SITE_UPLOAD_MAX_BYTES } from '../../../services/site/siteUploads.js';
import { getSiteAnalytics } from '../../../services/site/siteAnalyticsService.js';
import { createPreviewToken } from '../../../services/site/sitePreview.js';
import { isSiteTemplate, SITE_TEMPLATES } from '../../../services/site/siteTemplates.js';
import { flushCollabRoom, resetCollabRoom } from '../../../services/site/siteCollabService.js';
import { allowAgentAgain, getAgentLockStatus, interruptAgent, isSiteAgentLocked } from '../../../services/site/siteAgentLock.js';
import { isPubliclyVisible } from '../../../services/site/blocks/discordBlocks.js';

// ============================================================================
// ÉDITION DES SITES COMMUNAUTAIRES
//
// Une seule API pour deux publics :
//  - le dashboard (staff) : réglages, pages, images, commentaires, fréquentation ;
//  - « Mon espace » : les rédacteurs du wiki et du blog désignés par rôle sur
//    le site, qui n'ont pas accès au dashboard et ne voient que leurs sections.
//
// Droits :
//  - site entier : gérer le serveur, ou « configurer » la section Site ;
//  - wiki / blog : ce qui précède, ou configurer/modérer la section Wiki/Blog
//    du Centre de gestion, ou porter un rôle rédacteur du site ;
//  - commentaires : gérer le site ou modérer la section Blog.
// Les écritures d'un admin global Kotbo sont journalisées, comme au dashboard.
// ============================================================================

const SNOWFLAKE = /^\d{17,20}$/;
const CUID = /^[a-z0-9]{20,32}$/;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function fail(c: Context, err: unknown) {
  if (err instanceof SiteAdminError) return c.json({ error: err.code, detail: err.detail ?? null }, err.status as 400);
  if (err instanceof SiteVoteError) return c.json({ error: err.code, detail: null }, err.status as 400);
  logger.error('SiteAdmin', 'Erreur non gérée :', err);
  return c.json({ error: 'internal' }, 500);
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

declare module 'hono' {
  interface ContextVariableMap {
    siteRights: SiteRights;
  }
}

export function createSiteAdminRouter(client: Client): OpenAPIHono {
  const app = new OpenAPIHono();

  // ── Sites dont la personne est rédactrice (« Mon espace ») ────────────────
  // Les rédacteurs désignés par rôle n'ont souvent pas accès au dashboard : ce
  // point d'entrée leur liste les sections qu'ils peuvent écrire, serveur par serveur.
  app.get('/api/site-editor/mine', requireAuth, async (c) => {
    const userId = c.var.auth.userId;
    const sites = await prisma.communitySite.findMany({
      where: { suspendedAt: null, OR: [{ wikiEditorRoleIds: { isEmpty: false } }, { blogEditorRoleIds: { isEmpty: false } }] },
      select: { id: true, guildId: true, slug: true, name: true, wikiEditorRoleIds: true, blogEditorRoleIds: true },
      take: 500,
    });
    const result = [];
    for (const site of sites) {
      const guild = client.guilds.cache.get(site.guildId);
      if (!guild) continue;
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (!member) continue;
      const roles = member.roles.cache;
      const states = await getModuleStates(site.guildId);
      const kinds: SitePageKind[] = [];
      if (states.site_wiki !== false && site.wikiEditorRoleIds.some((id) => roles.has(id))) kinds.push('WIKI');
      if (states.site_blog !== false && site.blogEditorRoleIds.some((id) => roles.has(id))) kinds.push('BLOG');
      if (kinds.length === 0 || states.site === false) continue;
      const pages = await listAdminPages(site.id, kinds);
      result.push({
        guildId: site.guildId,
        guildName: guild.name,
        guildIcon: guild.iconURL({ size: 64 }),
        site: { slug: site.slug, name: site.name, url: `${getDashboardUrl().replace(/\/$/, '')}/s/${site.slug}` },
        kinds,
        pages,
      });
    }
    return c.json({ sites: result });
  });

  app.use('/api/site-admin/:guildId', requireAuth);
  app.use('/api/site-admin/:guildId/*', requireAuth);
  const gate = async (c: Context, next: () => Promise<void>) => {
    const guildId = c.req.param('guildId') ?? '';
    if (!SNOWFLAKE.test(guildId)) return c.json({ error: 'invalid_guild' }, 400);
    const rights = await resolveSiteRights(client, guildId, c.var.auth.userId);
    if (!rights.dashboard && !rights.wiki && !rights.blog) return c.json({ error: 'forbidden' }, 403);
    c.set('siteRights', rights);
    // Un agent MCP tient la main sur le site : les écritures humaines attendent
    // qu'il la rende ou qu'on l'interrompe (routes /agent et fiche staff exceptées).
    const exempt = c.req.path.endsWith('/staff-profile') || c.req.path.includes(`/site-admin/${guildId}/agent`);
    if (!READ_METHODS.has(c.req.method) && isSiteAgentLocked(guildId) && !exempt) {
      return c.json({ error: 'agent_locked', agent: getAgentLockStatus(guildId) }, 423);
    }
    if (rights.viaGlobalAdmin && !READ_METHODS.has(c.req.method)) {
      void recordAdminAudit({
        actorId: rights.userId,
        actorName: c.var.auth.username ?? null,
        action: 'dashboard.global_admin_write',
        targetType: 'guild',
        targetId: guildId,
        summary: `${c.req.method} ${c.req.path} sur ${client.guilds.cache.get(guildId)?.name ?? guildId}`,
        metadata: { method: c.req.method, route: c.req.path },
      });
    }
    await next();
  };
  app.use('/api/site-admin/:guildId', gate);
  app.use('/api/site-admin/:guildId/*', gate);

  const site = (c: Context) => getAdminSite(c.req.param('guildId') ?? '');

  // ── État ──────────────────────────────────────────────────────────────────
  app.get('/api/site-admin/:guildId', async (c) => {
    const guildId = c.req.param('guildId');
    const rights = c.var.siteRights;
    const [current, states] = await Promise.all([site(c), getModuleStates(guildId)]);
    const kinds: SitePageKind[] = (['PAGE', 'WIKI', 'BLOG'] as const).filter((k) => canEditKind(rights, k));
    const pages = current ? await listAdminPages(current.id, kinds) : [];
    const guild = client.guilds.cache.get(guildId);
    return c.json({
      site: current && (rights.manage || rights.dashboard) ? current : current ? { id: current.id, slug: current.slug, published: current.published, theme: current.theme } : null,
      pages,
      rights: { manage: rights.manage, wiki: rights.wiki, blog: rights.blog, moderateComments: rights.moderateComments, viewStats: rights.viewStats },
      modules: { site: states.site !== false, site_wiki: states.site_wiki !== false, site_blog: states.site_blog !== false },
      baseUrl: `${getDashboardUrl().replace(/\/$/, '')}/s/`,
      suggestedSlug: current ? null : await suggestSiteSlug(guild?.name ?? guildId),
      templates: SITE_TEMPLATES,
      guild: guild ? { name: guild.name, iconUrl: guild.iconURL({ size: 128 }), bannerUrl: guild.bannerURL({ size: 1024 }) } : null,
    });
  });

  app.post('/api/site-admin/:guildId', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    const input = await body(c);
    if (typeof input.slug !== 'string' || !isSiteTemplate(input.template)) return c.json({ error: 'invalid_field' }, 400);
    try {
      return c.json({ site: await createSite(client, c.req.param('guildId'), c.var.siteRights.userId, { slug: input.slug, template: input.template }) }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.patch('/api/site-admin/:guildId', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    try {
      return c.json({ site: await updateSite(c.req.param('guildId'), await body(c)) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/site-admin/:guildId', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    await deleteSite(c.req.param('guildId'));
    return c.json({ ok: true });
  });

  // ── Agent MCP ─────────────────────────────────────────────────────────────
  app.get('/api/site-admin/:guildId/agent', (c) => c.json({ agent: getAgentLockStatus(c.req.param('guildId')) }));

  app.post('/api/site-admin/:guildId/agent/interrupt', async (c) => {
    const rights = c.var.siteRights;
    if (!rights.manage && !rights.wiki && !rights.blog) return c.json({ error: 'forbidden' }, 403);
    const agent = await interruptAgent(c.req.param('guildId'), { id: rights.userId, name: rights.viewer.displayName });
    return c.json({ agent });
  });

  app.post('/api/site-admin/:guildId/agent/allow', (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    return c.json({ agent: allowAgentAgain(c.req.param('guildId')) });
  });

  // ── Catalogue pour l'éditeur ──────────────────────────────────────────────
  app.get('/api/site-admin/:guildId/catalog', async (c) => {
    const guildId = c.req.param('guildId');
    const guild = client.guilds.cache.get(guildId);
    const [states, forms, hierarchies] = await Promise.all([
      getModuleStates(guildId),
      prisma.customForm.findMany({ where: { guildId, isActive: true }, select: { id: true, name: true, isRecruitment: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.staffHierarchy.findMany({ where: { guildId, enabled: true }, select: { id: true, name: true, icon: true }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const blocks = SITE_MODULE_KEYS.map((key) => {
      const spec = getSiteModuleSpec(key);
      const dependency = siteModuleBotDependency(key, {});
      return { key, category: spec.category, available: !dependency || states[dependency] !== false, dependency };
    });
    const channels = guild
      ? [...guild.channels.cache.values()]
          .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
          .sort((a, b) => ('rawPosition' in a && 'rawPosition' in b ? a.rawPosition - b.rawPosition : 0))
          .map((ch) => ({ id: ch.id, name: ch.name, public: isPubliclyVisible(guild, ch, true), botCanSend: Boolean(guild.members.me && ch.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) }))
      : [];
    const roles = guild
      ? [...guild.roles.cache.values()]
          .filter((r) => r.id !== guild.id && !r.managed)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }))
      : [];
    return c.json({ blocks, forms, hierarchies, channels, roles });
  });

  // ── Pages ─────────────────────────────────────────────────────────────────
  app.post('/api/site-admin/:guildId/pages', async (c) => {
    const current = await site(c);
    if (!current) return c.json({ error: 'site_missing' }, 404);
    const input = await body(c);
    const kind: SitePageKind = input.kind === 'WIKI' || input.kind === 'BLOG' ? input.kind : 'PAGE';
    if (!canEditKind(c.var.siteRights, kind)) return c.json({ error: 'forbidden' }, 403);
    try {
      return c.json({ page: await createPage(current, c.var.siteRights.userId, { title: input.title, slug: input.slug, parentId: input.parentId, content: input.content, kind }) }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/site-admin/:guildId/pages/reorder', async (c) => {
    const current = await site(c);
    if (!current) return c.json({ error: 'site_missing' }, 404);
    const input = await body(c);
    const kind: SitePageKind = input.kind === 'WIKI' || input.kind === 'BLOG' ? input.kind : 'PAGE';
    if (!canEditKind(c.var.siteRights, kind)) return c.json({ error: 'forbidden' }, 403);
    try {
      const ids = Array.isArray(input.ids) ? input.ids : [];
      const owned = await prisma.sitePage.count({ where: { siteId: current.id, kind, id: { in: ids.filter((v): v is string => typeof v === 'string') } } });
      if (owned !== ids.length) return c.json({ error: 'invalid_field' }, 400);
      await reorderPages(current.id, current.guildId, ids);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  /** Page de ce site que le visiteur a le droit d'éditer, ou une réponse d'erreur. */
  async function editablePage(c: Context) {
    const current = await site(c);
    const pageId = c.req.param('pageId') ?? '';
    if (!current || !CUID.test(pageId)) return { error: c.json({ error: 'page_missing' }, 404) } as const;
    const page = await getAdminPage(current.id, pageId);
    if (!page) return { error: c.json({ error: 'page_missing' }, 404) } as const;
    if (!canEditKind(c.var.siteRights, page.kind)) return { error: c.json({ error: 'forbidden' }, 403) } as const;
    return { site: current, page } as const;
  }

  app.get('/api/site-admin/:guildId/pages/:pageId', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    return c.json({ page: found.page });
  });

  app.patch('/api/site-admin/:guildId/pages/:pageId', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    try {
      return c.json({ page: await updatePage(found.site, found.page.id, await body(c), c.var.siteRights.userId) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/site-admin/:guildId/pages/:pageId', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    try {
      await deletePage(found.site, found.page.id);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/site-admin/:guildId/pages/:pageId/publish', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    const input = await body(c);
    // Les dernières frappes d'une session à plusieurs sont encore en mémoire.
    await flushCollabRoom(found.page.id);
    try {
      return c.json({ page: await publishPage(client, found.site.guildId, found.page.id, c.var.siteRights.userId, typeof input.note === 'string' ? input.note : null) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/site-admin/:guildId/pages/:pageId/unpublish', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    await unpublishPage(found.site.guildId, found.page.id);
    return c.json({ ok: true });
  });

  app.post('/api/site-admin/:guildId/pages/:pageId/schedule', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    try {
      const scheduledAt = await schedulePage(found.site.guildId, found.page.id, (await body(c)).at ?? null);
      return c.json({ scheduledAt });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/site-admin/:guildId/pages/:pageId/preview', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    const { token, expiresAt } = createPreviewToken(found.page.id);
    return c.json({ url: `${getDashboardUrl().replace(/\/$/, '')}/s/${found.site.slug}/preview/${token}`, expiresAt });
  });

  app.get('/api/site-admin/:guildId/pages/:pageId/revisions', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    return c.json({ revisions: await listRevisions(found.site.guildId, found.page.id) });
  });

  app.get('/api/site-admin/:guildId/pages/:pageId/revisions/:revisionId', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    const revision = await getRevision(found.site.guildId, found.page.id, c.req.param('revisionId'));
    return revision ? c.json({ revision }) : c.json({ error: 'revision_missing' }, 404);
  });

  app.post('/api/site-admin/:guildId/pages/:pageId/revisions/:revisionId/restore', async (c) => {
    const found = await editablePage(c);
    if ('error' in found) return found.error;
    try {
      const page = await restoreRevision(found.site.guildId, found.page.id, c.req.param('revisionId'), c.var.siteRights.userId);
      // Les éditeurs connectés repartent du brouillon restauré.
      await resetCollabRoom(found.page.id);
      return c.json({ page });
    } catch (err) {
      return fail(c, err);
    }
  });

  // ── Images ────────────────────────────────────────────────────────────────
  app.get('/api/site-admin/:guildId/assets', async (c) => {
    const current = await site(c);
    if (!current) return c.json({ assets: [] });
    return c.json({ assets: await listSiteAssets(current.id) });
  });

  app.post('/api/site-admin/:guildId/assets', async (c) => {
    const current = await site(c);
    if (!current) return c.json({ error: 'site_missing' }, 404);
    const rights = c.var.siteRights;
    if (!rights.manage && !rights.wiki && !rights.blog) return c.json({ error: 'forbidden' }, 403);
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > SITE_UPLOAD_MAX_BYTES + 64 * 1024) return c.json({ error: 'too_large' }, 413);
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File)) return c.json({ error: 'invalid_field' }, 400);
    try {
      const result = await storeSiteAsset(current, { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name, uploadedById: rights.userId });
      return result.ok ? c.json({ asset: result.asset }, 201) : c.json({ error: result.error }, result.error === 'quota' ? 409 : 400);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/site-admin/:guildId/assets/:assetId', async (c) => {
    const current = await site(c);
    if (!current || !c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    return (await deleteSiteAsset(current.id, c.req.param('assetId'))) ? c.json({ ok: true }) : c.json({ error: 'asset_missing' }, 404);
  });

  // ── Commentaires ──────────────────────────────────────────────────────────
  app.get('/api/site-admin/:guildId/comments', async (c) => {
    if (!c.var.siteRights.moderateComments) return c.json({ error: 'forbidden' }, 403);
    return c.json({ comments: await listComments(c.req.param('guildId'), c.req.query('status')) });
  });

  app.patch('/api/site-admin/:guildId/comments/:commentId', async (c) => {
    if (!c.var.siteRights.moderateComments) return c.json({ error: 'forbidden' }, 403);
    try {
      await setCommentStatus(c.req.param('guildId'), c.req.param('commentId'), (await body(c)).status);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/site-admin/:guildId/comments/:commentId', async (c) => {
    if (!c.var.siteRights.moderateComments) return c.json({ error: 'forbidden' }, 403);
    await deleteComment(c.req.param('guildId'), c.req.param('commentId'));
    return c.json({ ok: true });
  });

  // ── Fréquentation ─────────────────────────────────────────────────────────
  app.get('/api/site-admin/:guildId/analytics', async (c) => {
    if (!c.var.siteRights.viewStats) return c.json({ error: 'forbidden' }, 403);
    const current = await site(c);
    if (!current) return c.json({ error: 'site_missing' }, 404);
    const days = Number.parseInt(c.req.query('days') ?? '30', 10);
    return c.json({ report: await getSiteAnalytics(current.id, Number.isFinite(days) ? days : 30) });
  });

  // ── Votes : sites de classement, secrets de webhook, meilleurs votants ────
  app.get('/api/site-admin/:guildId/votes', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    const guildId = c.req.param('guildId');
    const [voteSites, top] = await Promise.all([listAdminVoteSites(guildId, getApiUrl()), topVoters(guildId, 10)]);
    const identities = await getMemberIdentities(client, guildId, top.map((t) => t.userId));
    return c.json({
      voteSites,
      topVoters: top.map((t) => ({ ...t, name: identities.get(t.userId)?.displayName ?? t.userId, avatarUrl: identities.get(t.userId)?.avatarUrl ?? null })),
    });
  });

  app.post('/api/site-admin/:guildId/votes', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    try {
      const created = await saveVoteSite(c.req.param('guildId'), null, await body(c));
      return c.json({ id: created.id }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/site-admin/:guildId/votes/reorder', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    try {
      await reorderVoteSites(c.req.param('guildId'), (await body(c)).ids);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.patch('/api/site-admin/:guildId/votes/:voteSiteId', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    const voteSiteId = c.req.param('voteSiteId');
    if (!CUID.test(voteSiteId)) return c.json({ error: 'vote_site_missing' }, 404);
    try {
      await saveVoteSite(c.req.param('guildId'), voteSiteId, await body(c));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/site-admin/:guildId/votes/:voteSiteId/secret', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    const voteSiteId = c.req.param('voteSiteId');
    if (!CUID.test(voteSiteId)) return c.json({ error: 'vote_site_missing' }, 404);
    try {
      await regenerateVoteWebhookSecret(c.req.param('guildId'), voteSiteId);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/site-admin/:guildId/votes/:voteSiteId', async (c) => {
    if (!c.var.siteRights.manage) return c.json({ error: 'forbidden' }, 403);
    await deleteVoteSite(c.req.param('guildId'), c.req.param('voteSiteId'));
    return c.json({ ok: true });
  });

  // ── Fiche staff du visiteur ───────────────────────────────────────────────
  app.get('/api/site-admin/:guildId/staff-profile', async (c) => {
    return c.json({ profile: await getStaffProfile(c.req.param('guildId'), c.var.siteRights.userId) });
  });

  app.put('/api/site-admin/:guildId/staff-profile', async (c) => {
    try {
      return c.json({ profile: await updateStaffProfile(c.req.param('guildId'), c.var.siteRights.userId, await body(c)) });
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}

import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { Client } from 'discord.js';
import { isSiteModuleKey } from '@kotbo/shared';
import prisma from '../../../../utils/db.js';
import { cache } from '../../../../utils/cache.js';
import { logger } from '../../../../utils/logger.js';
import * as m from '../../../../lib/paraglide/messages.js';
import { optionalAuth } from '../../middleware/auth.js';
import { pickLocale, buildSiteCtx, renderPageMain, renderCommentsSection, virtualDocument } from '../../../../services/site/sitePages.js';
import { findModuleNode, renderBlock } from '../../../../services/site/blocks/index.js';
import {
  checkPageAccess,
  getPublishedPageById,
  getSiteById,
  resolveSiteViewer,
  type SiteRecord,
  type SiteViewer,
} from '../../../../services/site/siteService.js';
import { normalizeSiteDocument, type SiteDocument } from '@kotbo/shared';
import { moderateMemberText } from '../../../../services/site/siteModeration.js';
import { isTicketActive, openTicketFromSite, postTicketMessageFromSite } from '../../../../services/site/siteTicketService.js';
import { toggleGiveawayParticipation } from '../../../../services/features/giveawayService.js';
import { createSuggestion, voteOnSuggestion } from '../../../../services/features/suggestionService.js';
import { buyListing } from '../../../../services/economy/marketplaceService.js';
import { getAgentLockStatus, interruptAgent } from '../../../../services/site/siteAgentLock.js';
import { LEGACY_PAGE_KINDS, resolveFormRedirect, resolveLegacyRedirect, type LegacyPageKind } from '../../../../services/site/siteRedirects.js';

// ============================================================================
// API DU SCRIPT DES SITES COMMUNAUTAIRES
//
// Appelée par `site.js`, depuis l'origine du dashboard, avec le cookie de
// session (credentials: 'include'). Tout ce qui dépend du visiteur passe ici :
// identité, pages réservées, blocs rechargés avec son identité, actions,
// commentaires, tickets. Le site n'est servi qu'une fois publié et non
// suspendu ; chaque action revérifie le module concerné et l'appartenance au
// serveur.
// ============================================================================

const VIEWER_TTL_SECONDS = 30;
const limiter = new Map<string, number[]>();

function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (limiter.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  limiter.set(key, recent);
  if (limiter.size > 50_000) {
    for (const [k, times] of limiter) if (times.every((t) => now - t >= 10 * 60_000)) limiter.delete(k);
  }
  return recent.length > max;
}

function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'unknown';
}

function localeOf(c: Context) {
  return pickLocale(new URLSearchParams(c.req.query()), c.req.header('accept-language') ?? null);
}

async function liveSite(c: Context): Promise<SiteRecord | null> {
  const site = await getSiteById(c.req.param('siteId') ?? '');
  return site && site.published && !site.suspendedAt ? site : null;
}

async function viewerFor(client: Client, c: Context, site: SiteRecord): Promise<SiteViewer | null> {
  const auth = c.var.authOptional;
  if (!auth) return null;
  return cache.wrap(`guild:${site.guildId}:site-viewer:${auth.userId}`, VIEWER_TTL_SECONDS, () => resolveSiteViewer(client, site.guildId, auth.userId));
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const CUID = /^[a-z0-9]{20,32}$/;

/** Document d'une page pour le rechargement d'un bloc, après contrôle d'accès. */
async function blockDocument(site: SiteRecord, pageId: string, viewer: SiteViewer | null): Promise<SiteDocument | 'forbidden' | null> {
  const virtual = virtualDocument(pageId);
  if (virtual) return pageId === '_home' && site.homePageId ? null : virtual;
  if (!CUID.test(pageId)) return null;
  const page = await getPublishedPageById(site.id, pageId);
  if (!page) return null;
  if (checkPageAccess(page, viewer) !== 'allowed') return 'forbidden';
  return normalizeSiteDocument(page.publishedContent);
}

export function createSiteApiRouter(client: Client): OpenAPIHono {
  const app = new OpenAPIHono();

  // ── Redirection des anciennes pages publiques ─────────────────────────────
  // Appelée par les pages publiques historiques du dashboard au chargement.
  app.get('/api/site/redirect', async (c) => {
    const formId = c.req.query('formId');
    const guildId = c.req.query('guildId') ?? '';
    const kind = c.req.query('kind') ?? '';
    let path: string | null = null;
    if (formId) path = await resolveFormRedirect(formId);
    else if (/^\d{17,20}$/.test(guildId) && (LEGACY_PAGE_KINDS as readonly string[]).includes(kind)) path = await resolveLegacyRedirect(guildId, kind as LegacyPageKind);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ path });
  });

  app.use('/api/site/:siteId/*', optionalAuth);

  // ── Visiteur ──────────────────────────────────────────────────────────────
  app.get('/api/site/:siteId/viewer', async (c) => {
    const site = await liveSite(c);
    if (!site) return c.json({ error: 'Site introuvable' }, 404);
    const viewer = await viewerFor(client, c, site);
    return c.json({
      viewer: viewer
        ? { userId: viewer.userId, displayName: viewer.displayName, avatarUrl: viewer.avatarUrl, isMember: viewer.isMember, isStaff: viewer.isStaff, canManageSite: viewer.canManageSite }
        : null,
      // Seul qui gère le site apprend qu'un agent le modifie, et peut l'arrêter.
      agent: viewer?.canManageSite ? getAgentLockStatus(site.guildId) : null,
    });
  });

  // ── Interrompre un agent depuis le site publié ────────────────────────────
  app.post('/api/site/:siteId/agent/interrupt', async (c) => {
    const site = await getSiteById(c.req.param('siteId') ?? '');
    if (!site) return c.json({ error: 'Introuvable' }, 404);
    const viewer = await viewerFor(client, c, site);
    if (!viewer) return c.json({ error: m.site_err_login({}, { locale: localeOf(c) }) }, 401);
    if (!viewer.canManageSite) return c.json({ error: 'Accès refusé' }, 403);
    return c.json({ agent: await interruptAgent(site.guildId, { id: viewer.userId, name: viewer.displayName }) });
  });

  // ── Page réservée ─────────────────────────────────────────────────────────
  app.get('/api/site/:siteId/pages/:pageId/content', async (c) => {
    const site = await liveSite(c);
    const pageId = c.req.param('pageId');
    if (!site || !CUID.test(pageId)) return c.json({ error: 'Introuvable' }, 404);
    const page = await getPublishedPageById(site.id, pageId);
    if (!page) return c.json({ error: 'Introuvable' }, 404);
    const viewer = await viewerFor(client, c, site);
    const access = checkPageAccess(page, viewer);
    if (access === 'login') return c.json({ error: m.site_err_login({}, { locale: localeOf(c) }) }, 401);
    if (access === 'denied') return c.json({ error: m.site_restricted_denied({}, { locale: localeOf(c) }) }, 403);
    const ctx = await buildSiteCtx({ client, query: new URLSearchParams(c.req.query()), acceptLanguage: c.req.header('accept-language') ?? null }, site, viewer, true);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ html: await renderPageMain(ctx, page), title: page.publishedTitle ?? page.slug });
  });

  // ── Bloc rechargé ─────────────────────────────────────────────────────────
  app.get('/api/site/:siteId/blocks/:pageId/:index', async (c) => {
    const site = await liveSite(c);
    if (!site) return c.json({ error: 'Introuvable' }, 404);
    if (rateLimited(`block:${clientIp(c)}`, 240, 60_000)) return c.json({ error: m.site_err_too_many({}, { locale: localeOf(c) }) }, 429);
    const viewer = await viewerFor(client, c, site);
    const pageId = c.req.param('pageId');
    const index = Number.parseInt(c.req.param('index'), 10);
    const doc = await blockDocument(site, pageId, viewer);
    if (doc === 'forbidden') return c.json({ error: 'Accès refusé' }, 403);
    const node = doc && Number.isInteger(index) && index >= 0 ? findModuleNode(doc, index) : null;
    if (!node || !isSiteModuleKey(node.key)) return c.json({ error: 'Introuvable' }, 404);
    const ctx = await buildSiteCtx({ client, query: new URLSearchParams(c.req.query()), acceptLanguage: c.req.header('accept-language') ?? null }, site, viewer, true);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ html: await renderBlock(ctx.block, node.key, node.config, { pageId, index }) });
  });

  // ── Actions ───────────────────────────────────────────────────────────────
  app.post('/api/site/:siteId/actions/:action', async (c) => {
    const site = await liveSite(c);
    if (!site) return c.json({ error: 'Introuvable' }, 404);
    const o = { locale: localeOf(c) };
    const viewer = await viewerFor(client, c, site);
    if (!viewer) return c.json({ error: m.site_err_login({}, o) }, 401);
    if (!viewer.isMember) return c.json({ error: m.site_err_member_only({}, o) }, 403);
    if (rateLimited(`action:${viewer.userId}`, 30, 60_000)) return c.json({ error: m.site_err_too_many({}, o) }, 429);

    const body = await readBody(c);
    const id = str(body.id, 40);
    const { isModuleEnabled } = await import('../../../../services/core/moduleGate.js');
    const guildId = site.guildId;

    try {
      switch (c.req.param('action')) {
        case 'giveaway-toggle': {
          if (!(await isModuleEnabled(guildId, 'giveaways'))) return c.json({ error: m.site_err_unavailable({}, o) }, 403);
          if (!CUID.test(id)) return c.json({ error: m.site_err_invalid({}, o) }, 400);
          const guild = client.guilds.cache.get(guildId);
          const member = guild ? await guild.members.fetch(viewer.userId).catch(() => null) : null;
          const result = await toggleGiveawayParticipation(client, guildId, id, {
            userId: viewer.userId,
            roleIds: viewer.roleIds,
            accountCreatedAt: member?.user.createdAt ?? null,
            joinedAt: member?.joinedAt ?? null,
            guildName: guild?.name ?? '',
          });
          return result.ok ? c.json({ ok: true, joined: result.joined, message: result.message }) : c.json({ error: result.message }, result.reason === 'ended' ? 404 : 409);
        }
        case 'suggestion-vote': {
          if (!(await isModuleEnabled(guildId, 'suggestions'))) return c.json({ error: m.site_err_unavailable({}, o) }, 403);
          const dir = body.dir === 'down' ? 'down' : 'up';
          if (!CUID.test(id)) return c.json({ error: m.site_err_invalid({}, o) }, 400);
          const vote = await voteOnSuggestion(client, guildId, id, viewer.userId, dir);
          return vote.ok ? c.json({ ok: true }) : c.json({ error: m.site_err_not_found({}, o) }, 404);
        }
        case 'suggestion-create': {
          if (!(await isModuleEnabled(guildId, 'suggestions'))) return c.json({ error: m.site_err_unavailable({}, o) }, 403);
          const content = str(body.content, 2000);
          if (content.length < 5) return c.json({ error: m.site_err_invalid({}, o) }, 400);
          if (rateLimited(`suggest:${viewer.userId}`, 3, 10 * 60_000)) return c.json({ error: m.site_err_too_many({}, o) }, 429);
          const verdict = await moderateMemberText(guildId, content);
          if (!verdict.allowed) {
            logger.info('Site', `Suggestion refusée sur ${guildId} (${verdict.reason}) pour ${viewer.userId}`);
            return c.json({ error: m.site_err_refused({}, o) }, 422);
          }
          await createSuggestion(guildId, viewer.userId, viewer.username, content, client);
          return c.json({ ok: true, message: m.site_suggestion_sent({}, o) });
        }
        case 'event-register': {
          if (!(await isModuleEnabled(guildId, 'events'))) return c.json({ error: m.site_err_unavailable({}, o) }, 403);
          const event = CUID.test(id) ? await prisma.event.findFirst({ where: { id, guildId }, select: { id: true, type: true, status: true, formId: true } }) : null;
          if (!event) return c.json({ error: m.site_err_not_found({}, o) }, 404);
          if (event.type !== 'CUSTOM' || event.status !== 'PUBLISHED' || event.formId) return c.json({ error: m.site_err_event_closed({}, o) }, 409);
          const created = await prisma.customEventRegistration
            .create({ data: { eventId: event.id, guildId, userId: viewer.userId, username: viewer.username, userTag: viewer.username } })
            .then(() => true)
            .catch(() => false);
          return created ? c.json({ ok: true, message: m.site_event_registered_ok({}, o) }) : c.json({ error: m.site_err_event_already({}, o) }, 409);
        }
        case 'market-buy': {
          if (!(await isModuleEnabled(guildId, 'marketplace'))) return c.json({ error: m.site_err_unavailable({}, o) }, 403);
          if (!CUID.test(id)) return c.json({ error: m.site_err_invalid({}, o) }, 400);
          const result = await buyListing(guildId, viewer.userId, id);
          return result.success ? c.json({ ok: true, message: m.site_market_bought({}, o) }) : c.json({ error: result.error ?? m.site_error_generic({}, o) }, 409);
        }
        default:
          return c.json({ error: m.site_err_invalid({}, o) }, 400);
      }
    } catch (err) {
      logger.error('SiteApi', `Action ${c.req.param('action')} en échec sur ${guildId} :`, err);
      return c.json({ error: err instanceof Error && err.message ? err.message : m.site_error_generic({}, o) }, 500);
    }
  });

  // ── Commentaires ──────────────────────────────────────────────────────────
  app.get('/api/site/:siteId/pages/:pageId/comments', async (c) => {
    const site = await liveSite(c);
    const pageId = c.req.param('pageId');
    if (!site || !CUID.test(pageId)) return c.json({ error: 'Introuvable' }, 404);
    const page = await getPublishedPageById(site.id, pageId);
    if (!page || page.kind !== 'BLOG') return c.json({ error: 'Introuvable' }, 404);
    const viewer = await viewerFor(client, c, site);
    if (checkPageAccess(page, viewer) !== 'allowed') return c.json({ error: 'Accès refusé' }, 403);
    return c.json({ html: await renderCommentsSection(page.id, page.commentsEnabled, localeOf(c)) });
  });

  app.post('/api/site/:siteId/pages/:pageId/comments', async (c) => {
    const site = await liveSite(c);
    const pageId = c.req.param('pageId');
    const o = { locale: localeOf(c) };
    if (!site || !CUID.test(pageId)) return c.json({ error: 'Introuvable' }, 404);
    const viewer = await viewerFor(client, c, site);
    if (!viewer) return c.json({ error: m.site_err_login({}, o) }, 401);
    if (!viewer.isMember) return c.json({ error: m.site_err_member_only({}, o) }, 403);
    const page = await getPublishedPageById(site.id, pageId);
    if (!page || page.kind !== 'BLOG' || checkPageAccess(page, viewer) !== 'allowed') return c.json({ error: m.site_err_not_found({}, o) }, 404);
    if (!page.commentsEnabled) return c.json({ error: m.site_err_comments_closed({}, o) }, 403);
    if (rateLimited(`comment:${viewer.userId}`, 5, 10 * 60_000)) return c.json({ error: m.site_err_too_many({}, o) }, 429);
    const content = str((await readBody(c)).content, 2000);
    if (content.length < 2) return c.json({ error: m.site_err_invalid({}, o) }, 400);
    const verdict = await moderateMemberText(site.guildId, content);
    const comment = await prisma.siteComment.create({
      data: {
        pageId: page.id,
        guildId: site.guildId,
        authorId: viewer.userId,
        authorName: viewer.displayName,
        authorAvatar: viewer.avatarUrl,
        content,
        status: verdict.allowed ? 'VISIBLE' : 'PENDING',
        moderationReason: verdict.reason,
      },
      select: { id: true, status: true },
    });
    return c.json({ ok: true, id: comment.id, status: comment.status }, 201);
  });

  // ── Signalement ───────────────────────────────────────────────────────────
  app.post('/api/site/:siteId/report', async (c) => {
    const site = await getSiteById(c.req.param('siteId') ?? '');
    const o = { locale: localeOf(c) };
    if (!site) return c.json({ error: 'Introuvable' }, 404);
    const body = await readBody(c);
    const reason = ['scam', 'illegal', 'hate', 'impersonation', 'other'].includes(String(body.reason)) ? String(body.reason) : null;
    if (!reason) return c.json({ error: m.site_err_invalid({}, o) }, 400);
    const day = new Date().toISOString().slice(0, 10);
    // Ni adresse ni compte stockés : un hash du jour suffit à freiner les rafales.
    const reporterHash = createHash('sha256').update(`site-report:${day}:${clientIp(c)}`).digest('hex').slice(0, 32);
    const already = await prisma.siteReport.count({ where: { siteId: site.id, reporterHash } });
    if (already >= 3) return c.json({ error: m.site_err_report_limit({}, o) }, 429);
    const pageId = str(body.pageId, 40);
    await prisma.siteReport.create({
      data: {
        siteId: site.id,
        guildId: site.guildId,
        pageId: CUID.test(pageId) ? pageId : null,
        path: str(body.path, 300) || `/s/${site.slug}`,
        reason,
        details: str(body.details, 2000) || null,
        reporterHash,
      },
    });
    logger.warn('Site', `Signalement « ${reason} » du site ${site.slug} (${site.guildId}).`);
    return c.json({ ok: true }, 201);
  });

  // ── Tickets ───────────────────────────────────────────────────────────────
  app.post('/api/site/:siteId/tickets', async (c) => {
    const site = await liveSite(c);
    const o = { locale: localeOf(c) };
    if (!site) return c.json({ error: 'Introuvable' }, 404);
    const viewer = await viewerFor(client, c, site);
    if (!viewer) return c.json({ error: m.site_err_login({}, o) }, 401);
    if (!viewer.isMember) return c.json({ error: m.site_err_member_only({}, o) }, 403);
    const { isModuleEnabled } = await import('../../../../services/core/moduleGate.js');
    if (!(await isModuleEnabled(site.guildId, 'tickets'))) return c.json({ error: m.site_ticket_disabled({}, o) }, 403);
    if (rateLimited(`ticket:${viewer.userId}`, 3, 10 * 60_000)) return c.json({ error: m.site_err_too_many({}, o) }, 429);
    const body = await readBody(c);
    const subject = str(body.subject, 100);
    const message = str(body.message, 3800);
    if (!subject || !message) return c.json({ error: m.site_form_required({}, o) }, 400);
    const guild = client.guilds.cache.get(site.guildId);
    if (!guild) return c.json({ error: m.site_ticket_failed({}, o) }, 503);
    const result = await openTicketFromSite(client, guild, viewer, { typeId: str(body.typeId, 64) || null, subject, message });
    if (result.ok) return c.json({ ok: true, id: result.ticketId }, 201);
    const errors = {
      blacklisted: m.site_ticket_blacklisted,
      quota: m.site_ticket_quota,
      pending: m.site_ticket_pending,
      busy: m.site_ticket_busy,
      failed: m.site_ticket_failed,
    } as const;
    return c.json({ error: result.detail ?? errors[result.error]({}, o) }, result.error === 'failed' ? 500 : 409);
  });

  app.post('/api/site/:siteId/tickets/:ticketId/messages', async (c) => {
    const site = await liveSite(c);
    const o = { locale: localeOf(c) };
    if (!site) return c.json({ error: 'Introuvable' }, 404);
    const viewer = await viewerFor(client, c, site);
    if (!viewer) return c.json({ error: m.site_err_login({}, o) }, 401);
    if (rateLimited(`ticket-msg:${viewer.userId}`, 20, 60_000)) return c.json({ error: m.site_err_too_many({}, o) }, 429);
    const ticketId = c.req.param('ticketId');
    const ticket = CUID.test(ticketId)
      ? await prisma.ticket.findFirst({
          where: { id: ticketId, guildId: site.guildId, userId: viewer.userId },
          select: { id: true, reason: true, status: true, createdAt: true, channelId: true, threadId: true, userId: true },
        })
      : null;
    if (!ticket || !isTicketActive(ticket.status)) return c.json({ error: m.site_err_not_found({}, o) }, 404);
    const content = str((await readBody(c)).content, 3800);
    if (!content) return c.json({ error: m.site_form_required({}, o) }, 400);
    const sent = await postTicketMessageFromSite(client, site.guildId, ticket, viewer, content);
    return sent ? c.json({ ok: true }, 201) : c.json({ error: m.site_ticket_offsite({}, o) }, 409);
  });

  return app;
}

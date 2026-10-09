import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveAdminAccess } from '../../shared.js';
import { recordAdminAudit } from '../../../services/system/adminAuditService.js';
import { suspendSite, unsuspendSite } from '../../../services/site/siteAdminService.js';

// ============================================================================
// SITES COMMUNAUTAIRES : ADMINISTRATION KOTBO
//
// Réservé aux admins globaux. Les signalements « Signaler ce site » arrivent
// ici, pas chez les gérants du serveur. Suspendre un site le met hors ligne
// (451) et l'empêche d'être republié tant que la suspension n'est pas levée.
// Chaque décision est journalisée.
// ============================================================================

const CUID = /^[a-z0-9]{20,32}$/;

export function createAdminSitesRouter(client: Client): OpenAPIHono {
  const app = new OpenAPIHono();
  app.use('/api/admin/sites', requireAuth);
  app.use('/api/admin/sites/*', requireAuth);
  const gate = async (c: Context, next: () => Promise<void>) => {
    if (!(await resolveAdminAccess(client, c.var.auth.userId))) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
  app.use('/api/admin/sites', gate);
  app.use('/api/admin/sites/*', gate);

  app.get('/api/admin/sites', async (c) => {
    const query = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 60);
    const sites = await prisma.communitySite.findMany({
      where: query ? { OR: [{ slug: { contains: query } }, { guildId: query }, { name: { contains: query, mode: 'insensitive' } }] } : {},
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        guildId: true,
        slug: true,
        name: true,
        published: true,
        suspendedAt: true,
        suspendedReason: true,
        updatedAt: true,
        _count: { select: { pages: true, reports: { where: { status: 'OPEN' } } } },
      },
    });
    return c.json({
      sites: sites.map((s) => ({ ...s, guildName: client.guilds.cache.get(s.guildId)?.name ?? null })),
    });
  });

  app.get('/api/admin/sites/reports', async (c) => {
    const status = c.req.query('status') === 'ALL' ? undefined : ((c.req.query('status') as 'OPEN' | 'RESOLVED' | 'DISMISSED' | undefined) ?? 'OPEN');
    const reports = await prisma.siteReport.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, siteId: true, guildId: true, path: true, reason: true, details: true, status: true, createdAt: true, resolvedAt: true, site: { select: { slug: true, name: true, suspendedAt: true } } },
    });
    return c.json({ reports });
  });

  app.patch('/api/admin/sites/reports/:reportId', async (c) => {
    const id = c.req.param('reportId');
    const input = (await c.req.json().catch(() => ({}))) as { status?: string };
    if (!CUID.test(id) || (input.status !== 'RESOLVED' && input.status !== 'DISMISSED' && input.status !== 'OPEN')) return c.json({ error: 'invalid_field' }, 400);
    const report = await prisma.siteReport.update({
      where: { id },
      data: { status: input.status, resolvedById: input.status === 'OPEN' ? null : c.var.auth.userId, resolvedAt: input.status === 'OPEN' ? null : new Date() },
      select: { id: true, siteId: true, guildId: true },
    });
    void recordAdminAudit({
      actorId: c.var.auth.userId,
      actorName: c.var.auth.username ?? null,
      action: 'site.report_status',
      targetType: 'site',
      targetId: report.siteId,
      summary: `Signalement ${report.id} → ${input.status}`,
    });
    return c.json({ ok: true });
  });

  app.post('/api/admin/sites/:siteId/suspend', async (c) => {
    const siteId = c.req.param('siteId');
    if (!CUID.test(siteId)) return c.json({ error: 'invalid_field' }, 400);
    const input = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) return c.json({ error: 'reason_required' }, 400);
    const site = await suspendSite(siteId, c.var.auth.userId, reason);
    await prisma.siteReport.updateMany({ where: { siteId, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedById: c.var.auth.userId, resolvedAt: new Date() } });
    void recordAdminAudit({
      actorId: c.var.auth.userId,
      actorName: c.var.auth.username ?? null,
      action: 'site.suspend',
      targetType: 'guild',
      targetId: site.guildId,
      summary: `Site /s/${site.slug} suspendu : ${reason.slice(0, 200)}`,
      metadata: { siteId, reason },
    });
    return c.json({ ok: true });
  });

  app.post('/api/admin/sites/:siteId/unsuspend', async (c) => {
    const siteId = c.req.param('siteId');
    if (!CUID.test(siteId)) return c.json({ error: 'invalid_field' }, 400);
    const site = await unsuspendSite(siteId);
    void recordAdminAudit({
      actorId: c.var.auth.userId,
      actorName: c.var.auth.username ?? null,
      action: 'site.unsuspend',
      targetType: 'guild',
      targetId: site.guildId,
      summary: `Suspension du site /s/${site.slug} levée`,
      metadata: { siteId },
    });
    return c.json({ ok: true });
  });

  return app;
}

import { Hono } from 'hono';
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { DEFAULT_NOTIFICATION_CHANNEL_PREFS, NOTIFICATION_CATEGORIES, isModulePaused, isNotificationCategory } from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { dashboardAuth, fail, readBody, send } from '../../hono/dashboard/kit.js';

/**
 * Boîte de notifications d'une personne, tous serveurs confondus.
 *
 *   GET    /api/dashboard/notifications?status=inbox|unread|archived&guild=&category=&cursor=&limit=
 *   PATCH  /api/dashboard/notifications/:id          { read?, archived? }
 *   DELETE /api/dashboard/notifications/:id
 *   POST   /api/dashboard/notifications/read-all     { guildId? }
 *   GET    /api/dashboard/notifications/preferences
 *   PUT    /api/dashboard/notifications/preferences  { category, dashboard, dm, digest }
 *
 * Tout est filtré sur `userId` : on ne lit et ne touche que ses propres lignes,
 * quel que soit le serveur. Les actions rapides passent par les routes du
 * module concerné, qui gardent leurs propres contrôles d'accès.
 */
const PAGE_MAX = 50;
const SNOWFLAKE = /^\d{17,20}$/;
const SCOPE = 'NotificationInbox';
const FAILURE = 'Erreur sur les notifications';

function serialize(client: Client, n: Prisma.NotificationGetPayload<object>) {
  return { ...n, guildName: client.guilds.cache.get(n.guildId)?.name ?? null };
}

export function createNotificationInboxRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/notifications';

  router.get(`${base}/preferences`, dashboardAuth, async (c) => {
    try {
      const rows = await prisma.notificationPreference.findMany({ where: { userId: c.var.dashboardUser.userId } });
      const byCategory = new Map(rows.map((r) => [r.category, r]));
      return send(c, {
        // La famille « partnerships » porte le nom de son module : en pause, il
        // n'a plus rien a notifier, et sa ligne n'a rien a regler.
        categories: NOTIFICATION_CATEGORIES.filter((category) => !isModulePaused(category)).map((category) => {
          const row = byCategory.get(category);
          return { category, ...(row ? { dashboard: row.dashboard, dm: row.dm, digest: row.digest } : DEFAULT_NOTIFICATION_CHANNEL_PREFS) };
        }),
      });
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  router.put(`${base}/preferences`, dashboardAuth, async (c) => {
    const userId = c.var.dashboardUser.userId;
    try {
      const body = await readBody<{ category?: unknown; dashboard?: unknown; dm?: unknown; digest?: unknown }>(c);
      if (!body || !isNotificationCategory(body.category) || typeof body.dashboard !== 'boolean' || typeof body.dm !== 'boolean' || typeof body.digest !== 'boolean') {
        return send(c, { error: 'Préférence invalide' }, 400);
      }
      // Le résumé remplace les MP : il n'a de sens qu'avec les MP actifs.
      const prefs = { dashboard: body.dashboard, dm: body.dm, digest: body.dm && body.digest };
      await prisma.notificationPreference.upsert({
        where: { userId_category: { userId, category: body.category } },
        create: { userId, category: body.category, ...prefs },
        update: prefs,
      });
      return send(c, { category: body.category, ...prefs });
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  router.post(`${base}/read-all`, dashboardAuth, async (c) => {
    try {
      const body = await readBody<{ guildId?: unknown }>(c);
      const guildId = typeof body?.guildId === 'string' && SNOWFLAKE.test(body.guildId) ? body.guildId : undefined;
      const { count } = await prisma.notification.updateMany({
        where: { userId: c.var.dashboardUser.userId, isRead: false, ...(guildId ? { guildId } : {}) },
        data: { isRead: true },
      });
      return send(c, { updated: count });
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  router.get(base, dashboardAuth, async (c) => {
    const userId = c.var.dashboardUser.userId;
    try {
      const status = c.req.query('status') ?? 'inbox';
      const guildId = c.req.query('guild');
      const category = c.req.query('category') ?? null;
      const cursor = c.req.query('cursor');
      const limit = Math.min(PAGE_MAX, Math.max(1, Number(c.req.query('limit')) || 30));

      const where: Prisma.NotificationWhereInput = {
        userId,
        archivedAt: status === 'archived' ? { not: null } : null,
        ...(status === 'unread' ? { isRead: false } : {}),
        ...(guildId && SNOWFLAKE.test(guildId) ? { guildId } : {}),
        ...(isNotificationCategory(category) ? { category } : {}),
      };
      const [rows, unreadByGuild] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
        prisma.notification.groupBy({ by: ['guildId'], where: { userId, isRead: false, archivedAt: null }, _count: { _all: true } }),
      ]);
      const page = rows.slice(0, limit);
      return send(c, {
        notifications: page.map((n) => serialize(client, n)),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        unread: unreadByGuild.reduce((sum, g) => sum + g._count._all, 0),
        unreadByGuild: Object.fromEntries(unreadByGuild.map((g) => [g.guildId, g._count._all])),
      });
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  router.patch(`${base}/:id`, dashboardAuth, async (c) => {
    try {
      const body = await readBody<{ read?: unknown; archived?: unknown }>(c);
      const data: Prisma.NotificationUpdateManyMutationInput = {};
      if (typeof body?.read === 'boolean') data.isRead = body.read;
      // Archiver vaut lecture : une notification rangée ne doit plus compter comme non lue.
      if (typeof body?.archived === 'boolean') Object.assign(data, body.archived ? { archivedAt: new Date(), isRead: true } : { archivedAt: null });
      const { count } = await prisma.notification.updateMany({ where: { id: c.req.param('id'), userId: c.var.dashboardUser.userId }, data });
      return count ? send(c, { ok: true }) : send(c, { error: 'Notification introuvable' }, 404);
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  router.delete(`${base}/:id`, dashboardAuth, async (c) => {
    try {
      const { count } = await prisma.notification.deleteMany({ where: { id: c.req.param('id'), userId: c.var.dashboardUser.userId } });
      return count ? send(c, { ok: true }) : send(c, { error: 'Notification introuvable' }, 404);
    } catch (err) {
      return fail(c, err, FAILURE, SCOPE);
    }
  });

  return router;
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { DEFAULT_NOTIFICATION_CHANNEL_PREFS, NOTIFICATION_CATEGORIES, isNotificationCategory } from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { json, readJsonBody, type AuthClaims } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';

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

function serialize(client: Client, n: Prisma.NotificationGetPayload<object>) {
  return { ...n, guildName: client.guilds.cache.get(n.guildId)?.name ?? null };
}

export async function handleNotificationInboxRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
): Promise<boolean> {
  if (parts[2] !== 'notifications') return false;
  const method = req.method ?? 'GET';
  const userId = user.userId;

  try {
    if (parts[3] === 'preferences' && parts.length === 4) {
      if (method === 'GET') {
        const rows = await prisma.notificationPreference.findMany({ where: { userId } });
        const byCategory = new Map(rows.map((r) => [r.category, r]));
        json(res, 200, {
          categories: NOTIFICATION_CATEGORIES.map((category) => {
            const row = byCategory.get(category);
            return { category, ...(row ? { dashboard: row.dashboard, dm: row.dm, digest: row.digest } : DEFAULT_NOTIFICATION_CHANNEL_PREFS) };
          }),
        });
        return true;
      }
      if (method === 'PUT') {
        const body = await readJsonBody<{ category?: unknown; dashboard?: unknown; dm?: unknown; digest?: unknown }>(req);
        if (!body || !isNotificationCategory(body.category) || typeof body.dashboard !== 'boolean' || typeof body.dm !== 'boolean' || typeof body.digest !== 'boolean') {
          json(res, 400, { error: 'Préférence invalide' });
          return true;
        }
        // Le résumé remplace les MP : il n'a de sens qu'avec les MP actifs.
        const prefs = { dashboard: body.dashboard, dm: body.dm, digest: body.dm && body.digest };
        await prisma.notificationPreference.upsert({
          where: { userId_category: { userId, category: body.category } },
          create: { userId, category: body.category, ...prefs },
          update: prefs,
        });
        json(res, 200, { category: body.category, ...prefs });
        return true;
      }
    }

    if (parts[3] === 'read-all' && parts.length === 4 && method === 'POST') {
      const body = await readJsonBody<{ guildId?: unknown }>(req);
      const guildId = typeof body?.guildId === 'string' && SNOWFLAKE.test(body.guildId) ? body.guildId : undefined;
      const { count } = await prisma.notification.updateMany({ where: { userId, isRead: false, ...(guildId ? { guildId } : {}) }, data: { isRead: true } });
      json(res, 200, { updated: count });
      return true;
    }

    if (parts.length === 3 && method === 'GET') {
      const status = url.searchParams.get('status') ?? 'inbox';
      const guildId = url.searchParams.get('guild');
      const category = url.searchParams.get('category');
      const cursor = url.searchParams.get('cursor');
      const limit = Math.min(PAGE_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 30));

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
      json(res, 200, {
        notifications: page.map((n) => serialize(client, n)),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        unread: unreadByGuild.reduce((sum, g) => sum + g._count._all, 0),
        unreadByGuild: Object.fromEntries(unreadByGuild.map((g) => [g.guildId, g._count._all])),
      });
      return true;
    }

    if (parts.length === 4 && parts[3]) {
      const id = parts[3];
      if (method === 'PATCH') {
        const body = await readJsonBody<{ read?: unknown; archived?: unknown }>(req);
        const data: Prisma.NotificationUpdateManyMutationInput = {};
        if (typeof body?.read === 'boolean') data.isRead = body.read;
        // Archiver vaut lecture : une notification rangée ne doit plus compter comme non lue.
        if (typeof body?.archived === 'boolean') Object.assign(data, body.archived ? { archivedAt: new Date(), isRead: true } : { archivedAt: null });
        const { count } = await prisma.notification.updateMany({ where: { id, userId }, data });
        json(res, count ? 200 : 404, count ? { ok: true } : { error: 'Notification introuvable' });
        return true;
      }
      if (method === 'DELETE') {
        const { count } = await prisma.notification.deleteMany({ where: { id, userId } });
        json(res, count ? 200 : 404, count ? { ok: true } : { error: 'Notification introuvable' });
        return true;
      }
    }
  } catch (err) {
    jsonFailure(res, err, 'Erreur sur les notifications', 'NotificationInbox');
    return true;
  }

  json(res, 404, { error: 'Route introuvable' });
  return true;
}

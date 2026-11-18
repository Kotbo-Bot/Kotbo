import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import { logger } from '../../../utils/logger.js';

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

/** Au-dela, la recherche annonce « plus de N resultats » au lieu du nombre exact. */
const SEARCH_COUNT_CAP = 1000;

/**
 * Global message search - Discord/Windows-style full-text search across every
 * message the bot has recorded for a guild (when message logging is enabled).
 *
 * Routes (all under /api/dashboard/guilds/:guildId/message-logs):
 *   GET    /search?q=&channelId=&authorId=&isBot=&hasAttachment=&includeDeleted=&from=&to=&limit=&offset=&order=
 *   GET    /channels                 → distinct channels present in the logs (for filters)
 *   DELETE /:messageLogId            → delete a single logged message (admin)
 *   DELETE ?channelId=&before=       → bulk delete logged messages (admin)
 */
export function createMessageLogsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Message content can be sensitive → restrict to staff.
  const staffOnly = createMiddleware(async (c, next) => {
    const level = c.var.effectiveAccess.level;
    if (level !== 'admin' && level !== 'moderator') {
      return send(c, { error: 'Accès refusé. Réservé au staff.' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), staffOnly] as const;


  router.get(`${base}/message-logs/search`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const q = (c.req.query('q') ?? null)?.trim() || '';
      const channelId = (c.req.query('channelId') ?? null)?.trim() || '';
      const authorId = (c.req.query('authorId') ?? null)?.trim() || '';
      const isBotParam = (c.req.query('isBot') ?? null);
      const hasAttachmentParam = (c.req.query('hasAttachment') ?? null);
      const includeDeleted = (c.req.query('includeDeleted') ?? null) === 'true';
      const from = (c.req.query('from') ?? null);
      const to = (c.req.query('to') ?? null);
      const order = (c.req.query('order') ?? null) === 'asc' ? 'asc' : 'desc';
      const limit = Math.min(Math.max(parseInt((c.req.query('limit') ?? null) || '50', 10) || 50, 1), 100);
      const offset = Math.max(parseInt((c.req.query('offset') ?? null) || '0', 10) || 0, 0);

      const where: Record<string, unknown> = { guildId };
      if (q) where.content = { contains: q, mode: 'insensitive' };
      if (channelId) where.channelId = channelId;
      if (authorId) where.authorId = authorId;
      if (isBotParam === 'true') where.isBot = true;
      if (isBotParam === 'false') where.isBot = false;
      if (hasAttachmentParam === 'true') where.hasAttachment = true;
      if (!includeDeleted) where.deletedAt = null;
      if (from || to) {
        const createdAt: Record<string, Date> = {};
        if (from) { const d = new Date(from); if (!isNaN(d.getTime())) createdAt.gte = d; }
        if (to) { const d = new Date(to); if (!isNaN(d.getTime())) createdAt.lte = d; }
        if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
      }

      // Le comptage est plafonne : un count() complet parcourait toutes les
      // lignes correspondantes, soit toute la table du serveur pour une
      // recherche large, et coutait plus cher que la page elle-meme. La ligne
      // de plus demandee a findMany dit s'il reste une page, sans compter.
      const [rows, counted] = await Promise.all([
        prisma.messageLog.findMany({
          where,
          orderBy: { createdAt: order },
          skip: offset,
          take: limit + 1,
        }),
        prisma.messageLog.count({ where, take: SEARCH_COUNT_CAP + 1 }),
      ]);
      const hasMore = rows.length > limit;
      const messages = hasMore ? rows.slice(0, limit) : rows;
      const totalCapped = counted > SEARCH_COUNT_CAP;
      const total = totalCapped ? SEARCH_COUNT_CAP : counted;

      return send(c, { messages, total, totalCapped, hasMore, limit, offset });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la recherche de messages:', err);
      return fail(c, err, 'Erreur lors de la recherche de messages', 'MessageLogsAPI');
    }
  });

  // ?authorId= narrows the list to the channels a single member actually posted in.
  router.get(`${base}/message-logs/channels`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const authorId = (c.req.query('authorId') ?? null)?.trim() || '';
      const rows = await prisma.messageLog.groupBy({
        by: ['channelId', 'channelName'],
        where: authorId ? { guildId, authorId } : { guildId },
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { channelId: 'desc' } },
        take: 200,
      });
      // A renamed channel yields one row per historical name → merge them back
      // into a single entry (the dropdown is keyed by channelId) and keep the
      // most recently seen name.
      const merged = new Map<string, { channelId: string; channelName: string; count: number; lastSeen: number }>();
      for (const r of rows) {
        const lastSeen = r._max.createdAt?.getTime() ?? 0;
        const existing = merged.get(r.channelId);
        if (!existing) {
          merged.set(r.channelId, {
            channelId: r.channelId,
            channelName: r.channelName,
            count: r._count._all,
            lastSeen,
          });
          continue;
        }
        existing.count += r._count._all;
        if (lastSeen > existing.lastSeen) {
          existing.channelName = r.channelName;
          existing.lastSeen = lastSeen;
        }
      }
      const channels = [...merged.values()]
        .sort((a, b) => b.count - a.count)
        .map(({ channelId, channelName, count }) => ({ channelId, channelName, count }));
      return send(c, { channels });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la récupération des salons:', err);
      return fail(c, err, 'Erreur lors de la récupération des salons', 'MessageLogsAPI');
    }
  });

  router.get(`${base}/message-logs/stats`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [total, config] = await Promise.all([
        prisma.messageLog.count({ where: { guildId } }),
        prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            messageLoggingEnabled: true,
            messageLoggingRetentionDays: true,
            messageLoggingIgnoredChannels: true,
            messageLoggingStatus: true,
          },
        }),
      ]);
      return send(c, {
        total,
        enabled: config?.messageLoggingEnabled ?? false,
        retentionDays: config?.messageLoggingRetentionDays ?? 90,
        ignoredChannels: config?.messageLoggingIgnoredChannels ?? [],
        status: config?.messageLoggingStatus ?? null,
      });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la récupération des statistiques:', err);
      return fail(c, err, 'Erreur lors de la récupération des statistiques', 'MessageLogsAPI');
    }
  });

  router.patch(`${base}/message-logs/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    if (access.level !== 'admin') {
      return send(c, { error: 'Seuls les administrateurs peuvent modifier la configuration.' }, 403);
    }
    try {
      const body = await readBody<{
        enabled?: boolean;
        retentionDays?: number;
        ignoredChannels?: string[];
      }>(c);
      const data: Record<string, unknown> = {};
      if (typeof body?.enabled === 'boolean') data.messageLoggingEnabled = body.enabled;
      if (typeof body?.retentionDays === 'number' && Number.isFinite(body.retentionDays)) {
        data.messageLoggingRetentionDays = Math.min(Math.max(Math.floor(body.retentionDays), 0), 3650);
      }
      if (Array.isArray(body?.ignoredChannels)) {
        data.messageLoggingIgnoredChannels = body.ignoredChannels.filter((c) => typeof c === 'string');
      }
      if (Object.keys(data).length === 0) {
        return send(c, { error: 'Aucun champ valide fourni.' }, 400);
      }
      const updated = await prisma.guild.update({
        where: { id: guildId },
        data,
        select: {
          messageLoggingEnabled: true,
          messageLoggingRetentionDays: true,
          messageLoggingIgnoredChannels: true,
          messageLoggingStatus: true,
        },
      });

      // `getCachedGuild` sert les écouteurs de messages : sans purge, la liste
      // des salons ignorés ne prendrait effet qu'à l'expiration du cache.
      await cache.invalidateGuild(guildId);

      if (body?.enabled === true) {
        const { startMessageLoggingBackfill } = await import('../../../services/features/messageLoggingScraperService.js');
        void startMessageLoggingBackfill(client, guildId);
      }

      return send(c, {
        enabled: updated.messageLoggingEnabled,
        retentionDays: updated.messageLoggingRetentionDays,
        ignoredChannels: updated.messageLoggingIgnoredChannels,
        status: updated.messageLoggingStatus,
      });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la mise à jour de la configuration:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration', 'MessageLogsAPI');
    }
  });

  router.delete(`${base}/message-logs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    if (access.level !== 'admin') {
      return send(c, { error: 'Seuls les administrateurs peuvent supprimer des messages.' }, 403);
    }
    try {
      const channelId = (c.req.query('channelId') ?? null)?.trim() || '';
      const before = (c.req.query('before') ?? null);
      const where: Record<string, unknown> = { guildId };
      if (channelId) where.channelId = channelId;
      if (before) {
        const d = new Date(before);
        if (!isNaN(d.getTime())) where.createdAt = { lt: d };
      }
      // Guard against wiping the entire guild by accident: require at least one filter.
      if (!channelId && !before) {
        return send(c, { error: 'Précisez au moins un filtre (channelId ou before) pour une suppression groupée.' }, 400);
      }
      const { count } = await prisma.messageLog.deleteMany({ where });
      return send(c, { ok: true, deleted: count });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la suppression groupée:', err);
      return fail(c, err, 'Erreur lors de la suppression groupée', 'MessageLogsAPI');
    }
  });

  router.delete(`${base}/message-logs/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    if (access.level !== 'admin') {
      return send(c, { error: 'Seuls les administrateurs peuvent supprimer des messages.' }, 403);
    }
    const id = c.req.param('id');
    try {
      const log = await prisma.messageLog.findUnique({ where: { id }, select: { id: true, guildId: true } });
      if (!log || log.guildId !== guildId) {
        return send(c, { error: 'Message introuvable' }, 404);
      }
      await prisma.messageLog.delete({ where: { id } });
      return send(c, { ok: true });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la suppression du message:', err);
      return fail(c, err, 'Erreur lors de la suppression du message', 'MessageLogsAPI');
    }
  });

  return router;
}


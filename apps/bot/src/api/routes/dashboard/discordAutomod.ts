import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

/**
 * GET /api/dashboard/guilds/:guildId/automod/discord-events?days=&userId=&ruleId=&limit=&offset=
 *
 * Journal de l'AutoMod natif de Discord, avec un résumé (par règle et par jour)
 * calculé sur la même fenêtre. Les extraits de messages sont réservés au staff.
 */
export function createDiscordAutomodRouter(client: Client) {
  const router = new Hono();
  const staffOnly = createMiddleware(async (c, next) => {
    const level = c.var.effectiveAccess.level;
    if (level !== 'admin' && level !== 'moderator') {
      return send(c, { error: 'Accès refusé. Réservé au staff.' }, 403);
    }
    await next();
  });

  router.get('/api/dashboard/guilds/:guildId/automod/discord-events', ...guildRoute(client), staffOnly, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '', 10) || 7, 1), 90);
      const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '', 10) || 50, 1), 100);
      const offset = Math.max(parseInt(c.req.query('offset') ?? '', 10) || 0, 0);
      const userId = c.req.query('userId')?.trim() || undefined;
      const ruleId = c.req.query('ruleId')?.trim() || undefined;
      const since = new Date(Date.now() - days * 86_400_000);
      const where = { guildId, createdAt: { gte: since }, ...(userId && { userId }), ...(ruleId && { ruleId }) };

      const [events, total, byRule, byUser] = await Promise.all([
        prisma.discordAutoModEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
        prisma.discordAutoModEvent.count({ where }),
        prisma.discordAutoModEvent.groupBy({ by: ['ruleId', 'ruleName', 'managed'], where, _count: { _all: true }, orderBy: { _count: { ruleId: 'desc' } }, take: 20 }),
        prisma.discordAutoModEvent.groupBy({ by: ['userId'], where, _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 5 }),
      ]);

      const members = client.guilds.cache.get(guildId)?.members.cache;
      const who = (id: string) => {
        const m = members?.get(id);
        return { userId: id, name: m?.displayName ?? id, avatar: m?.displayAvatarURL({ size: 64 }) ?? null };
      };

      return send(c, {
        days,
        total,
        events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString(), user: who(e.userId) })),
        byRule: byRule.map((r) => ({ ruleId: r.ruleId, ruleName: r.ruleName, managed: r.managed, count: r._count._all })),
        topUsers: byUser.map((u) => ({ ...who(u.userId), count: u._count._all })),
      });
    } catch (err) {
      logger.error('DiscordAutomod', `Lecture impossible sur ${guildId} :`, err);
      return fail(c, err, 'Lecture du journal AutoMod impossible', 'DiscordAutomod');
    }
  });

  return router;
}

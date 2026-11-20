import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import {
  
  
  
  
  
  
  
  
  
  addMentorReport,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffManagementService.js';

export function createMentorReportsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const tutorOrAdmin = createMiddleware(async (c, next) => {
    const access = c.var.access;
    if (access.level !== 'admin' && !access.canManageTutoring) {
      return send(c, { error: 'Accès tuteur ou admin requis' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), tutorOrAdmin] as const;


  router.post(`${base}/mentor-reports`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        testingPeriodId: string;
        type: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
        content: string;
      }>(c);

      if (!body?.testingPeriodId || !body?.type || !body?.content) {
        return send(c, { error: 'testingPeriodId, type et content sont obligatoires' }, 400);
      }
      if (!(await prisma.testingPeriod.findFirst({ where: { id: body.testingPeriodId, guildId }, select: { id: true } }))) {
        return send(c, { error: 'Période de test introuvable' }, 404);
      }

      const report = await addMentorReport(
        body.testingPeriodId,
        user.userId,
        body.type,
        body.content
      );

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Rapport tuteur',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Rapport ${body.type}: ${body.testingPeriodId}`,
        channelId: null
      });

      return send(c, { report }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error adding mentor report:', err);
      return fail(c, err, "Erreur lors de l'ajout du rapport tuteur", 'StaffAPI');
    }
  });

  return router;
}


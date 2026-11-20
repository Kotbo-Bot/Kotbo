import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import {
  
  
  
  
  
  
  
  
  createTestingPeriod,
  
  endTestingPeriod,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffManagementService.js';
import * as tutoringService from '../../../../services/core/tutoringService.js';

import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
export function createTestingPeriodsRouter(client: Client) {
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


  router.get(`${base}/testing-periods`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const periods = await prisma.testingPeriod.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        include: {
          staffMember: true,
          mentor: true,
          reports: {
            orderBy: { createdAt: 'desc' },
            include: { author: true },
          },
        },
      });

      return send(c, { periods });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting testing periods:', err);
      return fail(c, err, 'Erreur lors de la récupération des périodes de test', 'StaffAPI');
    }
  });

  router.post(`${base}/testing-periods`, ...gate, async (c) => {
    const accessLevel = c.var.access;
    const guildId = c.req.param('guildId');
    if (accessLevel.level !== 'admin') {
      return send(c, { error: 'Seuls les administrateurs peuvent créer une période de test' }, 403);
    }
    try {
      const body = await readBody<{
        staffUserId: string;
        mentorId?: string;
      }>(c);

      if (!body?.staffUserId) {
        return send(c, { error: 'staffUserId est obligatoire' }, 400);
      }

      const period = await createTestingPeriod(guildId, body.staffUserId, body.mentorId);
      return send(c, { period }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error creating testing period:', err);
      return fail(c, err, 'Erreur lors de la création de la période de test', 'StaffAPI');
    }
  });

  router.patch(`${base}/testing-periods/:periodId`, ...gate, async (c) => {
    const accessLevel = c.var.access;
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const periodId = c.req.param('periodId');
    try {
      const body = await readBody<{
        status: 'PASSED' | 'FAILED';
        notes?: string;
        force?: boolean;
      }>(c);

      if (!body?.status) {
        return send(c, { error: 'status est obligatoire' }, 400);
      }
      // Un identifiant d'un autre serveur ne doit pas se clôturer d'ici.
      if (!(await prisma.testingPeriod.findFirst({ where: { id: periodId, guildId }, select: { id: true } }))) {
        return send(c, { error: 'Période de test introuvable' }, 404);
      }

      if (body.status === 'PASSED') {
        const period = await prisma.testingPeriod.findUnique({
          where: { id: periodId },
          select: { startDate: true, guildId: true }
        });

        if (period) {
          const config = await tutoringService.getTutoringConfig(period.guildId);
          const minDays = config.minTestDays || 14;
          const diffMs = Date.now() - period.startDate.getTime();
          const diffDays = diffMs / (1000 * 60 * 60 * 24);

          if (diffDays < minDays && !body.force) {
            return send(c, {
              error: `La période de test est trop courte (${Math.floor(diffDays)}j / ${minDays}j).`,
              canForce: accessLevel.level === 'admin'
            }, 403);
          }

          if (body.force && accessLevel.level !== 'admin') {
            return send(c, { error: 'Seuls les administrateurs peuvent forcer une validation précoce.' }, 403);
          }
        }
      }

      const period = await endTestingPeriod(periodId, body.status, body.notes);

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: `Fin période de test (${body.status})${body.force ? ' [FORCÉ]' : ''}`,
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Période de test: ${periodId} - ${body.status}${body.force ? ' (Bypass durée minimum)' : ''}`,
        channelId: null
      });

      return send(c, { period });
    } catch (err) {
      logger.error('StaffAPI', 'Error ending testing period:', err);
      return fail(c, err, 'Erreur lors de la fin de la période de test', 'StaffAPI');
    }
  });

  return router;
}


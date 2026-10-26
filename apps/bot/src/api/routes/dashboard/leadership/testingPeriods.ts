import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import {
  json,
  readJsonBody,
  getGuildName,
  resolveDashboardAccess,
  pushAudit,
  
  
  
  
} from '../../../shared.js';
import {
  
  
  
  
  
  
  
  
  createTestingPeriod,
  
  endTestingPeriod,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffManagementService.js';
import * as tutoringService from '../../../../services/core/tutoringService.js';

import { jsonFailure } from '../../../shared/failure.js';
export async function handleTestingPeriodRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  const method = req.method;

    // 6. Testing-periods routes
    if (parts[4] === 'testing-periods') {
      const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
      if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
        json(res, 403, { error: 'Accès tuteur ou admin requis' });
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/testing-periods
      if (method === 'GET' && !parts[5]) {
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

          json(res, 200, { periods });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting testing periods:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des périodes de test', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/testing-periods
      if (method === 'POST' && !parts[5]) {
        if (accessLevel.level !== 'admin') {
          json(res, 403, { error: 'Seuls les administrateurs peuvent créer une période de test' });
          return true;
        }
        try {
          const body = await readJsonBody<{
            staffUserId: string;
            mentorId?: string;
          }>(req);

          if (!body?.staffUserId) {
            json(res, 400, { error: 'staffUserId est obligatoire' });
            return true;
          }

          const period = await createTestingPeriod(guildId, body.staffUserId, body.mentorId);
          json(res, 201, { period });
        } catch (err) {
          logger.error('StaffAPI', 'Error creating testing period:', err);
          jsonFailure(res, err, 'Erreur lors de la création de la période de test', 'StaffAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/testing-periods/:periodId
      if (method === 'PATCH' && parts[5]) {
        const periodId = parts[5];
        try {
          const body = await readJsonBody<{
            status: 'PASSED' | 'FAILED';
            notes?: string;
            force?: boolean;
          }>(req);

          if (!body?.status) {
            json(res, 400, { error: 'status est obligatoire' });
            return true;
          }
          // Un identifiant d'un autre serveur ne doit pas se clôturer d'ici.
          if (!(await prisma.testingPeriod.findFirst({ where: { id: periodId, guildId }, select: { id: true } }))) {
            json(res, 404, { error: 'Période de test introuvable' });
            return true;
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
                json(res, 403, {
                  error: `La période de test est trop courte (${Math.floor(diffDays)}j / ${minDays}j).`,
                  canForce: accessLevel.level === 'admin'
                });
                return true;
              }

              if (body.force && accessLevel.level !== 'admin') {
                json(res, 403, { error: 'Seuls les administrateurs peuvent forcer une validation précoce.' });
                return true;
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

          json(res, 200, { period });
        } catch (err) {
          logger.error('StaffAPI', 'Error ending testing period:', err);
          jsonFailure(res, err, 'Erreur lors de la fin de la période de test', 'StaffAPI');
        }
        return true;
      }
    }

  return false;
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { jsonFailure } from '../../../shared/failure.js';
import {
  json,
  readJsonBody,
  getGuildName,
  resolveDashboardAccess,
  pushAudit,
  
  
  
  
} from '../../../shared.js';
import {
  
  
  
  
  
  
  
  
  
  addMentorReport,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffManagementService.js';

export async function handleMentorReportRoutes(
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

    // 7. Mentor-reports routes
    if (parts[4] === 'mentor-reports') {
      const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
      if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
        json(res, 403, { error: 'Accès tuteur ou admin requis' });
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/mentor-reports
      if (method === 'POST') {
        try {
          const body = await readJsonBody<{
            testingPeriodId: string;
            type: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
            content: string;
          }>(req);

          if (!body?.testingPeriodId || !body?.type || !body?.content) {
            json(res, 400, { error: 'testingPeriodId, type et content sont obligatoires' });
            return true;
          }
          if (!(await prisma.testingPeriod.findFirst({ where: { id: body.testingPeriodId, guildId }, select: { id: true } }))) {
            json(res, 404, { error: 'Période de test introuvable' });
            return true;
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

          json(res, 201, { report });
        } catch (err) {
          logger.error('StaffAPI', 'Error adding mentor report:', err);
          jsonFailure(res, err, "Erreur lors de l'ajout du rapport tuteur", 'StaffAPI');
        }
        return true;
      }
    }

  return false;
}

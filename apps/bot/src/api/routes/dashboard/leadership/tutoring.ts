import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
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
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffManagementService.js';
import * as tutoringService from '../../../../services/core/tutoringService.js';
import { TutoringItemState } from '@prisma/client';

import { jsonFailure } from '../../../shared/failure.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';
export async function handleTutoringRoutes(
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

    // 9. Tutoring routes
    if (parts[4] === 'tutoring') {
      // GET /api/dashboard/guilds/:guildId/tutoring/config
      if (method === 'GET' && parts[5] === 'config') {
        try {
          const config = await tutoringService.getTutoringConfig(guildId);
          json(res, 200, { config });
        } catch (err) {
          logger.error('TutoringAPI', 'Error getting config:', err);
          jsonFailure(res, err, 'Erreur récupération config tutorat', 'TutoringAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/tutoring/config
      if (method === 'PATCH' && parts[5] === 'config') {
        const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
        if (!accessLevel.canManageTutoring) {
          json(res, 403, { error: 'Accès tutorat requis' });
          return true;
        }

        try {
          const body = await readJsonBody<Record<string, unknown>>(req);
          const config = await tutoringService.updateTutoringConfig(guildId, (body ?? {}) as Parameters<typeof tutoringService.updateTutoringConfig>[1]);

          await pushAudit(guildId, {
            user: user.username ?? `User${user.userId}`,
            action: 'Mise à jour config tutorat',
            context: getGuildName(client, guildId),
            module: 'Tutoring',
            eventType: 'Manuel',
            details: `Intervalle: ${body?.reportIntervalDays}j, Rappels: ${body?.reminderDaysBefore}j, Min Test: ${body?.minTestDays}j`,
            channelId: null
          });

          json(res, 200, { config });
        } catch (err) {
          logger.error('TutoringAPI', 'Error updating config:', err);
          jsonFailure(res, err, 'Erreur mise à jour config tutorat', 'TutoringAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/tutoring/items[?hierarchyId=xxx|none]
      if (method === 'GET' && parts[5] === 'items') {
        try {
          const hierarchyIdParam = url.searchParams.get('hierarchyId');
          const hierarchyId = hierarchyIdParam === null ? undefined : (hierarchyIdParam === 'none' ? null : hierarchyIdParam);
          const items = await tutoringService.getTutoringItems(guildId, hierarchyId !== undefined ? { hierarchyId } : undefined);
          json(res, 200, { items });
        } catch (err) {
          logger.error('TutoringAPI', 'Error getting items:', err);
          jsonFailure(res, err, 'Erreur récupération items tutorat', 'TutoringAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/tutoring/items
      if (method === 'POST' && parts[5] === 'items') {
        const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
        if (!accessLevel.canManageTutoring) {
          json(res, 403, { error: 'Accès tutorat requis' });
          return true;
        }

        try {
          const body = await readJsonBody<{
            id?: string;
            category: string;
            title: string;
            description?: string | null;
            sortOrder?: number;
            hierarchyId?: string | null;
            grade?: string | null;
          }>(req);
          if (!body) { json(res, 400, { error: 'Corps de requête invalide.' }); return true; }
          const item = await tutoringService.upsertTutoringItem(guildId, body);

          await pushAudit(guildId, {
            user: user.username ?? `User${user.userId}`,
            action: body.id ? 'Mise à jour item tutorat' : 'Création item tutorat',
            context: getGuildName(client, guildId),
            module: 'Tutoring',
            eventType: 'Manuel',
            details: `Item: ${body.title}`,
            channelId: null
          });

          json(res, 201, { item });
        } catch (err) {
          logger.error('TutoringAPI', 'Error upserting item:', err);
          jsonFailure(res, err, 'Erreur sauvegarde item tutorat', 'TutoringAPI');
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/tutoring/items/:itemId
      if (method === 'DELETE' && parts[5] === 'items' && parts[6]) {
        const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
        if (!accessLevel.canManageTutoring) {
          json(res, 403, { error: 'Accès tutorat requis' });
          return true;
        }

        try {
          await tutoringService.deleteTutoringItem(parts[6]);
          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('TutoringAPI', 'Error deleting item:', err);
          jsonFailure(res, err, 'Erreur suppression item tutorat', 'TutoringAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/tutoring/periods
      if (method === 'POST' && parts[5] === 'periods' && !parts[6]) {
        const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
        if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
          json(res, 403, { error: 'Accès admin ou tutorat requis' });
          return true;
        }

        try {
          const body = await readJsonBody<{
            staffUserId: string;
            mentorId?: string;
            plannedDurationDays?: number;
            targetGrade?: string;
            hierarchyId?: string;
          }>(req);

          if (!body?.staffUserId) {
            json(res, 400, { error: 'staffUserId est obligatoire' });
            return true;
          }

          const period = await createTestingPeriod(
            guildId,
            body.staffUserId,
            body.mentorId || undefined,
            body.plannedDurationDays ? Number(body.plannedDurationDays) : 14,
            body.targetGrade || undefined,
            body.hierarchyId || undefined
          );

          await pushAudit(guildId, {
            user: user.username ?? `User${user.userId}`,
            action: 'Création tutorat',
            context: getGuildName(client, guildId),
            module: 'Tutoring',
            eventType: 'Manuel',
            details: `Période de test créée pour ${body.staffUserId} (Tuteur: ${body.mentorId || 'aucun'}, Grade cible: ${body.targetGrade || 'aucun'})`,
            channelId: null
          });

          json(res, 201, { period });
        } catch (err: unknown) {
          logger.error('TutoringAPI', 'Error creating period:', err);
          json(res, 500, { error: publicErrorMessage(err, 'Erreur création tutorat') });
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/tutoring/periods/:periodId
      if (method === 'DELETE' && parts[5] === 'periods' && parts[6]) {
        const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
        if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
          json(res, 403, { error: 'Accès admin ou tutorat requis' });
          return true;
        }

        try {
          await tutoringService.deleteTestingPeriod(parts[6]);

          await pushAudit(guildId, {
            user: user.username ?? `User${user.userId}`,
            action: 'Suppression tutorat',
            context: getGuildName(client, guildId),
            module: 'Tutoring',
            eventType: 'Manuel',
            details: `Période de test supprimée: ${parts[6]}`,
            channelId: null
          });

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('TutoringAPI', 'Error deleting period:', err);
          jsonFailure(res, err, 'Erreur suppression tutorat', 'TutoringAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/tutoring/tutor-dashboard
      if (method === 'GET' && parts[5] === 'tutor-dashboard') {
        try {
          const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
          const fetchAll = accessLevel.level === 'admin';
          const apprentices = await tutoringService.getTutorDashboard(guildId, user.userId, fetchAll);
          json(res, 200, { apprentices });
        } catch (err) {
          logger.error('TutoringAPI', 'Error getting tutor dashboard:', err);
          jsonFailure(res, err, 'Erreur récupération dashboard tuteur', 'TutoringAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/tutoring/apprentice-progress
      if (method === 'GET' && parts[5] === 'apprentice-progress') {
        try {
          const progress = await tutoringService.getApprenticeProgress(guildId, user.userId);
          json(res, 200, { progress });
        } catch (err) {
          logger.error('TutoringAPI', 'Error getting apprentice progress:', err);
          jsonFailure(res, err, 'Erreur récupération progression apprenti', 'TutoringAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/tutoring/checklist
      if (method === 'PATCH' && parts[5] === 'checklist') {
        try {
          const body = await readJsonBody<{
            testingPeriodId: string;
            itemId: string;
            state: TutoringItemState;
          }>(req);

          if (!body?.testingPeriodId || !body?.itemId || !body?.state) {
            json(res, 400, { error: 'Données manquantes' });
            return true;
          }

          const progress = await tutoringService.updateChecklistProgress(
            body.testingPeriodId,
            body.itemId,
            body.state,
            user.userId
          );
          json(res, 200, { progress });
        } catch (err) {
          logger.error('TutoringAPI', 'Error updating checklist:', err);
          jsonFailure(res, err, 'Erreur mise à jour checklist', 'TutoringAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/tutoring/logs
      if (method === 'POST' && parts[5] === 'logs') {
        try {
          const body = await readJsonBody<{
            testingPeriodId: string;
            content: string;
          }>(req);

          if (!body?.testingPeriodId || !body?.content) {
            json(res, 400, { error: 'Données manquantes' });
            return true;
          }

          const log = await tutoringService.addApprenticeLog(body.testingPeriodId, body.content);
          json(res, 201, { log });
        } catch (err) {
          logger.error('TutoringAPI', 'Error adding log:', err);
          jsonFailure(res, err, 'Erreur ajout carnet de bord', 'TutoringAPI');
        }
        return true;
      }
    }

    // ── REMINDERS ROUTES ──────────────────

  return false;
}

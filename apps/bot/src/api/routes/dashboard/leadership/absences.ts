import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { jsonFailure } from '../../../shared/failure.js';
import {
  json,
  readJsonBody,
  getGuildName,
  
  pushAudit,
  
  
  
  
} from '../../../shared.js';
import {
  
  getAbsences,
  createAbsence,
  deleteAbsence,
  updateAbsenceStatus,
  
  
  
  
  
  
  
  
  getStaffCalendarData,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffLeadershipService.js';
import {
  getStaffMember,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffManagementService.js';

export async function handleAbsenceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess
): Promise<boolean> {
  const method = req.method;
  const auditUser = user.username ?? `User${user.userId}`;

    // 2. Absences routes
    if (parts[4] === 'absences') {
      // GET /api/dashboard/guilds/:guildId/absences
      if (parts.length === 5 && method === 'GET') {
        try {
          const absences = await getAbsences(guildId);
          json(res, 200, { absences });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting absences:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des absences', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/absences/calendar-data
      if (parts.length === 6 && parts[5] === 'calendar-data' && method === 'GET') {
        const startStr = url.searchParams.get('start');
        const endStr = url.searchParams.get('end');
        const staffIdsStr = url.searchParams.get('staffIds');

        if (!startStr || !endStr) {
          json(res, 400, { error: 'start et end sont obligatoires' });
          return true;
        }

        try {
          const start = new Date(startStr);
          const end = new Date(endStr);
          const staffIds = staffIdsStr ? staffIdsStr.split(',') : undefined;

          if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
            json(res, 400, { error: 'La période du calendrier est invalide' });
            return true;
          }

          const data = await getStaffCalendarData(guildId, start, end, staffIds);
          json(res, 200, data);
        } catch (err) {
          logger.error('StaffAPI', `Error getting calendar data for guild ${guildId}:`, err);
          jsonFailure(res, err, 'Erreur lors de la récupération des données du calendrier', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/absences/config
      if (parts.length === 6 && parts[5] === 'config' && method === 'GET') {
        try {
          const config = await prisma.dashboardFeatureConfig.findUnique({
            where: { guildId_featureKey: { guildId, featureKey: 'absences' } },
            include: { roleAccess: true, roleAccessByRole: true, notificationTargets: true }
          });
          json(res, 200, { config });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting absence config:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération de la configuration', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/absences/config
      if (parts.length === 6 && parts[5] === 'config' && method === 'POST') {
        if (!access.canManageSettings) {
          json(res, 403, { error: 'Accès refusé' });
          return true;
        }

        try {
          const body = await readJsonBody<{
            managerRoleLevels: number[];
            webhookUrl?: string | null;
            channelId?: string | null;
            notificationRoleId?: string | null;
            notifyViaDiscordChannel?: boolean;
          }>(req);

          const currentConfig = await prisma.dashboardFeatureConfig.findUnique({
            where: { guildId_featureKey: { guildId, featureKey: 'absences' } }
          });

          const currentMetadata = (currentConfig?.metadata as Record<string, unknown>) || {};
          const updatedMetadata = {
            ...currentMetadata,
            webhookUrl: body?.webhookUrl ?? currentMetadata.webhookUrl
          };

          const config = await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey: 'absences' } },
            update: {
              featureName: 'Absences Staff',
              channelId: body?.channelId ?? undefined,
              notificationRoleId: body?.notificationRoleId ?? undefined,
              notifyViaDiscordChannel: body?.notifyViaDiscordChannel ?? undefined,
              metadata: updatedMetadata as Prisma.InputJsonValue,
            },
            create: {
              guildId,
              featureKey: 'absences',
              featureName: 'Absences Staff',
              channelId: body?.channelId ?? null,
              notificationRoleId: body?.notificationRoleId ?? null,
              notifyViaDiscordChannel: body?.notifyViaDiscordChannel ?? true,
              metadata: updatedMetadata as Prisma.InputJsonValue,
            }
          });

          await prisma.dashboardRoleAccess.deleteMany({
            where: { featureConfigId: config.id }
          });

          if (body?.managerRoleLevels && body.managerRoleLevels.length > 0) {
            await prisma.dashboardRoleAccess.createMany({
              data: body.managerRoleLevels.map(level => ({
                guildId,
                featureConfigId: config.id,
                staffRoleLevel: level,
                canModerate: true,
                canView: true
              }))
            });
          }

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error updating absence config:', err);
          jsonFailure(res, err, 'Erreur lors de la mise à jour de la configuration', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/absences
      if (parts.length === 5 && method === 'POST') {
        try {
          const body = await readJsonBody<{
            staffUserId?: string;
            type: string;
            startDate: string;
            endDate?: string;
            reason: string;
            superiorUserId: string;
            message?: string;
            confirmIndefinite?: boolean;
            notifyOnMention?: boolean;
          }>(req);

          const staffUserId = body?.staffUserId?.trim() || user.userId;
          const type = body?.type?.trim();
          const reason = body?.reason?.trim();
          const superiorUserId = body?.superiorUserId?.trim();

          if (!type || !body?.startDate || !reason || !superiorUserId) {
            json(res, 400, { error: 'type, startDate, reason et superiorUserId sont obligatoires' });
            return true;
          }

          if (!access.canManageSettings && staffUserId !== user.userId) {
            json(res, 403, { error: 'Vous ne pouvez créer des absences que pour vous-même.' });
            return true;
          }

          if (staffUserId === superiorUserId) {
            json(res, 400, { error: 'Vous devez sélectionner un supérieur différent du membre absent' });
            return true;
          }

          const staffMember = await getStaffMember(guildId, staffUserId);
          if (!staffMember) {
            json(res, 404, { error: 'Le staff ciblé est introuvable' });
            return true;
          }

          const superiorStaff = await getStaffMember(guildId, superiorUserId);
          if (!superiorStaff) {
            json(res, 400, { error: 'Le supérieur indiqué ne fait pas partie du staff' });
            return true;
          }

          const startDate = new Date(body.startDate);
          const endDate = body.endDate ? new Date(body.endDate) : undefined;

          if (Number.isNaN(startDate.getTime()) || (endDate && Number.isNaN(endDate.getTime()))) {
            json(res, 400, { error: 'Date invalide' });
            return true;
          }

          if (endDate && endDate < startDate) {
            json(res, 400, { error: 'La date de fin doit être postérieure ou égale à la date de début' });
            return true;
          }

          if (!endDate && !body.confirmIndefinite) {
            json(res, 400, { error: "Confirmez explicitement l'absence indéterminée" });
            return true;
          }

          const absence = await createAbsence({
            guildId,
            staffMemberId: staffMember.id,
            startDate,
            endDate,
            reason,
            type,
            message: body.message,
            superiorUserId,
            notifyOnMention: body?.notifyOnMention === true,
          });

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Création absence',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Absence ${absence.id} créée pour ${staffUserId} (${type})`,
            channelId: null,
          });

          json(res, 201, { absence });
        } catch (err) {
          logger.error('StaffAPI', 'Error creating absence:', err);
          jsonFailure(res, err, "Erreur lors de la création de l'absence", 'StaffAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/absences/:absenceId
      if (parts.length === 6 && method === 'PATCH') {
        const absenceId = parts[5];
        try {
          const body = await readJsonBody<{
            status: 'ACKNOWLEDGED' | 'APPROVED' | 'REJECTED' | 'CANCELED' | 'ENDED';
            note?: string;
          }>(req);

          if (!body?.status) {
            json(res, 400, { error: 'status est obligatoire' });
            return true;
          }

          const allowedStatuses = new Set(['ACKNOWLEDGED', 'APPROVED', 'REJECTED', 'CANCELED', 'ENDED']);
          if (!allowedStatuses.has(body.status)) {
            json(res, 400, { error: 'Status absence invalide' });
            return true;
          }

          const existingAbsence = await prisma.staffAbsence.findFirst({
            where: { id: absenceId, guildId },
            select: { id: true }
          });
          if (!existingAbsence) {
            json(res, 404, { error: 'Absence introuvable' });
            return true;
          }

          const absence = await updateAbsenceStatus(guildId, absenceId, body.status, user.userId, body.note);

          await pushAudit(guildId, {
            user: auditUser,
            action: `Décision absence (${body.status})`,
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Absence ${absenceId} mise au statut ${body.status}`,
            channelId: null,
          });

          json(res, 200, { absence });
        } catch (err) {
          logger.error('StaffAPI', 'Error updating absence status:', err);
          jsonFailure(res, err, "Erreur lors de la mise à jour de l'absence", 'StaffAPI');
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/absences/:absenceId
      if (parts.length === 6 && method === 'DELETE') {
        const absenceId = parts[5];
        try {
          const absence = await prisma.staffAbsence.findFirst({
            where: { id: absenceId, guildId },
            include: { staffMember: true }
          });

          if (!absence) {
            json(res, 404, { error: 'Absence introuvable' });
            return true;
          }

          const isOwner = absence.staffMember.userId === user.userId;
          if (!isOwner && !access.canManageSettings) {
            json(res, 403, { error: 'Vous ne pouvez supprimer que vos propres absences.' });
            return true;
          }

          await deleteAbsence(guildId, absenceId);

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Suppression absence',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Absence ${absenceId} supprimée`,
            channelId: null,
          });

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error deleting absence:', err);
          jsonFailure(res, err, "Erreur lors de la suppression de l'absence", 'StaffAPI');
        }
        return true;
      }
    }

  return false;
}

import { Hono } from 'hono';
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { canViewFeatureSection, getCachedFeatureAccess } from '../featureGate.js';
import { getPlanningExtras } from '../../../../services/staff/planningExtrasService.js';
import { signIcalToken } from '../../../../services/staff/planningIcal.js';
import { getJwtSecret } from '../../../shared/core.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import {
  
  getAbsences,
  createAbsence,
  deleteAbsence,
  updateAbsenceStatus,
  
  
  
  
  
  
  
  
  getStaffCalendarData,
  getAbsenceSuperiorCandidates,

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffLeadershipService.js';
import {
  getStaffMember,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffManagementService.js';

export function createAbsencesRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/absences`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const absences = await getAbsences(guildId);
      return send(c, { absences });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting absences:', err);
      return fail(c, err, 'Erreur lors de la récupération des absences', 'StaffAPI');
    }
  });

  router.get(`${base}/absences/calendar-data`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const startStr = (c.req.query('start') ?? null);
    const endStr = (c.req.query('end') ?? null);
    const staffIdsStr = (c.req.query('staffIds') ?? null);
    if (!startStr || !endStr) {
      return send(c, { error: 'start et end sont obligatoires' }, 400);
    }

    try {
      const start = new Date(startStr);
      const end = new Date(endStr);
      const staffIds = staffIdsStr ? staffIdsStr.split(',') : undefined;

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
        return send(c, { error: 'La période du calendrier est invalide' }, 400);
      }

      const data = await getStaffCalendarData(guildId, start, end, staffIds);
      return send(c, data);
    } catch (err) {
      logger.error('StaffAPI', `Error getting calendar data for guild ${guildId}:`, err);
      return fail(c, err, 'Erreur lors de la récupération des données du calendrier', 'StaffAPI');
    }
  });

  // Evenements du serveur, fins de giveaways et taches planifiees, chacun
  // seulement si le role peut deja voir la section qui les gere.
  router.get(`${base}/absences/planning-extras`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const start = new Date(c.req.query('start') ?? '');
    const end = new Date(c.req.query('end') ?? '');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start || end.getTime() - start.getTime() > 62 * 86400000) {
      return send(c, { error: 'La période du calendrier est invalide' }, 400);
    }
    try {
      const [events, giveaways, tutoring, sanctions] = await Promise.all(
        ['events', 'giveaways', 'tutoring', 'sanctions'].map((key) => canViewFeatureSection(client, guildId, access, user.userId, key)),
      );
      const extras = await getPlanningExtras(guildId, start, end, {
        events, giveaways, tutoring, sanctions, schedules: access.canManageSettings,
      });
      return send(c, extras);
    } catch (err) {
      logger.error('StaffAPI', 'Error getting planning extras:', err);
      return fail(c, err, 'Erreur lors de la récupération des événements du serveur', 'StaffAPI');
    }
  });

  // Lien d'abonnement iCal au planning de l'utilisateur connecte (membres du staff).
  router.get(`${base}/absences/ical-link`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const staffMember = await getStaffMember(guildId, user.userId);
    if (!staffMember) {
      return send(c, { error: "Tu ne fais pas partie de l'équipe staff de ce serveur." }, 403);
    }
    return send(c, { path: `/api/public/planning/${signIcalToken(guildId, user.userId, getJwtSecret())}.ics` });
  });

  // A qui l'utilisateur connecte peut declarer son absence.
  router.get(`${base}/absences/superiors`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      return send(c, { superiors: await getAbsenceSuperiorCandidates(guildId, user.userId) });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting absence superiors:', err);
      return fail(c, err, 'Erreur lors de la récupération des destinataires', 'StaffAPI');
    }
  });

  router.get(`${base}/absences/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const config = await prisma.dashboardFeatureConfig.findUnique({
        where: { guildId_featureKey: { guildId, featureKey: 'absences' } },
        include: { roleAccess: true, roleAccessByRole: true, notificationTargets: true }
      });
      return send(c, { config });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting absence config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration', 'StaffAPI');
    }
  });

  router.post(`${base}/absences/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    if (!access.canManageSettings) {
      return send(c, { error: 'Accès refusé' }, 403);
    }

    try {
      const body = await readBody<{
        managerRoleLevels: number[];
        webhookUrl?: string | null;
        channelId?: string | null;
        notificationRoleId?: string | null;
        notifyViaDiscordChannel?: boolean;
      }>(c);

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

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error updating absence config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration', 'StaffAPI');
    }
  });

  router.post(`${base}/absences`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        staffUserId?: string;
        type: string;
        startDate: string;
        endDate?: string;
        reason: string;
        superiorUserId: string;
        message?: string;
        confirmIndefinite?: boolean;
        notifyOnMention?: boolean;
      }>(c);

      const staffUserId = body?.staffUserId?.trim() || user.userId;
      const type = body?.type?.trim();
      const reason = body?.reason?.trim();
      const superiorUserId = body?.superiorUserId?.trim();

      if (!type || !body?.startDate || !reason || !superiorUserId) {
        return send(c, { error: 'type, startDate, reason et superiorUserId sont obligatoires' }, 400);
      }

      if (!access.canManageSettings && staffUserId !== user.userId) {
        return send(c, { error: 'Vous ne pouvez créer des absences que pour vous-même.' }, 403);
      }

      if (staffUserId === superiorUserId) {
        return send(c, { error: 'Vous devez sélectionner un supérieur différent du membre absent' }, 400);
      }

      const staffMember = await getStaffMember(guildId, staffUserId);
      if (!staffMember) {
        return send(c, { error: 'Le staff ciblé est introuvable' }, 404);
      }

      // Le destinataire (tuteur, fondateur ou grade egal/superieur) est
      // verifie par createAbsence : le fondateur peut ne pas etre au staff.
      const startDate = new Date(body.startDate);
      const endDate = body.endDate ? new Date(body.endDate) : undefined;

      if (Number.isNaN(startDate.getTime()) || (endDate && Number.isNaN(endDate.getTime()))) {
        return send(c, { error: 'Date invalide' }, 400);
      }

      if (endDate && endDate < startDate) {
        return send(c, { error: 'La date de fin doit être postérieure ou égale à la date de début' }, 400);
      }

      if (!endDate && !body.confirmIndefinite) {
        return send(c, { error: "Confirmez explicitement l'absence indéterminée" }, 400);
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

      return send(c, { absence }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error creating absence:', err);
      return fail(c, err, "Erreur lors de la création de l'absence", 'StaffAPI');
    }
  });

  router.patch(`${base}/absences/:absenceId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    const absenceId = c.req.param('absenceId');
    try {
      // La garde globale laisse passer ce PATCH sans élever les droits : décider
      // demande « Modérer » ou « Configurer » sur Absences, comme au centre de gestion.
      if (!access.canManageSettings) {
        const { absences } = await getCachedFeatureAccess(client, guildId, access, user.userId);
        if (!absences?.canModerate && !absences?.canConfigure) {
          return send(c, { error: "Accès refusé. Décision d'absence non autorisée." }, 403);
        }
      }

      const body = await readBody<{
        status: 'ACKNOWLEDGED' | 'APPROVED' | 'REJECTED' | 'CANCELED' | 'ENDED';
        note?: string;
      }>(c);

      if (!body?.status) {
        return send(c, { error: 'status est obligatoire' }, 400);
      }

      const allowedStatuses = new Set(['ACKNOWLEDGED', 'APPROVED', 'REJECTED', 'CANCELED', 'ENDED']);
      if (!allowedStatuses.has(body.status)) {
        return send(c, { error: 'Status absence invalide' }, 400);
      }

      const existingAbsence = await prisma.staffAbsence.findFirst({
        where: { id: absenceId, guildId },
        select: { id: true }
      });
      if (!existingAbsence) {
        return send(c, { error: 'Absence introuvable' }, 404);
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

      return send(c, { absence });
    } catch (err) {
      logger.error('StaffAPI', 'Error updating absence status:', err);
      return fail(c, err, "Erreur lors de la mise à jour de l'absence", 'StaffAPI');
    }
  });

  router.delete(`${base}/absences/:absenceId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    const absenceId = c.req.param('absenceId');
    try {
      const absence = await prisma.staffAbsence.findFirst({
        where: { id: absenceId, guildId },
        include: { staffMember: true }
      });

      if (!absence) {
        return send(c, { error: 'Absence introuvable' }, 404);
      }

      const isOwner = absence.staffMember.userId === user.userId;
      if (!isOwner && !access.canManageSettings) {
        return send(c, { error: 'Vous ne pouvez supprimer que vos propres absences.' }, 403);
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

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error deleting absence:', err);
      return fail(c, err, "Erreur lors de la suppression de l'absence", 'StaffAPI');
    }
  });

  return router;
}


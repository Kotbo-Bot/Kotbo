import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { errorMessage, errorStack } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import prisma from '../../../../utils/db.js';
import { formatGuildDateTime, formatInTimezone } from '../../../../utils/timezone.js';
import { isValidTimezone } from '@kotbo/contracts';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { getGuildName, resolveFeatureAccessMap, pushAudit } from '../../../shared.js';
import {
  
  
  
  
  
  getMeetings,
  createMeeting,
  updateMeeting,
  deleteMeeting,
  checkInMeeting,

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  MeetingValidationError,
} from '../../../../services/staff/staffLeadershipService.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';

export function createMeetingsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Écrire demande « Configurer » sur la section Réunions, supprimer « Supprimer ».
  const meetingWriteAccess = createMiddleware(async (c, next) => {
    const method = c.req.method;
    const access = c.var.effectiveAccess;
    if (method !== 'GET' && !access.canManageSettings) {
      const guildId = c.req.param('guildId')!;
      const userId = c.var.dashboardUser.userId;
      const guild = client.guilds.cache.get(guildId)
        ?? await client.guilds.fetch(guildId).catch(() => null);
      const member = guild
        ? await guild.members.fetch(userId).catch(() => null)
        : null;
      const roleIds = member ? member.roles.cache.map((role) => role.id) : [];
      const featureAccess = await resolveFeatureAccessMap(client, guildId, access, userId, roleIds);
      const meetingAccess = featureAccess.meetings;
      const isAllowed = method === 'DELETE'
        ? meetingAccess?.canDelete
        : meetingAccess?.canConfigure;

      if (!isAllowed) return send(c, { error: 'Action de gestion des réunions non autorisée.' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), meetingWriteAccess] as const;



  // Sa propre reponse a une reunion, comme les boutons du message Discord :
  // pas besoin du droit de gerer les reunions, et rien d'autre n'est touche.
  router.post(`${base}/meetings/:meetingId/rsvp`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const meetingId = c.req.param('meetingId');
    try {
      const body = await readBody<{ status?: string; note?: string }>(c);
      const status = body?.status;
      if (status !== 'PRESENT' && status !== 'EXCUSED' && status !== 'ABSENT') {
        return send(c, { error: 'Réponse invalide' }, 400);
      }
      const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
      if (status === 'EXCUSED' && !note) {
        return send(c, { error: 'Indique la raison de ton absence.' }, 400);
      }
      const [meeting, staffMember] = await Promise.all([
        prisma.staffMeeting.findFirst({ where: { id: meetingId, guildId }, select: { id: true } }),
        prisma.staffMember.findFirst({ where: { guildId, userId: user.userId }, select: { id: true } }),
      ]);
      if (!meeting) {
        return send(c, { error: 'Réunion introuvable' }, 404);
      }
      if (!staffMember) {
        return send(c, { error: "Tu ne fais pas partie de l'équipe staff de ce serveur." }, 403);
      }
      await checkInMeeting(client, meetingId, staffMember.id, status, note || undefined);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error saving meeting RSVP:', err);
      return fail(c, err, "Impossible d'enregistrer ta réponse", 'StaffAPI');
    }
  });

  router.get(`${base}/meetings`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const meetings = await getMeetings(guildId);
      return send(c, { meetings });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting meetings:', err);
      return fail(c, err, 'Erreur lors de la récupération des réunions', 'StaffAPI');
    }
  });

  router.post(`${base}/meetings`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        title: string;
        description?: string;
        scheduledAt: string;
        endedAt?: string;
        timezone?: string | null;
      }>(c);

      if (!body?.title || !body?.scheduledAt) {
        return send(c, { error: 'title et scheduledAt sont obligatoires' }, 400);
      }

      const scheduledAt = new Date(body.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        return send(c, { error: 'Date de réunion invalide' }, 400);
      }

      if (body.timezone !== undefined && body.timezone !== null && !isValidTimezone(body.timezone)) {
        return send(c, { error: 'Fuseau horaire invalide' }, 400);
      }
      const endedAt = body.endedAt ? new Date(body.endedAt) : undefined;
      if (endedAt && Number.isNaN(endedAt.getTime())) {
        return send(c, { error: 'Date de fin de reunion invalide' }, 400);
      }
      const meeting = await createMeeting(
        client,
        guildId,
        user.userId,
        body.title,
        body.description || '',
        scheduledAt,
        endedAt,
        body.timezone ?? undefined,
      );

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Création réunion',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Réunion "${body.title}" planifiée pour le ${body.timezone ? formatInTimezone(scheduledAt, body.timezone) : await formatGuildDateTime(guildId, scheduledAt)}`,
        channelId: null,
      });

      return send(c, { meeting }, 201);
    } catch (err: unknown) {
      const isValidationError = err instanceof MeetingValidationError;
      if (isValidationError) {
        logger.warn('StaffAPI', `Error creating meeting: ${err.message}`);
      } else {
        logger.error('StaffAPI', 'Error creating meeting:', err);
      }
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de la création de la réunion') }, isValidationError ? 400 : 500);
    }
  });

  router.patch(`${base}/meetings/:meetingId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const meetingId = c.req.param('meetingId');
    try {
      const body = await readBody<{
        title?: string;
        description?: string;
        scheduledAt?: string;
        endedAt?: string;
        status?: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED';
        timezone?: string | null;
      }>(c);

      const data: Record<string, unknown> = {};
      if (body?.title) data.title = body.title;
      if (body?.description !== undefined) data.description = body.description;
      if (body?.scheduledAt) data.scheduledAt = new Date(body.scheduledAt);
      if (body?.endedAt) data.endedAt = new Date(body.endedAt);
      if (body?.status) data.status = body.status;
      if (body && Object.prototype.hasOwnProperty.call(body, 'timezone')) {
        if (body.timezone !== null && !isValidTimezone(body.timezone)) {
          return send(c, { error: 'Fuseau horaire invalide' }, 400);
        }
        data.timezone = body.timezone;
      }

      const meeting = await updateMeeting(client, guildId, meetingId, data);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour réunion',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Réunion ${meetingId} mise à jour. Statut: ${meeting.status}`,
        channelId: null,
      });

      return send(c, { meeting });
    } catch (err: unknown) {
      logger.error('StaffAPI', `Error updating meeting ${meetingId}: ${errorMessage(err)}`, errorStack(err));
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de la mise à jour de la réunion') }, 500);
    }
  });

  router.delete(`${base}/meetings/:meetingId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const meetingId = c.req.param('meetingId');
    const deleteEvent = (c.req.query('deleteEvent') ?? null) === 'true';
    const deleteMessage = (c.req.query('deleteMessage') ?? null) === 'true';
    const deleteNotifications = (c.req.query('deleteNotifications') ?? null) === 'true';
    try {
      await deleteMeeting(client, guildId, meetingId, { deleteEvent, deleteMessage, deleteNotifications });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression réunion',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Réunion ${meetingId} supprimée (Event: ${deleteEvent}, Msg: ${deleteMessage}, Notif: ${deleteNotifications}).`,
        channelId: null,
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error deleting meeting:', err);
      return fail(c, err, 'Erreur lors de la suppression de la réunion', 'StaffAPI');
    }
  });

  return router;
}


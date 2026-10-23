import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { CandidatureStatus } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { jsonFailure } from '../../shared/failure.js';
import {
  json,
  readJsonBody,
  verifyRecruitmentWebhookAuth,
  isRecruitmentAutoRejectEnabled,
  recruitmentAutoRejectEnabledByGuild,
  type AuthClaims,
  type DashboardAccess,
} from '../../shared.js';
import {
  getCandidatures,
  createCandidature,
  getEligibleTutors,
  updateCandidatureStatus,
  deleteCandidature as deleteRecruitmentCandidature,
  approveCandidature,
  rejectCandidature,
  completeOral,
  assignTutor,
} from '../../../services/staff/recruitmentService.js';

/**
 * Handles Webhook candidature submissions (does NOT require user authentication)
 * POST /api/dashboard/guilds/:guildId/recruitment/candidatures
 */
export async function handleRecruitmentWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  client: Client
): Promise<boolean> {
  if (
    parts.length === 6 &&
    parts[2] === 'guilds' &&
    parts[4] === 'recruitment' &&
    parts[5] === 'candidatures' &&
    req.method === 'POST'
  ) {
    const guildId = parts[3];
    const webhookAuth = await verifyRecruitmentWebhookAuth(req, guildId);
    const webhookUser = webhookAuth.auth;
    if (!webhookUser) {
      logger.warn('RecruitmentAPI', `Webhook auth failed for guild ${guildId}: ${webhookAuth.reason}`);
      json(res, 401, { error: 'Non authentifié', reason: webhookAuth.reason });
      return true;
    }

    try {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const payload = body && typeof body === 'object' && 'data' in body
        ? ((body.data as Record<string, unknown>) ?? body)
        : (body ?? {});

      const result = await createCandidature(guildId, payload, {
        autoRejectEnabled: isRecruitmentAutoRejectEnabled(guildId),
        client,
      });
      json(res, 201, result);
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error creating candidature:', err);
      jsonFailure(res, err, 'Erreur lors de la création de la candidature', 'RecruitmentAPI');
    }
    return true;
  }

  return false;
}

/**
 * Handles authenticated recruitment endpoints
 */
export async function handleRecruitmentRoutes(
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

  if (parts[4] !== 'recruitment') {
    return false;
  }

  // GET /api/dashboard/guilds/:guildId/recruitment/candidatures - Get recruitment candidatures
  if (parts.length === 6 && parts[5] === 'candidatures' && method === 'GET') {
    try {
      const candidatures = await getCandidatures(guildId);
      json(res, 200, { candidatures });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error getting candidatures:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des candidatures', 'RecruitmentAPI');
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/recruitment/config - Update recruitment configuration
  if (parts.length === 6 && parts[5] === 'config' && method === 'PATCH') {
    try {
      const body = await readJsonBody<{
        recruitmentCategoryId?: string | null;
        recruitmentLogChannelId?: string | null;
        recruitmentAutoRejectEnabled?: boolean;
      }>(req);

      const recruitmentCategoryId = body?.recruitmentCategoryId?.trim() || null;
      const recruitmentLogChannelId = body?.recruitmentLogChannelId?.trim() || null;

      await prisma.guild.update({
        where: { id: guildId },
        data: {
          recruitmentCategoryId,
          recruitmentLogChannelId,
        }
      });

      if (typeof body?.recruitmentAutoRejectEnabled === 'boolean') {
        recruitmentAutoRejectEnabledByGuild.set(guildId, body.recruitmentAutoRejectEnabled);
      }

      json(res, 200, {
        ok: true,
        recruitmentCategoryId,
        recruitmentLogChannelId,
        recruitmentAutoRejectEnabled: isRecruitmentAutoRejectEnabled(guildId),
      });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error updating recruitment config:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour de la configuration de recrutement', 'RecruitmentAPI');
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/recruitment/candidatures/:id - Update candidature workflow
  if (parts.length === 7 && parts[5] === 'candidatures' && method === 'PATCH') {
    const candidatureId = parts[6];

    const candidature = await prisma.recruitmentCandidature.findFirst({
      where: { id: candidatureId, guildId },
      select: { id: true }
    });

    if (!candidature) {
      json(res, 404, { error: 'Candidature introuvable pour ce serveur.' });
      return true;
    }

    const body = await readJsonBody<{
      action?: string;
      status?: string;
      notes?: string;
      reason?: string;
      discordUserId?: string;
      tutorUserId?: string;
      hierarchyId?: string;
      hierarchyGrade?: string;
    }>(req);

    const action = body?.action;

    try {
      if (action === 'status_update') {
        const nextStatus = body?.status;
        if (!nextStatus || !Object.values(CandidatureStatus).includes(nextStatus as CandidatureStatus)) {
          json(res, 400, { error: 'Statut candidature invalide.' });
          return true;
        }

        await updateCandidatureStatus(candidatureId, nextStatus as CandidatureStatus, body?.notes);
        json(res, 200, { ok: true });
        return true;
      }

      if (action === 'approve') {
        const discordUserId = body?.discordUserId?.trim();
        if (!discordUserId) {
          json(res, 400, { error: 'discordUserId est requis pour valider une candidature.' });
          return true;
        }

        await approveCandidature(client, guildId, candidatureId, discordUserId, user.userId);
        json(res, 200, { ok: true });
        return true;
      }

      if (action === 'reject') {
        await rejectCandidature(client, guildId, candidatureId, body?.reason?.trim(), user.userId);
        json(res, 200, { ok: true });
        return true;
      }

      if (action === 'oral_pass') {
        await completeOral(
          client,
          guildId,
          candidatureId,
          'PASSED',
          body?.reason?.trim(),
          user.userId,
          body?.hierarchyId,
          body?.hierarchyGrade
        );
        json(res, 200, { ok: true });
        return true;
      }

      if (action === 'oral_fail') {
        await completeOral(client, guildId, candidatureId, 'FAILED', body?.reason?.trim(), user.userId);
        json(res, 200, { ok: true });
        return true;
      }

      if (action === 'assign_tutor') {
        const tutorUserId = body?.tutorUserId?.trim();
        if (!tutorUserId) {
          json(res, 400, { error: 'tutorUserId est requis pour assigner un tuteur.' });
          return true;
        }

        await assignTutor(candidatureId, tutorUserId);
        json(res, 200, { ok: true });
        return true;
      }

      json(res, 400, { error: 'Action de candidature non reconnue.' });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error updating candidature:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour de la candidature', 'RecruitmentAPI');
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/recruitment/candidatures/:id - Delete candidature
  if (parts.length === 7 && parts[5] === 'candidatures' && method === 'DELETE') {
    const candidatureId = parts[6];

    const candidature = await prisma.recruitmentCandidature.findFirst({
      where: { id: candidatureId, guildId },
      select: { id: true }
    });

    if (!candidature) {
      json(res, 404, { error: 'Candidature introuvable pour ce serveur.' });
      return true;
    }

    try {
      await deleteRecruitmentCandidature(candidatureId);
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error deleting candidature:', err);
      jsonFailure(res, err, 'Erreur lors de la suppression de la candidature', 'RecruitmentAPI');
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/recruitment/tutors - Get eligible tutors
  if (parts.length === 6 && parts[5] === 'tutors' && method === 'GET') {
    try {
      const tutors = await getEligibleTutors(guildId);
      json(res, 200, { tutors });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error getting eligible tutors:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des tuteurs éligibles', 'RecruitmentAPI');
    }
    return true;
  }

  return false;
}

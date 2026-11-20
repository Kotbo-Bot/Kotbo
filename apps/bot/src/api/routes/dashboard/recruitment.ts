import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import { CandidatureStatus } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { verifyRecruitmentWebhookAuth, isRecruitmentAutoRejectEnabled, recruitmentAutoRejectEnabledByGuild } from '../../shared.js';
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
import { deleteRecruitmentPanel, saveRecruitmentPanel } from '../../../services/staff/recruitmentPanelService.js';

/**
 * Handles authenticated recruitment endpoints
 */
export function createRecruitmentRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  /**
   * Candidature envoyée par le formulaire (Google Apps Script) : pas de session,
   * une clé d'API du formulaire ou un jeton à la place.
   */
  router.post(`${base}/recruitment/candidatures`, async (c) => {
    const guildId = c.req.param('guildId')!;
    const webhookAuth = await verifyRecruitmentWebhookAuth({ headers: c.req.header() }, guildId);
    if (!webhookAuth.auth) {
      logger.warn('RecruitmentAPI', `Webhook auth failed for guild ${guildId}: ${webhookAuth.reason}`);
      return send(c, { error: 'Non authentifié', reason: webhookAuth.reason }, 401);
    }

    try {
      const body = await readBody(c);
      const payload = body && typeof body === 'object' && 'data' in body
        ? ((body.data as Record<string, unknown>) ?? body)
        : (body ?? {});

      const result = await createCandidature(guildId, payload, {
        autoRejectEnabled: isRecruitmentAutoRejectEnabled(guildId),
        client,
      });
      return send(c, result, 201);
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error creating candidature:', err);
      return fail(c, err, 'Erreur lors de la création de la candidature', 'RecruitmentAPI');
    }
  });

  // Panneaux « statut des recrutements »
  const panelFailure = (c: Context, err: unknown) => {
    logger.error('RecruitmentAPI', 'Error on recruitment panel:', err);
    return fail(c, err, 'Erreur sur le panneau de recrutement', 'RecruitmentAPI');
  };

  router.get(`${base}/recruitment/panels`, ...gate, async (c) => {
    try {
      const panels = await prisma.recruitmentPanel.findMany({ where: { guildId: c.req.param('guildId') }, orderBy: { createdAt: 'asc' } });
      return send(c, { panels });
    } catch (err) {
      return panelFailure(c, err);
    }
  });

  router.post(`${base}/recruitment/panels`, ...gate, async (c) => {
    try {
      const panel = await saveRecruitmentPanel(c.req.param('guildId'), (await readBody(c)) ?? {});
      return send(c, { panel }, 201);
    } catch (err) {
      return panelFailure(c, err);
    }
  });

  router.patch(`${base}/recruitment/panels/:panelId`, ...gate, async (c) => {
    try {
      const panel = await saveRecruitmentPanel(c.req.param('guildId'), (await readBody(c)) ?? {}, c.req.param('panelId'));
      return send(c, { panel });
    } catch (err) {
      return panelFailure(c, err);
    }
  });

  router.delete(`${base}/recruitment/panels/:panelId`, ...gate, async (c) => {
    try {
      const deleted = await deleteRecruitmentPanel(c.req.param('guildId'), c.req.param('panelId'));
      return deleted ? send(c, { ok: true }) : send(c, { error: 'Panneau introuvable' }, 404);
    } catch (err) {
      return panelFailure(c, err);
    }
  });


  router.get(`${base}/recruitment/candidatures`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const candidatures = await getCandidatures(guildId);
      return send(c, { candidatures });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error getting candidatures:', err);
      return fail(c, err, 'Erreur lors de la récupération des candidatures', 'RecruitmentAPI');
    }
  });

  router.patch(`${base}/recruitment/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{
        recruitmentCategoryId?: string | null;
        recruitmentLogChannelId?: string | null;
        recruitmentAutoRejectEnabled?: boolean;
      }>(c);

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

      return send(c, {
        ok: true,
        recruitmentCategoryId,
        recruitmentLogChannelId,
        recruitmentAutoRejectEnabled: isRecruitmentAutoRejectEnabled(guildId),
      });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error updating recruitment config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration de recrutement', 'RecruitmentAPI');
    }
  });

  router.patch(`${base}/recruitment/candidatures/:candidatureId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const candidatureId = c.req.param('candidatureId');

    const candidature = await prisma.recruitmentCandidature.findFirst({
      where: { id: candidatureId, guildId },
      select: { id: true }
    });

    if (!candidature) {
      return send(c, { error: 'Candidature introuvable pour ce serveur.' }, 404);
    }

    const body = await readBody<{
      action?: string;
      status?: string;
      notes?: string;
      reason?: string;
      discordUserId?: string;
      tutorUserId?: string;
      hierarchyId?: string;
      hierarchyGrade?: string;
    }>(c);

    const action = body?.action;
    try {
      if (action === 'status_update') {
        const nextStatus = body?.status;
        if (!nextStatus || !Object.values(CandidatureStatus).includes(nextStatus as CandidatureStatus)) {
          return send(c, { error: 'Statut candidature invalide.' }, 400);
        }

        await updateCandidatureStatus(candidatureId, nextStatus as CandidatureStatus, body?.notes);
        return send(c, { ok: true });
      }

      if (action === 'approve') {
        const discordUserId = body?.discordUserId?.trim();
        if (!discordUserId) {
          return send(c, { error: 'discordUserId est requis pour valider une candidature.' }, 400);
        }

        await approveCandidature(client, guildId, candidatureId, discordUserId, user.userId);
        return send(c, { ok: true });
      }

      if (action === 'reject') {
        await rejectCandidature(client, guildId, candidatureId, body?.reason?.trim(), user.userId);
        return send(c, { ok: true });
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
        return send(c, { ok: true });
      }

      if (action === 'oral_fail') {
        await completeOral(client, guildId, candidatureId, 'FAILED', body?.reason?.trim(), user.userId);
        return send(c, { ok: true });
      }

      if (action === 'assign_tutor') {
        const tutorUserId = body?.tutorUserId?.trim();
        if (!tutorUserId) {
          return send(c, { error: 'tutorUserId est requis pour assigner un tuteur.' }, 400);
        }

        await assignTutor(candidatureId, tutorUserId);
        return send(c, { ok: true });
      }

      return send(c, { error: 'Action de candidature non reconnue.' }, 400);
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error updating candidature:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la candidature', 'RecruitmentAPI');
    }
  });

  router.delete(`${base}/recruitment/candidatures/:candidatureId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const candidatureId = c.req.param('candidatureId');

    const candidature = await prisma.recruitmentCandidature.findFirst({
      where: { id: candidatureId, guildId },
      select: { id: true }
    });

    if (!candidature) {
      return send(c, { error: 'Candidature introuvable pour ce serveur.' }, 404);
    }

    try {
      await deleteRecruitmentCandidature(candidatureId);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error deleting candidature:', err);
      return fail(c, err, 'Erreur lors de la suppression de la candidature', 'RecruitmentAPI');
    }
  });

  router.get(`${base}/recruitment/tutors`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const tutors = await getEligibleTutors(guildId);
      return send(c, { tutors });
    } catch (err) {
      logger.error('RecruitmentAPI', 'Error getting eligible tutors:', err);
      return fail(c, err, 'Erreur lors de la récupération des tuteurs éligibles', 'RecruitmentAPI');
    }
  });

  return router;
}


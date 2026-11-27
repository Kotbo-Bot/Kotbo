/**
 * Accès d'urgence de la cellule de suivi : demande, seconde clé, arrêt
 * anticipé et journal des accès. Tout est tracé au journal d'audit.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import {
  BREAK_GLASS_HOURS,
  BREAK_GLASS_REQUEST_HOURS,
  endBreakGlassError,
  decideBreakGlassError,
} from '../../../../services/staff/wellbeingAccessPolicy.js';
import { sendWellbeingAlert } from '../../../../services/staff/wellbeingAlerts.js';
import { bodyText } from '../../../../utils/bodyText.js';
import { actorName, audit, HOUR_MS, resolveWellbeingRole, SNOWFLAKE_RE } from './wellbeingShared.js';

/** Id d'un dossier de ce serveur, ou null : un id inconnu n'entre pas au journal. */
async function caseIdOfGuild(guildId: string, caseId: unknown): Promise<string | null> {
  const id = bodyText(caseId, 64);
  if (!id) return null;
  const found = await prisma.wellbeingCase.findFirst({ where: { id, guildId }, select: { id: true } });
  return found?.id ?? null;
}

export function createWellbeingBreakGlassRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  // Accès exceptionnel et journalisé (« break-glass ») pour la direction.
  router.post(`${base}/break-glass`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.isDirector) {
        return send(c, { error: "Seule la direction peut déclencher un accès d'urgence." }, 403);
      }
      const body = await readBody<{ reason?: string; caseId?: string; subjectUserId?: string }>(c);
      const reason = bodyText(body?.reason, 500);
      if ((state.config?.requireReason ?? true) && reason.length < 8) {
        return send(c, { error: 'Un motif détaillé (8 caractères min.) est obligatoire pour cet accès journalisé.' }, 400);
      }
      const subjectUserId = bodyText(body?.subjectUserId, 20);
      const needsApproval = state.config?.breakGlassApproval === true;
      const expiresAt = new Date(Date.now() + (needsApproval ? BREAK_GLASS_REQUEST_HOURS : BREAK_GLASS_HOURS) * HOUR_MS);

      const log = await prisma.wellbeingBreakGlassLog.create({
        data: {
          guildId,
          actorId: user.userId,
          actorName: actorName(c),
          caseId: await caseIdOfGuild(guildId, body?.caseId),
          subjectUserId: SNOWFLAKE_RE.test(subjectUserId) ? subjectUserId : null,
          reason: reason || 'Enquête interne (sans motif requis)',
          status: needsApproval ? 'PENDING' : 'APPROVED',
          expiresAt,
        },
      });

      const scope = log.subjectUserId ? ` — limité au membre ${log.subjectUserId}` : '';
      await audit(client, c, guildId, 'Break-glass Cellule de suivi', needsApproval
        ? `Accès exceptionnel demandé, en attente de validation${scope} — Motif : ${log.reason}`
        : `Accès exceptionnel activé jusqu'à ${expiresAt.toISOString()}${scope} — Motif : ${log.reason}`, 'Sécurité');

      void sendWellbeingAlert(client, guildId, state.config, 'BREAK_GLASS', {
        actorId: user.userId,
        reason: log.reason,
        ...(needsApproval ? { stage: 'requested' as const } : { expiresAt }),
      });

      return send(c, { ok: true, pending: needsApproval, expiresAt: expiresAt.toISOString(), log }, 201);
    } catch (err) {
      logger.error('WellbeingAPI', 'Error activating break-glass:', err);
      return fail(c, err, "Erreur lors de l'activation de l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  // Seconde clé : une autre personne de la direction ou de la cellule valide ou refuse.
  router.post(`${base}/break-glass/:logId/decide`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      const log = await prisma.wellbeingBreakGlassLog.findFirst({ where: { id: c.req.param('logId'), guildId } });
      if (!log) return send(c, { error: 'Demande introuvable.' }, 404);
      const now = new Date();
      const error = decideBreakGlassError(log, { userId: user.userId, canDecide: state.isDirector || state.isTeamMember }, now);
      if (error === 'forbidden') return send(c, { error: 'Réservé à la direction et à la cellule.' }, 403);
      if (error === 'self') return send(c, { error: 'Une autre personne doit valider votre demande.' }, 403);
      if (error === 'closed') return send(c, { error: 'Cette demande est déjà traitée ou a expiré.' }, 409);

      const body = await readBody<{ approve?: boolean }>(c);
      const approve = body?.approve === true;
      const expiresAt = approve ? new Date(now.getTime() + BREAK_GLASS_HOURS * HOUR_MS) : now;
      const updated = await prisma.wellbeingBreakGlassLog.update({
        where: { id: log.id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          approvedById: user.userId,
          approvedByName: actorName(c),
          decidedAt: now,
          expiresAt,
        },
      });

      await audit(client, c, guildId, 'Break-glass Cellule de suivi', approve
        ? `Accès exceptionnel de ${log.actorName} validé jusqu'à ${expiresAt.toISOString()}`
        : `Accès exceptionnel de ${log.actorName} refusé`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'BREAK_GLASS', {
        actorId: user.userId,
        stage: approve ? 'approved' : 'rejected',
        expiresAt,
      }, [log.actorId]);

      return send(c, { log: updated });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error deciding break-glass:', err);
      return fail(c, err, "Erreur lors de la décision sur l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  // Arrêt avant échéance : l'auteur coupe son accès (ou annule sa demande),
  // la cellule et le propriétaire révoquent celui des autres.
  router.post(`${base}/break-glass/:logId/end`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      const log = await prisma.wellbeingBreakGlassLog.findFirst({ where: { id: c.req.param('logId'), guildId } });
      if (!log) return send(c, { error: 'Accès introuvable.' }, 404);
      const now = new Date();
      const error = endBreakGlassError(log, { userId: user.userId, isTeamMember: state.isTeamMember, isOwner: state.canConfigure }, now);
      if (error === 'forbidden') return send(c, { error: "Seuls l'auteur, la cellule et le propriétaire peuvent arrêter cet accès." }, 403);
      if (error === 'closed') return send(c, { error: 'Cet accès est déjà terminé ou a expiré.' }, 409);

      const updated = await prisma.wellbeingBreakGlassLog.update({
        where: { id: log.id },
        data: { status: 'ENDED', endedById: user.userId, endedByName: actorName(c), endedAt: now, expiresAt: now },
      });
      const own = log.actorId === user.userId;
      await audit(client, c, guildId, 'Break-glass Cellule de suivi', own
        ? `Accès exceptionnel de ${log.actorName} arrêté par son auteur`
        : `Accès exceptionnel de ${log.actorName} révoqué`, 'Sécurité');
      void sendWellbeingAlert(client, guildId, state.config, 'BREAK_GLASS', { actorId: user.userId, stage: 'ended' },
        own ? [] : [log.actorId]);
      return send(c, { log: updated });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error ending break-glass:', err);
      return fail(c, err, "Erreur lors de l'arrêt de l'accès d'urgence.", 'WellbeingAPI');
    }
  });

  router.get(`${base}/break-glass-logs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.isDirector && !state.isTeamMember) return send(c, { error: 'Accès refusé.' }, 403);
      const logs = await prisma.wellbeingBreakGlassLog.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return send(c, { logs });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error fetching break-glass logs:', err);
      return fail(c, err, 'Erreur lors du chargement du journal.', 'WellbeingAPI');
    }
  });

  return router;
}

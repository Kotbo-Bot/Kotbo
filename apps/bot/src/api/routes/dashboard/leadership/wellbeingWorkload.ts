/**
 * Charge de la cellule de suivi : mes échéances, bilan, membres de la
 * cellule et référent proposé. Des chiffres, jamais de contenu.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { fail, guildRoute, send } from '../../../hono/dashboard/kit.js';
import { caseVisibilityWhere } from '../../../../services/staff/wellbeingCasePolicy.js';
import { agendaItems, wellbeingCellStats, referentLoad, suggestAssignee } from '../../../../services/staff/wellbeingWorkloadPolicy.js';
import { PULSE_WEEKS_SHOWN, pulseSummary } from '../../../../services/staff/wellbeingWatchPolicy.js';
import { profileStats } from '../../../../services/staff/wellbeingProfilePolicy.js';
import { cleanBoardColumns, stageCounts } from '../../../../services/staff/wellbeingBoardPolicy.js';
import { customizationOf, newColumnId, resolveWellbeingRole, SNOWFLAKE_RE, teamIdsOf } from './wellbeingShared.js';
import { tagCounts } from '../../../../services/staff/wellbeingCustomPolicy.js';

export function createWellbeingWorkloadRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/wellbeing';
  const gate = guildRoute(client);

  // Mes échéances : suivis et tâches des 7 prochains jours, sans titre ni contenu.
  router.get(`${base}/agenda`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { items: [] });
      const cases = await prisma.wellbeingCase.findMany({
        where: { AND: [caseVisibilityWhere(guildId, user.userId), { status: { not: 'CLOSED' } }] },
        select: {
          id: true, status: true, assigneeId: true, reviewAt: true,
          tasks: { where: { doneAt: null, dueAt: { not: null } }, select: { caseId: true, assigneeId: true, dueAt: true, doneAt: true } },
        },
      });
      const items = agendaItems(cases, cases.flatMap((item) => item.tasks), user.userId, new Date());
      return send(c, { items: items.map((item) => ({ ...item, dueAt: item.dueAt.toISOString() })) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error loading agenda:', err);
      return fail(c, err, 'Erreur lors du chargement des échéances.', 'WellbeingAPI');
    }
  });

  // Bilan sans contenu : chiffres de la cellule, lisibles par la direction aussi.
  router.get(`${base}/stats`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.isTeamMember && !state.isDirector) return send(c, { error: 'Accès refusé.' }, 403);
      const [cases, pulseWeeks, profileNotes] = await Promise.all([
        prisma.wellbeingCase.findMany({
          where: caseVisibilityWhere(guildId, user.userId),
          select: {
            status: true, severity: true, category: true, source: true, assigneeId: true, createdAt: true, closedReason: true, stage: true, tagIds: true,
            events: { where: { type: { in: ['STATUS', 'ASSIGNEE'] } }, select: { type: true, toValue: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
          },
        }),
        prisma.wellbeingPulseWeek.findMany({ where: { guildId }, orderBy: { week: 'desc' }, take: PULSE_WEEKS_SHOWN }),
        // Sa propre fiche n'entre pas dans ses chiffres, comme ses dossiers.
        prisma.wellbeingProfileNote.findMany({
          where: { profile: { guildId, subjectUserId: { not: user.userId } } },
          select: { profileId: true, expiresAt: true, sensitive: true },
        }),
      ]);
      const now = new Date();
      return send(c, {
        stats: wellbeingCellStats(cases, now),
        profiles: profileStats(profileNotes, now),
        stages: stageCounts(cases, cleanBoardColumns(state.config?.boardColumns, newColumnId)),
        tags: tagCounts(cases, customizationOf(state.config).tags),
        load: referentLoad(cases, await teamIdsOf(state)),
        pulse: state.config?.pulseEnabled || pulseWeeks.length > 0 ? pulseSummary(pulseWeeks) : null,
      });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error computing stats:', err);
      return fail(c, err, 'Erreur lors du calcul du bilan.', 'WellbeingAPI');
    }
  });

  // Membres de la cellule, pour les listes de la page (référent, collègues à prévenir) :
  // on ne propose que des personnes que le bot acceptera.
  router.get(`${base}/team`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const state = await resolveWellbeingRole(client, guildId, c.var.dashboardUser.userId);
      if (!state.canWriteCases) return send(c, { error: 'Réservé à la cellule de suivi.' }, 403);
      const members = (await teamIdsOf(state)).map((id) => {
        const member = state.discordGuild?.members.cache.get(id);
        return { id, name: member?.displayName ?? member?.user.username ?? id };
      });
      return send(c, { members });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error listing team:', err);
      return fail(c, err, 'Erreur lors du chargement de la cellule.', 'WellbeingAPI');
    }
  });

  // Référent proposé à la création d'un dossier : le membre le moins chargé.
  router.get(`${base}/assignee-suggestion`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const state = await resolveWellbeingRole(client, guildId, user.userId);
      if (!state.canWriteCases) return send(c, { userId: null });
      const subject = c.req.query('subjectUserId');
      const cases = await prisma.wellbeingCase.findMany({
        where: { guildId, deletedAt: null, status: { not: 'CLOSED' } },
        select: { status: true, severity: true, assigneeId: true },
      });
      const exclude = subject && SNOWFLAKE_RE.test(subject) ? [subject] : [];
      return send(c, { userId: suggestAssignee(referentLoad(cases, await teamIdsOf(state)), exclude) });
    } catch (err) {
      logger.error('WellbeingAPI', 'Error suggesting assignee:', err);
      return fail(c, err, 'Erreur lors de la suggestion du référent.', 'WellbeingAPI');
    }
  });

  return router;
}

/** Routes dashboard du module `daily-algo-weeks`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { closeDailyAlgoWeek, getCurrentDailyAlgoWeek, getDailyAlgoWeekHistory } from '../../../../services/progression/dailyAlgoWeekService.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

/** Semaine compétitive Daily Algo. */
export function createDailyAlgoWeeksRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/daily-algo-weeks';
  const gate = guildRoute(client);

  router.get(`${base}/current`, ...gate, async (c) => {
    if (!c.var.effectiveAccess.canViewDashboard) return send(c, { error: 'Accès refusé.' }, 403);
    try {
      return send(c, { week: await getCurrentDailyAlgoWeek(c.req.param('guildId')) });
    } catch (err) {
      logger.error('DailyAlgoAPI', 'Erreur lors de la récupération de la semaine en cours:', err);
      return fail(c, err, 'Erreur lors de la récupération de la semaine en cours', 'DailyAlgoAPI');
    }
  });

  router.get(`${base}/history`, ...gate, async (c) => {
    if (!c.var.effectiveAccess.canViewDashboard) return send(c, { error: 'Accès refusé.' }, 403);
    try {
      const parsedLimit = Number(c.req.query('limit') ?? '10');
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
      return send(c, { weeks: await getDailyAlgoWeekHistory(c.req.param('guildId'), limit) });
    } catch (err) {
      logger.error('DailyAlgoAPI', 'Erreur lors de la récupération de l\'historique des semaines:', err);
      return fail(c, err, 'Erreur lors de la récupération de l\'historique des semaines', 'DailyAlgoAPI');
    }
  });

  // Clôture manuelle : « finir la semaine plus tôt ». Verse les récompenses
  // immédiatement, sans attendre le cron du lundi. Geste non annulable, donc
  // réservé à ceux qui peuvent configurer le serveur.
  router.post(`${base}/close`, ...gate, async (c) => {
    if (!c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Seuls les administrateurs peuvent clôturer une semaine.' }, 403);
    }
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ weekKey?: unknown }>(c);
      const weekKey = typeof body?.weekKey === 'string' && body.weekKey.trim().length > 0
        ? body.weekKey.trim()
        : undefined;

      const result = await closeDailyAlgoWeek({
        client,
        guildId,
        weekKey,
        closedById: c.var.dashboardUser.userId,
      });

      if (result.status === 'disabled') {
        return send(c, { error: "Le Daily Algo n'est pas activé sur ce serveur." }, 400);
      }
      if (result.status === 'already-closed') {
        return send(c, {
          error: `La semaine ${result.weekKey} est déjà clôturée et rien de nouveau n'est à rattraper.`,
          weekKey: result.weekKey,
        }, 409);
      }

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Clôture manuelle de la semaine Daily Algo',
        context: getGuildName(client, guildId),
        module: 'Daily Algo',
        eventType: 'Manuel',
        details: `Semaine ${result.weekKey} clôturée : ${result.participants} participant(s), ${result.xpGranted} XP versée, ${result.rolesAssigned} rôle(s) attribué(s).`,
        channelId: null,
      });

      // Pas de broadcast ici : closeDailyAlgoWeek le fait deja, pour le cron
      // du lundi comme pour cette cloture manuelle.
      return send(c, { ok: true, ...result });
    } catch (err) {
      logger.error('DailyAlgoAPI', 'Erreur lors de la clôture manuelle de la semaine:', err);
      return fail(c, err, 'Erreur lors de la clôture de la semaine', 'DailyAlgoAPI');
    }
  });

  return router;
}

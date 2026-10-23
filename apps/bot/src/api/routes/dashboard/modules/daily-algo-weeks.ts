/** Routes dashboard du module `daily-algo-weeks`. */
import { closeDailyAlgoWeek, getCurrentDailyAlgoWeek, getDailyAlgoWeekHistory } from '../../../../services/progression/dailyAlgoWeekService.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

import { jsonFailure } from '../../../shared/failure.js';
export async function handleDailyAlgoWeeksRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, url, client, user, guildId, access, method, auditUser, moduleKey } = ctx;

  // Semaine compétitive Daily Algo
  if (moduleKey === 'daily-algo-weeks') {
    // GET /api/dashboard/guilds/:guildId/daily-algo-weeks/current
    if (parts.length === 6 && parts[5] === 'current' && method === 'GET') {
      if (!access.canViewDashboard) {
        json(res, 403, { error: 'Accès refusé.' });
        return true;
      }

      try {
        const week = await getCurrentDailyAlgoWeek(guildId);
        json(res, 200, { week });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la récupération de la semaine en cours:', err);
        jsonFailure(res, err, 'Erreur lors de la récupération de la semaine en cours', 'DailyAlgoAPI');
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/daily-algo-weeks/history
    if (parts.length === 6 && parts[5] === 'history' && method === 'GET') {
      if (!access.canViewDashboard) {
        json(res, 403, { error: 'Accès refusé.' });
        return true;
      }

      try {
        const parsedLimit = Number(url.searchParams.get('limit') ?? '10');
        const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
        const weeks = await getDailyAlgoWeekHistory(guildId, limit);
        json(res, 200, { weeks });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la récupération de l\'historique des semaines:', err);
        jsonFailure(res, err, 'Erreur lors de la récupération de l\'historique des semaines', 'DailyAlgoAPI');
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/daily-algo-weeks/close
    // Clôture manuelle : « finir la semaine plus tôt ». Verse les récompenses
    // immédiatement, sans attendre le cron du lundi. Geste non annulable, donc
    // réservé à ceux qui peuvent configurer le serveur.
    if (parts.length === 6 && parts[5] === 'close' && method === 'POST') {
      if (!access.canManageSettings) {
        json(res, 403, { error: 'Seuls les administrateurs peuvent clôturer une semaine.' });
        return true;
      }

      try {
        const body = await readJsonBody<{ weekKey?: unknown }>(req);
        const weekKey = typeof body?.weekKey === 'string' && body.weekKey.trim().length > 0
          ? body.weekKey.trim()
          : undefined;

        const result = await closeDailyAlgoWeek({
          client,
          guildId,
          weekKey,
          closedById: user.userId,
        });

        if (result.status === 'disabled') {
          json(res, 400, { error: "Le Daily Algo n'est pas activé sur ce serveur." });
          return true;
        }

        if (result.status === 'already-closed') {
          json(res, 409, {
            error: `La semaine ${result.weekKey} est déjà clôturée et rien de nouveau n'est à rattraper.`,
            weekKey: result.weekKey,
          });
          return true;
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Clôture manuelle de la semaine Daily Algo',
          context: getGuildName(client, guildId),
          module: 'Daily Algo',
          eventType: 'Manuel',
          details: `Semaine ${result.weekKey} clôturée : ${result.participants} participant(s), ${result.xpGranted} XP versée, ${result.rolesAssigned} rôle(s) attribué(s).`,
          channelId: null,
        });

        // Pas de broadcast ici : closeDailyAlgoWeek le fait deja, pour le cron
        // du lundi comme pour cette cloture manuelle.
        json(res, 200, { ok: true, ...result });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la clôture manuelle de la semaine:', err);
        jsonFailure(res, err, 'Erreur lors de la clôture de la semaine', 'DailyAlgoAPI');
      }
      return true;
    }
  }

  return false;
}

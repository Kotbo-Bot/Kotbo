import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { resolveViewTimezone } from '../../../utils/timezone.js';
import { getCachedFeatureAccess } from './featureGate.js';
import { RuleSimulationError, parseSimulatedRule } from '../../../services/moderation/ruleSimulation.js';
import { simulateRule } from '../../../services/moderation/ruleSimulationService.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

/**
 * POST /api/dashboard/guilds/:guildId/automod/simulate
 *
 * Corps : `{ rule, baseline?, days, tz? }`. `rule` est le brouillon tel qu'il
 * est à l'écran, pas encore enregistré ; `baseline`, la version en service à
 * laquelle le comparer.
 *
 * Une écriture au sens du routeur (POST), donc déjà réservée à qui peut
 * configurer l'automod. La réponse contient en plus des extraits de messages :
 * il faut aussi pouvoir lire les journaux, sans quoi la simulation servirait
 * à contourner la section Journaux fermée à un rôle.
 *
 * Pas de purge du cache derrière : une simulation n'écrit rien.
 */
export function createAutomodSimulationRouter(client: Client) {
  const router = new Hono();

  router.post('/api/dashboard/guilds/:guildId/automod/simulate', ...guildRoute(client, { invalidateCache: false }), async (c) => {
    const guildId = c.req.param('guildId');
    // `access` et non `effectiveAccess` : il faut savoir si le droit de
    // configurer vient d'un administrateur ou de la seule case « Configurer ».
    const access = c.var.access;
    if (!access.canManageSettings) {
      const featureAccess = await getCachedFeatureAccess(client, guildId, access, c.var.dashboardUser.userId);
      if (featureAccess.logs?.canView === false) {
        return send(c, { error: "La simulation montre des messages passés : il faut aussi l'accès aux journaux.", code: 'feature_denied', featureKey: 'logs' }, 403);
      }
    }

    try {
      const body = await readBody<{ rule?: unknown; baseline?: unknown; days?: unknown; tz?: unknown }>(c);
      const rule = parseSimulatedRule(body?.rule);
      const baseline = body?.baseline ? parseSimulatedRule(body.baseline) : null;
      const timezone = await resolveViewTimezone(body?.tz, guildId);
      return send(c, await simulateRule(client, guildId, rule, { days: Number(body?.days) || 7, baseline, timezone }));
    } catch (err) {
      if (err instanceof RuleSimulationError) return send(c, { error: err.message }, 400);
      logger.error('AutomodSimulation', `Simulation impossible sur ${guildId} :`, err);
      return fail(c, err, 'La simulation a échoué', 'AutomodSimulation');
    }
  });

  return router;
}

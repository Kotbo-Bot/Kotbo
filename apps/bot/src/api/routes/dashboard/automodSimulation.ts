import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { resolveViewTimezone } from '../../../utils/timezone.js';
import { json, readJsonBody, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
import { getCachedFeatureAccess } from './featureGate.js';
import { RuleSimulationError, parseSimulatedRule } from '../../../services/moderation/ruleSimulation.js';
import { simulateRule } from '../../../services/moderation/ruleSimulationService.js';

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
 */
export async function handleAutomodSimulationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  if (parts.length !== 6 || parts[4] !== 'automod' || parts[5] !== 'simulate' || req.method !== 'POST') return false;

  if (!access.canManageSettings) {
    const featureAccess = await getCachedFeatureAccess(client, guildId, access, user.userId);
    if (featureAccess.logs?.canView === false) {
      json(res, 403, { error: "La simulation montre des messages passés : il faut aussi l'accès aux journaux.", code: 'feature_denied', featureKey: 'logs' });
      return true;
    }
  }

  try {
    const body = await readJsonBody<{ rule?: unknown; baseline?: unknown; days?: unknown; tz?: unknown }>(req);
    const rule = parseSimulatedRule(body?.rule);
    const baseline = body?.baseline ? parseSimulatedRule(body.baseline) : null;
    const timezone = await resolveViewTimezone(body?.tz, guildId);
    const report = await simulateRule(client, guildId, rule, { days: Number(body?.days) || 7, baseline, timezone });
    json(res, 200, report);
  } catch (err) {
    if (err instanceof RuleSimulationError) {
      json(res, 400, { error: err.message });
      return true;
    }
    logger.error('AutomodSimulation', `Simulation impossible sur ${guildId} :`, err);
    jsonFailure(res, err, 'La simulation a échoué', 'AutomodSimulation');
  }
  return true;
}

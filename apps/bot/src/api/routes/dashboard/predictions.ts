import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { json, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { getPredictionData } from '../../../services/analytics/predictionService.js';
import { getGuildPlan } from '../../../services/system/planService.js';

import { jsonFailure } from '../../shared/failure.js';
export async function handlePredictionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess,
): Promise<boolean> {
  const method = req.method;
  if (parts[4] !== 'predictions') return false;

  // GET /api/dashboard/guilds/:guildId/predictions?days=30
  if (parts.length === 5 && method === 'GET') {
    if ((await getGuildPlan(guildId)) === 'FREE') {
      json(res, 402, { error: 'plan_required', message: "Les prédictions font partie de l'offre Plus." });
      return true;
    }
    try {
      // `getPredictionData` borne déjà la fenêtre à [7, 90] ; on se contente ici
      // de neutraliser une valeur non numérique (`?days=abc` donnait NaN, que
      // `Math.min/max` propageait jusqu'à la requête SQL).
      const raw = Number.parseInt(url.searchParams.get('days') ?? '', 10);
      const data = await getPredictionData(guildId, Number.isFinite(raw) ? raw : 30);
      json(res, 200, data);
    } catch (err) {
      logger.error('PredictionsAPI', 'Error fetching predictions:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des prédictions', 'PredictionsAPI');
    }
    return true;
  }

  return false;
}

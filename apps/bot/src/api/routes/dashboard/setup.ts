/**
 * Parcours de configuration expose a la page « Prise en main ». Le calcul vit
 * dans `services/core/setupJourney.ts`, que l'accueil lit aussi.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { computeSetupJourney } from '../../../services/core/setupJourney.js';
import { logger } from '../../../utils/logger.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

export function createSetupRouter(client: Client) {
  const router = new Hono();

  router.get('/api/dashboard/guilds/:guildId/setup', ...guildRoute(client, { invalidateCache: false }), async (c) => {
    if (!c.var.access.canManageSettings) return send(c, { error: 'Accès refusé' }, 403);
    try {
      const journey = await computeSetupJourney(c.req.param('guildId'));
      if (!journey) return send(c, { error: 'Serveur introuvable' }, 404);
      return send(c, journey);
    } catch (err) {
      logger.error('SetupAPI', 'Erreur GET setup:', err);
      return fail(c, err, 'Erreur lors du calcul du parcours', 'SetupAPI');
    }
  });

  return router;
}

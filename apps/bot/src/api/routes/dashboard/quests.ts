import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { resolveMemberFeatureAccess } from '../../shared.js';
import {
  getQuestsDashboardData,
  createQuestDefinition,
  updateQuestDefinition,
  deleteQuestDefinition,
} from '../../../services/community/questService.js';
import { fail, guildRoute, readLenientBody, send } from '../../hono/dashboard/kit.js';

export function createQuestsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/quests';

  const questAccess = createMiddleware(async (c, next) => {
    const method = c.req.method;
    // Les quetes sont une page de la section Economie du dashboard : elles suivent
    // le meme droit, sinon interdire "economy" laisserait leurs donnees accessibles.
    const featureAccess = await resolveMemberFeatureAccess(
      client, c.req.param('guildId')!, c.var.effectiveAccess, c.var.dashboardUser.userId,
    );
    if (!featureAccess.economy?.canView) {
      return send(c, { error: 'Accès refusé. Votre rôle ne donne pas accès aux quêtes.' }, 403);
    }

    // Voir la section suffisait pour y ecrire : creer, modifier et supprimer une
    // quete ne demandaient rien de plus que d'avoir la page ouverte. Les quetes
    // suivent le droit de l'economie, donc aussi sa distinction entre regler la
    // section et y effacer.
    if (method !== 'GET') {
      const allowed = method === 'DELETE'
        ? featureAccess.economy?.canDelete
        : featureAccess.economy?.canConfigure;
      if (!allowed) {
        return send(c, {
          error: method === 'DELETE'
            ? 'Accès refusé. Votre rôle ne permet pas de supprimer les quêtes.'
            : 'Accès refusé. Votre rôle ne permet pas de modifier les quêtes.',
        }, 403);
      }
    }
    await next();
  });
  const gate = [...guildRoute(client), questAccess] as const;

  router.get(base, ...gate, async (c) => {
    try {
      return send(c, await getQuestsDashboardData(c.req.param('guildId')));
    } catch (err) {
      logger.error('QuestsAPI', 'Error fetching quests:', err);
      return fail(c, err, 'Erreur lors de la récupération des quêtes', 'QuestsAPI');
    }
  });

  router.post(base, ...gate, async (c) => {
    try {
      const body = await readLenientBody<{
        name: string; description: string; type: string;
        frequency: string; target: number; rewardCoins: number; rewardXp: number;
        conditions?: Record<string, unknown> | null;
      }>(c);
      return send(c, await createQuestDefinition(c.req.param('guildId'), body), 201);
    } catch (err) {
      logger.error('QuestsAPI', 'Error creating quest:', err);
      return fail(c, err, 'Erreur lors de la création', 'QuestsAPI');
    }
  });

  router.patch(`${base}/:questId`, ...gate, async (c) => {
    try {
      const body = await readLenientBody<Record<string, any>>(c);
      return send(c, await updateQuestDefinition(c.req.param('guildId'), c.req.param('questId'), body));
    } catch (err) {
      logger.error('QuestsAPI', 'Error updating quest:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'QuestsAPI');
    }
  });

  router.delete(`${base}/:questId`, ...gate, async (c) => {
    try {
      await deleteQuestDefinition(c.req.param('guildId'), c.req.param('questId'));
      return send(c, { ok: true });
    } catch (err) {
      logger.error('QuestsAPI', 'Error deleting quest:', err);
      return fail(c, err, 'Erreur lors de la suppression', 'QuestsAPI');
    }
  });

  return router;
}

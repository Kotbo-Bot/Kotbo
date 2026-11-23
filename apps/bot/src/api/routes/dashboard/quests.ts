import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { resolveMemberFeatureAccess } from '../../shared.js';
import { prismaRead } from '../../../utils/db.js';
import {
  QuestError,
  deleteGuildQuest,
  listGuildQuests,
  saveGuildQuest,
} from '../../../services/features/rpg/rpgQuestService.js';
import { RPG_QUEST_OBJECTIVES, type RpgQuestInput } from '../../../services/features/rpg/rpgQuestPolicy.js';
import { listGiveawayRpgItems } from '../../../services/features/giveawayService.js';
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

  const handle = (c: Parameters<typeof fail>[0], err: unknown, message: string) => {
    if (err instanceof QuestError) return send(c, { error: err.message }, err.status as 400);
    logger.error('QuestsAPI', message, err);
    return fail(c, err, message, 'QuestsAPI');
  };

  router.get(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    try {
      const now = new Date();
      const [definitions, participations, claimed, giveaways, items] = await Promise.all([
        listGuildQuests(guildId),
        prismaRead.rpgQuestProgress.groupBy({ by: ['questId'], where: { guildId }, _count: { _all: true } }),
        prismaRead.rpgQuestProgress.aggregate({ where: { guildId, teamKey: '' }, _sum: { completions: true } }),
        prismaRead.giveaway.findMany({
          where: { guildId, ended: false, endsAt: { gt: now } },
          select: { id: true, prize: true },
          orderBy: { endsAt: 'asc' },
          take: 50,
        }),
        listGiveawayRpgItems(guildId),
      ]);
      const counts = new Map(participations.map((row) => [row.questId, row._count._all]));
      return send(c, {
        definitions: definitions.map((quest) => ({ ...quest, participants: counts.get(quest.id) ?? 0 })),
        totalClaimed: claimed._sum.completions ?? 0,
        objectives: RPG_QUEST_OBJECTIVES,
        giveaways,
        items,
      });
    } catch (err) {
      return handle(c, err, 'Erreur lors de la récupération des quêtes');
    }
  });

  router.post(base, ...gate, async (c) => {
    try {
      const body = await readLenientBody<RpgQuestInput & { id?: string }>(c);
      const { quest, created } = await saveGuildQuest(c.req.param('guildId')!, body, body.id);
      return send(c, quest, created ? 201 : 200);
    } catch (err) {
      return handle(c, err, 'Erreur lors de la sauvegarde');
    }
  });

  // Modification partielle (activer, désactiver) : on complète avec la fiche existante.
  router.patch(`${base}/:questId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId')!;
    const questId = c.req.param('questId')!;
    try {
      const body = await readLenientBody<RpgQuestInput>(c);
      const existing = await prismaRead.rpgQuest.findFirst({ where: { id: questId, guildId } });
      if (!existing) return send(c, { error: 'Quête introuvable.' }, 404);
      const { quest } = await saveGuildQuest(guildId, { ...existing, ...body }, questId);
      return send(c, quest);
    } catch (err) {
      return handle(c, err, 'Erreur lors de la mise à jour');
    }
  });

  router.delete(`${base}/:questId`, ...gate, async (c) => {
    try {
      await deleteGuildQuest(c.req.param('guildId')!, c.req.param('questId')!);
      return send(c, { ok: true });
    } catch (err) {
      return handle(c, err, 'Erreur lors de la suppression');
    }
  });

  return router;
}

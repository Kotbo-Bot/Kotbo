import { prismaRead } from '../../../utils/db.js';

// Un joueur assidu accumule une contribution par quête d'équipe et par fenêtre :
// les lire d'un bloc ferait une requête démesurée.
const TEAM_CONTRIBUTIONS_BATCH = 200;

/**
 * Quêtes menées à terme par un membre, tous serveurs confondus.
 *
 * Une quête personnelle compte chacun de ses versements (une répétable se paie
 * plusieurs fois). Une quête d'équipe compte pour chaque membre qui y a
 * contribué, une fois l'équipe payée : sa ligne ne porte que sa contribution,
 * jamais de versement, elle n'apparaissait donc pas dans le premier compte.
 */
export async function countCompletedQuests(userId: string): Promise<number> {
  const personal = await prismaRead.rpgQuestProgress.aggregate({
    where: { userId, teamKey: '' },
    _sum: { completions: true },
  });
  let total = personal._sum.completions ?? 0;

  let afterId: string | undefined;
  for (;;) {
    const contributions = await prismaRead.rpgQuestProgress.findMany({
      where: { userId, teamKey: { not: '' }, current: { gt: 0 }, ...(afterId ? { id: { gt: afterId } } : {}) },
      select: { id: true, questId: true, teamKey: true, windowKey: true },
      orderBy: { id: 'asc' },
      take: TEAM_CONTRIBUTIONS_BATCH,
    });
    if (contributions.length === 0) break;

    total += await prismaRead.rpgQuestTeamProgress.count({
      where: {
        rewardedAt: { not: null },
        OR: contributions.map(({ questId, teamKey, windowKey }) => ({ questId, teamKey, windowKey })),
      },
    });
    if (contributions.length < TEAM_CONTRIBUTIONS_BATCH) break;
    afterId = contributions[contributions.length - 1].id;
  }
  return total;
}

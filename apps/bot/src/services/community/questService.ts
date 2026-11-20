import type { Client } from 'discord.js';
import type { QuestDefinition } from '@prisma/client';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../utils/cache.js';
import { addXp } from '../progression/levelingService.js';
import { isModuleEnabled } from '../core/moduleGate.js';

function getDailyKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getWeeklyKey(): string {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNumber = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function getDateKeyForFrequency(frequency: string): string {
  return frequency === 'WEEKLY' ? getWeeklyKey() : getDailyKey();
}

export async function getAvailableQuests(guildId: string, userId: string) {
  const quests = await prismaRead.questDefinition.findMany({
    where: { guildId, enabled: true },
    orderBy: { frequency: 'asc' },
  });

  const dateKeys = [getDailyKey(), getWeeklyKey()];
  const progress = await prismaRead.questProgress.findMany({
    where: { guildId, userId, dateKey: { in: dateKeys } },
  });

  const progressMap = new Map(progress.map((p) => [p.questId, p]));

  return quests.map((quest) => {
    const dateKey = getDateKeyForFrequency(quest.frequency);
    const prog = progressMap.get(quest.id);
    return {
      ...quest,
      progress: prog ? { current: prog.current, target: prog.target, status: prog.status } : { current: 0, target: quest.target, status: 'IN_PROGRESS' },
      dateKey,
    };
  });
}

type ActiveQuest = Pick<
  QuestDefinition,
  'id' | 'guildId' | 'type' | 'frequency' | 'target' | 'rewardCoins' | 'rewardXp'
>;

/**
 * Quêtes actives d'un serveur, relues à chaque message, réaction ou minute de
 * vocal - y compris sur les serveurs qui n'en ont aucune. Mises en cache sous
 * le préfixe `guild:<id>:`, et invalidées par chaque écriture de définition.
 */
const ACTIVE_QUESTS_TTL_SECONDS = 60;
const activeQuestsKey = (guildId: string) => `guild:${guildId}:active-quests`;

function getActiveQuests(guildId: string): Promise<ActiveQuest[]> {
  return cache.wrap(activeQuestsKey(guildId), ACTIVE_QUESTS_TTL_SECONDS, () =>
    prismaRead.questDefinition.findMany({
      where: { guildId, enabled: true },
      select: { id: true, guildId: true, type: true, frequency: true, target: true, rewardCoins: true, rewardXp: true },
    }),
  );
}

export function invalidateActiveQuests(guildId: string): Promise<void> {
  return cache.delete(activeQuestsKey(guildId));
}

export async function incrementQuestProgress(
  client: Client,
  guildId: string,
  userId: string,
  type: string,
  amount = 1,
  channelId?: string,
): Promise<void> {
  try {
    const quests = (await getActiveQuests(guildId)).filter((quest) => quest.type === type);

    for (const quest of quests) {
      const dateKey = getDateKeyForFrequency(quest.frequency);
      const where = { guildId_userId_questId_dateKey: { guildId, userId, questId: quest.id, dateKey } };

      let existing = await prisma.questProgress.findUnique({ where });

      if (!existing) {
        const current = Math.min(amount, quest.target);
        const completed = current >= quest.target;
        const created = await prisma.questProgress.create({
          data: {
            guildId, userId, questId: quest.id, dateKey,
            current, target: quest.target,
            status: completed ? 'COMPLETED' : 'IN_PROGRESS',
          },
        }).catch((err: { code?: string }) => {
          if (err?.code === 'P2002') return null;
          throw err;
        });

        if (created) {
          if (completed) await rewardQuest(client, quest, created.id, userId, channelId);
          continue;
        }

        // Une action simultanée vient de créer la ligne : on repasse par la mise à jour.
        existing = await prisma.questProgress.findUnique({ where });
        if (!existing) continue;
      }

      // Une ligne terminée mais jamais payée date du temps où il fallait passer par
      // `/quests claim`, que personne ne pouvait utiliser : elle se règle ici, à la
      // prochaine action du joueur dans la même fenêtre.
      if (existing.status === 'COMPLETED') {
        await rewardQuest(client, quest, existing.id, userId, channelId);
        continue;
      }
      if (existing.status !== 'IN_PROGRESS') continue;

      const current = Math.min(existing.current + amount, quest.target);
      const completed = current >= quest.target;

      // La garde sur le statut empêche une lecture périmée de ramener à COMPLETED une
      // ligne qu'une action simultanée vient de payer, ce qui la paierait une seconde fois.
      const updated = await prisma.questProgress.updateMany({
        where: { id: existing.id, status: 'IN_PROGRESS' },
        data: { current, status: completed ? 'COMPLETED' : 'IN_PROGRESS' },
      });

      if (updated.count > 0 && completed) await rewardQuest(client, quest, existing.id, userId, channelId);
    }
  } catch (error) {
    logger.error('Quest', `Erreur progression quête type=${type} pour ${userId}:`, error);
  }
}

/**
 * Le passage au statut payé précède le versement et sert de verrou : deux actions
 * simultanées qui atteignent la cible ne paient qu'une fois.
 */
async function rewardQuest(
  client: Client,
  quest: ActiveQuest,
  progressId: string,
  userId: string,
  channelId?: string,
): Promise<void> {
  const { guildId } = quest;
  // Les pièces appartiennent à l'économie : éteinte, la quête se solde quand
  // même, sans créditer un solde que plus rien n'affiche ni ne dépense.
  const rewardCoins = quest.rewardCoins > 0 && (await isModuleEnabled(guildId, 'economy')) ? quest.rewardCoins : 0;

  const paid = await prisma.$transaction(async (tx) => {
    const claimed = await tx.questProgress.updateMany({
      where: { id: progressId, status: 'COMPLETED' },
      data: { status: 'CLAIMED', claimedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    // Upsert et non updateMany : un membre qui n'a jamais touché à l'économie n'a pas
    // encore de profil, et la quête passait payée sans qu'il reçoive une pièce.
    if (rewardCoins > 0) {
      await tx.rpgProfile.upsert({
        where: { guildId_userId: { guildId, userId } },
        update: { balance: { increment: rewardCoins } },
        create: { guildId, userId, balance: rewardCoins },
      });
    }
    return true;
  });
  if (!paid) return;

  // L'XP passe par `addXp`, hors transaction : elle seule recalcule le niveau et
  // distribue les rôles et notifications de montée.
  if (quest.rewardXp > 0) {
    await addXp(guildId, userId, quest.rewardXp, client, channelId);
  }
}

export async function createQuestDefinition(guildId: string, data: {
  name: string;
  description: string;
  type: string;
  frequency: string;
  target: number;
  rewardCoins: number;
  rewardXp: number;
}) {
  const quest = await prisma.questDefinition.create({
    data: {
      guildId,
      name: data.name,
      description: data.description,
      type: data.type as any,
      frequency: data.frequency as any,
      target: data.target,
      rewardCoins: data.rewardCoins,
      rewardXp: data.rewardXp,
    },
  });
  await invalidateActiveQuests(guildId);
  return quest;
}

// Le filtre sur `guildId` empêche d'atteindre, depuis la route d'un serveur, la
// quête d'un autre serveur dont on connaîtrait l'identifiant.
export async function updateQuestDefinition(guildId: string, questId: string, data: Record<string, any>) {
  const allowedFields = ['name', 'description', 'type', 'frequency', 'target', 'rewardCoins', 'rewardXp', 'enabled'];
  const sanitized: Record<string, any> = {};
  for (const key of allowedFields) {
    if (data[key] !== undefined) sanitized[key] = data[key];
  }
  const quest = await prisma.questDefinition.update({ where: { id: questId, guildId }, data: sanitized });
  await invalidateActiveQuests(guildId);
  return quest;
}

export async function deleteQuestDefinition(guildId: string, questId: string) {
  await prisma.questDefinition.delete({ where: { id: questId, guildId } });
  await invalidateActiveQuests(guildId);
}

export async function expireOldProgress(): Promise<void> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);

  await prisma.questProgress.updateMany({
    where: {
      status: { in: ['IN_PROGRESS', 'COMPLETED'] },
      dateKey: { lt: yesterdayKey },
      quest: { frequency: 'DAILY' },
    },
    data: { status: 'EXPIRED' },
  });
}

export async function getQuestsDashboardData(guildId: string) {
  const [definitions, recentClaims, totalClaimed] = await Promise.all([
    prismaRead.questDefinition.findMany({
      where: { guildId },
      orderBy: { frequency: 'asc' },
      include: { _count: { select: { progress: true } } },
    }),
    prismaRead.questProgress.findMany({
      where: { guildId, status: 'CLAIMED' },
      orderBy: { claimedAt: 'desc' },
      take: 30,
      select: { userId: true, questId: true, claimedAt: true },
    }),
    prismaRead.questProgress.count({ where: { guildId, status: 'CLAIMED' } }),
  ]);

  return { definitions, recentClaims, totalClaimed };
}

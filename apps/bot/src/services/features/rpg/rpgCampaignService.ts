/**
 * Avancement dans la campagne.
 *
 * Le service branche le récit sur des compteurs qui existent déjà : `trackCampaign` reçoit
 * les mêmes objectifs que les quêtes, depuis le même entonnoir. Aucun nouveau point de
 * comptage n'est ajouté au jeu, ce qui évite qu'une étape avance dans un écran et pas
 * dans l'autre.
 */

import type { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { upsertRetryingRace } from '../../../utils/upsertRetry.js';
import { logger } from '../../../utils/logger.js';
import {
  FIRST_CHAPTER_ID,
  RPG_CAMPAIGN,
  completedStepCount,
  getChapter,
  getStep,
  isCounterObjective,
  nextChapter,
  totalSteps,
  type CampaignChapter,
  type CampaignReward,
  type CampaignStep,
} from './rpgCampaign.js';
import type { RpgQuestObjective } from './rpgQuestPolicy.js';

/** Progression d'un joueur, créée à la volée au premier accès. */
async function getOrCreateProgress(guildId: string, userId: string) {
  return upsertRetryingRace(() => prisma.rpgCampaignProgress.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, chapterId: FIRST_CHAPTER_ID },
    update: {},
  }));
}

export type CampaignStepView = {
  step: CampaignStep;
  index: number;
  counter: number;
  target: number;
  done: boolean;
};

export type CampaignState = {
  /** `true` quand toutes les étapes de tous les chapitres sont bouclées. */
  finished: boolean;
  chapter: CampaignChapter | null;
  /** Étape en cours, `null` quand la campagne est finie. */
  current: CampaignStepView | null;
  /** Toutes les étapes du chapitre courant, pour montrer où l'on en est. */
  steps: CampaignStepView[];
  completedChapters: string[];
  chapterNumber: number;
  totalChapters: number;
  stepsDone: number;
  stepsTotal: number;
  level: number;
};

/**
 * Compteur d'une étape.
 *
 * `REACH_LEVEL` se lit sur le profil plutôt que dans la colonne : incrémenter un compteur
 * à chaque niveau gagné le désynchroniserait du niveau réel dès le premier gain manqué
 * (montée hors ligne, ajustement admin, reset partiel).
 */
function stepCounter(step: CampaignStep, storedCounter: number, level: number): number {
  return isCounterObjective(step.objective) ? storedCounter : level;
}

function stepView(step: CampaignStep, index: number, counter: number, level: number): CampaignStepView {
  const value = stepCounter(step, counter, level);
  return { step, index, counter: Math.min(value, step.target), target: step.target, done: value >= step.target };
}

export async function getCampaignState(guildId: string, userId: string): Promise<CampaignState> {
  const [progress, profile] = await Promise.all([
    getOrCreateProgress(guildId, userId),
    prisma.rpgProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { level: true },
    }),
  ]);

  const level = profile?.level ?? 1;
  const chapter = getChapter(progress.chapterId);
  const stepsDone = completedStepCount(progress.completedChapters, progress.chapterId, progress.stepIndex);

  // Chapitre inconnu du catalogue : il a été retiré d'une version à l'autre. On considère
  // la campagne terminée plutôt que de bloquer le joueur sur une étape qui n'existe plus.
  if (!chapter || progress.completedAt) {
    return {
      finished: true,
      chapter: null,
      current: null,
      steps: [],
      completedChapters: progress.completedChapters,
      chapterNumber: RPG_CAMPAIGN.length,
      totalChapters: RPG_CAMPAIGN.length,
      stepsDone: totalSteps(),
      stepsTotal: totalSteps(),
      level,
    };
  }

  const steps = chapter.steps.map((step, index) => {
    if (index < progress.stepIndex) {
      // Étape déjà bouclée : elle s'affiche pleine, son compteur n'a plus de sens.
      return { step, index, counter: step.target, target: step.target, done: true };
    }
    if (index === progress.stepIndex) {
      return stepView(step, index, progress.counter, level);
    }
    return { step, index, counter: 0, target: step.target, done: false };
  });

  return {
    finished: false,
    chapter,
    current: steps[progress.stepIndex] ?? null,
    steps,
    completedChapters: progress.completedChapters,
    chapterNumber: RPG_CAMPAIGN.findIndex((entry) => entry.id === chapter.id) + 1,
    totalChapters: RPG_CAMPAIGN.length,
    stepsDone,
    stepsTotal: totalSteps(),
    level,
  };
}

export type CampaignAdvance = {
  /** Étapes validées par cet appel. Plusieurs d'un coup si un gain en a débloqué plusieurs. */
  completedSteps: { step: CampaignStep; reward: CampaignReward }[];
  /** Chapitres bouclés par cet appel, avec leur récompense de fin. */
  completedChapters: { chapter: CampaignChapter; reward: CampaignReward }[];
  /** `true` quand cet appel a terminé la campagne entière. */
  finished: boolean;
};

const NO_ADVANCE: CampaignAdvance = { completedSteps: [], completedChapters: [], finished: false };

/** Verse une récompense d'étape ou de chapitre. L'objet est cherché par son nom. */
async function grantReward(guildId: string, userId: string, reward: CampaignReward): Promise<void> {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { id: true },
  });
  if (!profile) return;

  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.rpgProfile.update({
      where: { id: profile.id },
      data: { balance: { increment: reward.coins }, xp: { increment: reward.xp } },
    }),
  ];

  if (reward.itemName) {
    // L'objet est cherché dans le catalogue du serveur d'abord, puis dans le global : un
    // serveur qui a personnalisé « Potion de Vie » doit remettre la sienne.
    const item = await prisma.rpgItem.findFirst({
      where: { name: reward.itemName, OR: [{ guildId }, { guildId: null }] },
      // Postgres range les NULL en tête d'un tri décroissant : sans `nulls: 'last'`, l'objet
      // global passait devant la version du serveur.
      orderBy: { guildId: { sort: 'desc', nulls: 'last' } },
      select: { id: true },
    });

    if (item) {
      writes.push(prisma.rpgInventoryItem.upsert({
        where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: item.id } },
        create: { rpgProfileId: profile.id, itemId: item.id, quantity: 1 },
        update: { quantity: { increment: 1 } },
      }));
    } else {
      // Un objet retiré du catalogue ne doit pas faire échouer la récompense entière :
      // le joueur garde ses pièces et son XP, et l'incident part au journal.
      logger.warn('RpgCampaign', `Récompense « ${reward.itemName} » introuvable sur ${guildId}.`);
    }
  }

  await prisma.$transaction(writes);
}

/**
 * Fait avancer la campagne, et boucle autant d'étapes que l'état le permet.
 *
 * La boucle est nécessaire : un seul gain peut valider plusieurs étapes d'affilée (un
 * passage de plusieurs niveaux, un lot d'objets ramassés). S'arrêter à la première
 * laisserait le joueur devant une étape déjà satisfaite, sans rien pour la valider.
 */
async function advance(guildId: string, userId: string): Promise<CampaignAdvance> {
  const result: CampaignAdvance = { completedSteps: [], completedChapters: [], finished: false };

  // Garde-fou : le catalogue borne le nombre d'étapes, la boucle ne peut pas s'emballer
  // même sur des données incohérentes.
  for (let guard = 0; guard <= totalSteps(); guard++) {
    const progress = await prisma.rpgCampaignProgress.findUnique({
      where: { guildId_userId: { guildId, userId } },
    });
    if (!progress || progress.completedAt) return result;

    const step = getStep(progress.chapterId, progress.stepIndex);
    if (!step) return result;

    const profile = await prisma.rpgProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { level: true },
    });

    const value = stepCounter(step, progress.counter, profile?.level ?? 1);
    if (value < step.target) return result;

    const chapter = getChapter(progress.chapterId)!;
    const isLastStep = progress.stepIndex + 1 >= chapter.steps.length;
    const following = isLastStep ? nextChapter(chapter.id) : null;
    const campaignOver = isLastStep && following === null;

    // L'avancement est écrit AVANT le versement : si la récompense échoue, le joueur a au
    // moins progressé, là où l'inverse le laisserait encaisser la même étape en boucle.
    const moved = await prisma.rpgCampaignProgress.updateMany({
      where: { id: progress.id, chapterId: progress.chapterId, stepIndex: progress.stepIndex },
      data: isLastStep
        ? {
          chapterId: following?.id ?? progress.chapterId,
          stepIndex: 0,
          counter: 0,
          completedChapters: { push: chapter.id },
          completedAt: campaignOver ? new Date() : null,
        }
        : { stepIndex: progress.stepIndex + 1, counter: 0 },
    });

    // Un autre appel a avancé entre-temps : c'est lui qui versera, on se retire.
    if (moved.count === 0) return result;

    await grantReward(guildId, userId, step.reward);
    result.completedSteps.push({ step, reward: step.reward });

    if (isLastStep) {
      await grantReward(guildId, userId, chapter.reward);
      result.completedChapters.push({ chapter, reward: chapter.reward });
    }

    if (campaignOver) {
      result.finished = true;
      return result;
    }
  }

  return result;
}

/**
 * Enregistre une action de jeu au crédit de la campagne.
 *
 * Reçoit les mêmes objectifs que les quêtes, depuis le même entonnoir : c'est ce qui
 * garantit qu'une étape ne peut pas avancer dans un écran et pas dans l'autre.
 */
export async function trackCampaign(
  guildId: string,
  userId: string,
  objective: RpgQuestObjective,
  amount = 1,
): Promise<CampaignAdvance> {
  if (amount <= 0) return NO_ADVANCE;

  const progress = await prisma.rpgCampaignProgress.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });

  // Pas encore de progression : la campagne démarre au premier passage par l'écran, pas
  // au premier monstre tué. Compter avant que le joueur ait vu l'histoire n'aurait aucun
  // sens, et créerait une ligne pour chaque membre qui touche au RPG.
  if (!progress || progress.completedAt) return NO_ADVANCE;

  const step = getStep(progress.chapterId, progress.stepIndex);
  if (!step || step.objective !== objective) return NO_ADVANCE;

  await prisma.rpgCampaignProgress.update({
    where: { id: progress.id },
    data: { counter: { increment: amount } },
  });

  return advance(guildId, userId);
}

/**
 * Ouvre la campagne pour un joueur, et rattrape ce qui est déjà acquis.
 *
 * Appelé à l'ouverture de l'écran. Le rattrapage compte : un joueur de niveau 30 qui
 * découvre la campagne ne doit pas se voir demander d'atteindre le niveau 5.
 */
export async function openCampaign(guildId: string, userId: string): Promise<CampaignAdvance> {
  await getOrCreateProgress(guildId, userId);
  return advance(guildId, userId);
}

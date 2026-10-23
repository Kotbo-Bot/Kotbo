/**
 * Quêtes RPG : définitions, avancement et récompenses.
 *
 * Deux portées. Une quête personnelle se compte par membre, une quête d'équipe additionne les
 * actions de tout un clan sur une même fenêtre. Les deux se paient d'elles-mêmes à la
 * complétion : la récompense tombe sur l'action qui atteint la cible, sans geste du joueur.
 *
 * Une quête personnelle ne rend qu'une fois par vingt-quatre heures, sauf si sa fiche la dit
 * répétable : elle repart alors de zéro à chaque versement et peut rendre plusieurs fois dans
 * la même journée.
 *
 * Sur une quête d'équipe, l'avancement de chaque membre est conservé à part : c'est lui qui
 * rend le partage au prorata calculable et vérifiable, comme les assauts le font pour un raid.
 */

import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { awardRpgGuildXp, checkLevelUp } from '../economyService.js';
import { shouldAwardClanPoints } from './rpgBestiaryPolicy.js';
import { splitRaidRewards } from './rpgRaidPolicy.js';
import { asRpgTeamMode, resolveRpgTeamForUser } from './rpgTeamResolver.js';
import { awardRpgTeamPoints } from './rpgTeamRewards.js';
import {
  isQuestOnCooldown,
  normalizeRpgQuestInput,
  questWindowBounds,
  questWindowKey,
  QUEST_MEMBER_COOLDOWN_MS,
  type RpgQuestInput,
  type RpgQuestObjective,
} from './rpgQuestPolicy.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

/** Valeur de `teamKey` d'une contribution personnelle : une clé ne peut pas être nulle. */
const NO_TEAM = '';

export class QuestError extends UserFacingError {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'QuestError';
  }
}

// ── Définitions ───────────────────────────────────────────────────────────

export async function listGuildQuests(guildId: string) {
  return prisma.rpgQuest.findMany({
    where: { guildId },
    orderBy: [{ scope: 'asc' }, { name: 'asc' }],
  });
}

export async function saveGuildQuest(guildId: string, input: RpgQuestInput, questId?: string) {
  const normalized = normalizeRpgQuestInput(input);
  if (!normalized.ok) throw new QuestError(normalized.error, 400);
  const data = normalized.value;

  const twin = await prisma.rpgQuest.findFirst({
    where: { guildId, name: data.name, ...(questId ? { NOT: { id: questId } } : {}) },
    select: { id: true },
  });
  if (twin) throw new QuestError(`Une quête se nomme déjà « ${data.name} ».`, 409);

  // Une quête d'équipe sans module d'équipe ne compterait jamais rien : personne ne
  // pourrait être rattaché à quoi que ce soit, et le compteur resterait à zéro sans que
  // rien ne le dise. Le contrôle vit ici et non dans la normalisation, qui ne touche pas
  // la base et doit rester vérifiable en test.
  if (data.scope === 'TEAM') {
    if (data.teamMode === 'RPG_GUILD') {
      const config = await prisma.economyConfig.findUnique({ where: { guildId }, select: { guildsEnabled: true } });
      if (!config?.guildsEnabled) throw new QuestError('Activez les guildes RPG pour créer une quête de guilde.', 409);
    } else {
      const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { clansEnabled: true } });
      if (!guild?.clansEnabled) throw new QuestError('Activez le module Clans pour créer une quête de clan.', 409);
    }
  }

  if (!questId) {
    return { quest: await prisma.rpgQuest.create({ data: { guildId, ...data } }), created: true };
  }

  const existing = await prisma.rpgQuest.findUnique({ where: { id: questId }, select: { guildId: true } });
  if (!existing) throw new QuestError('Quête introuvable.', 404);
  if (existing.guildId !== guildId) throw new QuestError('Cette quête appartient à un autre serveur.', 403);

  return { quest: await prisma.rpgQuest.update({ where: { id: questId }, data }), created: false };
}

export async function deleteGuildQuest(guildId: string, questId: string) {
  const existing = await prisma.rpgQuest.findUnique({ where: { id: questId }, select: { guildId: true, name: true } });
  if (!existing) throw new QuestError('Quête introuvable.', 404);
  if (existing.guildId !== guildId) throw new QuestError('Cette quête appartient à un autre serveur.', 403);

  await prisma.rpgQuest.delete({ where: { id: questId } });
  return { name: existing.name };
}

// ── Avancement ────────────────────────────────────────────────────────────

/**
 * Compte une action de jeu sur toutes les quêtes qui la visent.
 *
 * Point d'entrée unique, appelé depuis le combat, le raid et la pêche. Volontairement
 * silencieux : une quête qui ne progresse pas ne doit jamais faire échouer le combat qui
 * vient d'être gagné.
 */
export async function trackRpgQuest(
  client: Client,
  guildId: string,
  userId: string,
  objective: RpgQuestObjective,
  amount = 1,
): Promise<void> {
  if (amount <= 0) return;

  try {
    const quests = await prisma.rpgQuest.findMany({ where: { guildId, enabled: true, objective } });
    if (quests.length === 0) return;

    for (const quest of quests) {
      const windowKey = questWindowKey(quest.windowHours);

      if (quest.scope === 'MEMBER') {
        await bumpMemberProgress(quest, userId, windowKey, amount, NO_TEAM, client);
        continue;
      }

      // Sans équipe, il n'y a rien à faire avancer : une contribution sans destinataire ne
      // serait jamais attribuée, et la garder ferait croire à un compteur qui tourne.
      const identity = await resolveRpgTeamForUser(quest.guildId, userId, asRpgTeamMode(quest.teamMode), client);
      if (!identity) continue;

      await bumpMemberProgress(quest, userId, windowKey, amount, identity.key, client);
      await bumpTeamProgress(quest, identity, windowKey, amount, client);
    }
  } catch (error) {
    logger.error('RpgQuest', `Progression ${objective} en échec pour ${userId} sur ${guildId}:`, error);
  }
}

type QuestRow = Awaited<ReturnType<typeof listGuildQuests>>[number];

/**
 * Avance la ligne d'un membre.
 *
 * Sur une quête personnelle, le compteur est plafonné à la cible : dépasser n'apporte rien
 * et brouillerait la barre de progression. Sur une quête d'équipe, il ne l'est pas - c'est
 * la contribution réelle qui décide du partage, et un membre peut à lui seul dépasser la
 * cible commune.
 */
async function bumpMemberProgress(
  quest: QuestRow,
  userId: string,
  windowKey: string,
  amount: number,
  teamKey: string,
  client: Client,
): Promise<void> {
  const where = { questId_userId_windowKey_teamKey: { questId: quest.id, userId, windowKey, teamKey } };
  const existing = await prisma.rpgQuestProgress.findUnique({ where });

  // Une ligne déjà payée ne bouge plus, sauf sur une quête répétable, qui repart de zéro à
  // chaque versement et peut donc rendre à nouveau dans la même fenêtre. Une ligne terminée
  // mais non payée, elle, repasse par le versement : c'est ainsi que se règlent les quêtes
  // restées en attente du temps où le joueur devait les réclamer à la main.
  if (quest.scope === 'MEMBER' && !quest.repeatable && existing?.status === 'CLAIMED') return;

  const raw = (existing?.current ?? 0) + amount;
  const current = quest.scope === 'MEMBER' ? Math.min(raw, quest.target) : raw;
  const completed = quest.scope === 'MEMBER' && current >= quest.target;

  const progress = await prisma.rpgQuestProgress.upsert({
    where,
    create: {
      guildId: quest.guildId,
      questId: quest.id,
      userId,
      windowKey,
      teamKey,
      current,
      target: quest.target,
      status: completed ? 'COMPLETED' : 'IN_PROGRESS',
      completedAt: completed ? new Date() : null,
    },
    update: {
      current,
      status: completed ? 'COMPLETED' : 'IN_PROGRESS',
      completedAt: completed ? (existing?.completedAt ?? new Date()) : null,
    },
  });

  // Ce que l'action a apporté au dela de la cible n'est pas perdu sur une quête répétable :
  // il ouvre le tour suivant. Plafonné à la cible, la barre resterait sinon illisible après
  // une seule action très généreuse.
  if (completed) {
    const carry = Math.min(Math.max(raw - quest.target, 0), quest.target);
    await rewardMemberQuest(client, quest, progress.id, userId, carry);
  }
}

/**
 * Dernier versement d'un joueur sur une quête, toutes fenêtres confondues.
 *
 * Le verrou de vingt-quatre heures ne peut pas se lire sur la seule fenêtre en cours : une
 * quête réglée sur six heures ouvre quatre lignes par jour, et chacune se croirait la
 * première.
 */
async function lastQuestReward(questId: string, userId: string): Promise<Date | null> {
  const previous = await prisma.rpgQuestProgress.findFirst({
    where: {
      questId,
      userId,
      claimedAt: { gt: new Date(Date.now() - QUEST_MEMBER_COOLDOWN_MS) },
    },
    orderBy: { claimedAt: 'desc' },
    select: { claimedAt: true },
  });
  return previous?.claimedAt ?? null;
}

/**
 * Paie une quête personnelle terminée.
 *
 * Le passage au statut payé précède le versement et sert de verrou : au pire un joueur n'est
 * pas payé, jamais deux fois par deux actions qui atteindraient la cible en même temps.
 *
 * Une quête répétable repart aussitôt de zéro et peut rendre à nouveau ; une quête ordinaire
 * ne rend qu'une fois par vingt-quatre heures. La ligne reste alors terminée sans être payée,
 * et le versement tombera à la première action du joueur passé ce délai : le travail déjà
 * fait n'est pas perdu, seulement mis en attente.
 */
async function rewardMemberQuest(
  client: Client,
  quest: QuestRow,
  progressId: string,
  userId: string,
  carry: number,
): Promise<void> {
  if (!quest.repeatable && isQuestOnCooldown(await lastQuestReward(quest.id, userId))) return;

  const claimed = await prisma.rpgQuestProgress.updateMany({
    where: { id: progressId, status: 'COMPLETED' },
    data: quest.repeatable
      // Le compteur repart de zéro et la ligne redevient courante : la cible suivante se joue
      // dans la foulée, sans attendre la fenêtre d'après.
      ? { status: 'IN_PROGRESS', current: carry, completedAt: null, claimedAt: new Date(), completions: { increment: 1 } }
      : { status: 'CLAIMED', claimedAt: new Date(), completions: { increment: 1 } },
  });
  if (claimed.count === 0) return;

  await prisma.rpgProfile.updateMany({
    where: { guildId: quest.guildId, userId },
    data: {
      balance: { increment: quest.rewardCoins },
      xp: { increment: quest.rewardXp },
    },
  });
  await checkLevelUp(quest.guildId, userId);
  // Une quête personnelle crédite l'équipe de celui qui la termine, exactement comme un
  // monstre vaincu : son clan, ou sa guilde du jeu selon ce dont sont faites les équipes.
  await awardRpgTeamPoints({
    client,
    guildId: quest.guildId,
    userId,
    amount: quest.rewardClanPoints,
    source: 'RPG_QUEST',
    reason: quest.name,
  });
}

/** Additionne l'action au compteur de l'équipe, et paie celle-ci si la cible est atteinte. */
async function bumpTeamProgress(
  quest: QuestRow,
  identity: { key: string; name: string },
  windowKey: string,
  amount: number,
  client: Client,
): Promise<void> {
  const where = { questId_teamKey_windowKey: { questId: quest.id, teamKey: identity.key, windowKey } };
  const team = await prisma.rpgQuestTeamProgress.upsert({
    where,
    create: {
      guildId: quest.guildId,
      questId: quest.id,
      teamKey: identity.key,
      teamName: identity.name,
      windowKey,
      current: amount,
      target: quest.target,
    },
    // Le nom est rafraîchi au passage : un clan renommé doit l'être partout où il s'affiche.
    update: { current: { increment: amount }, teamName: identity.name },
  });

  if (team.current < quest.target || team.rewardedAt) return;

  // Le marquage précède le versement : au pire une équipe n'est pas payée, jamais deux fois
  // par deux actions simultanées.
  const claimed = await prisma.rpgQuestTeamProgress.updateMany({
    where: { id: team.id, rewardedAt: null },
    data: { rewardedAt: new Date(), completedAt: new Date() },
  });
  if (claimed.count === 0) return;

  await rewardTeamQuest(client, quest, identity.key, windowKey);
}

/** Partage les récompenses d'une quête d'équipe entre ses contributeurs. */
async function rewardTeamQuest(client: Client, quest: QuestRow, teamKey: string, windowKey: string): Promise<void> {
  // L'équipe est figée sur chaque contribution : le partage se lit directement, sans avoir
  // à retrouver l'appartenance de chacun, et ce qui a été gagné reste acquis à l'équipe
  // d'alors même si son auteur a changé de clan depuis.
  const contributions = await prisma.rpgQuestProgress.findMany({
    where: { questId: quest.id, windowKey, teamKey, current: { gt: 0 } },
    select: { userId: true, current: true },
  });

  const mode = asRpgTeamMode(quest.teamMode);
  const members = contributions.map((contribution) => ({
    userId: contribution.userId,
    damage: contribution.current,
  }));
  if (members.length === 0) return;

  const coinShares = splitRaidRewards(members, quest.rewardCoins);
  const xpShares = splitRaidRewards(members, quest.rewardXp);
  const pointShares = splitRaidRewards(members, quest.rewardClanPoints);

  for (const { userId } of members) {
    const coins = coinShares.get(userId) ?? 0;
    const xp = xpShares.get(userId) ?? 0;
    if (coins === 0 && xp === 0) continue;

    try {
      await prisma.rpgProfile.update({
        where: { guildId_userId: { guildId: quest.guildId, userId } },
        data: { balance: { increment: coins }, xp: { increment: xp } },
      });
      await checkLevelUp(quest.guildId, userId);
    } catch (error) {
      logger.error('RpgQuest', `Récompense non versée à ${userId} sur ${quest.guildId}:`, error);
    }
  }

  // Les points reglés sur la fiche vont à l'équipe qui a terminé la quête : son clan en
  // mode clan, sa guilde du jeu en mode guilde RPG. Sans cette seconde branche, une quête
  // d'équipe jouée en guildes RPG n'apportait rien à la guilde elle-même.
  if (mode === 'CLAN') {
    await awardQuestClanPoints(
      client,
      quest.guildId,
      [...pointShares.entries()].map(([userId, amount]) => ({ userId, amount })),
      quest.name,
    );
    return;
  }

  const totalPoints = [...pointShares.values()].reduce((sum, amount) => sum + amount, 0);
  if (totalPoints > 0) {
    await awardRpgGuildXp(teamKey, totalPoints).catch((error: unknown) => {
      logger.error('RpgQuest', `XP de guilde non versée sur ${quest.guildId}:`, error);
    });
  }
}

/**
 * Verse des points de clan si le pont RPG est ouvert.
 *
 * Le pont se coupe sans toucher aux primes reglees sur les fiches : un serveur qui l'a
 * ferme ne doit plus rien recevoir du RPG, quete comprise, exactement comme pour un
 * monstre vaincu.
 */
async function awardQuestClanPoints(
  client: Client,
  guildId: string,
  awards: Array<{ userId: string; amount: number }>,
  reason: string,
): Promise<void> {
  const positive = awards.filter((award) => award.amount > 0);
  if (positive.length === 0) return;

  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { clansEnabled: true, clanPointsFromRpg: true },
  });
  if (!shouldAwardClanPoints(guild, positive[0].amount)) return;

  const { awardClanPointsToMembers } = await import('../../community/clanService.js');
  await awardClanPointsToMembers({ guildId, client, source: 'RPG_QUEST', awards: positive, reason })
    .catch((error: unknown) => {
      logger.error('RpgQuest', `Points de clan non versés sur ${guildId}:`, error);
    });
}

// ── Lecture ───────────────────────────────────────────────────────────────

export interface QuestView {
  id: string;
  name: string;
  description: string;
  emoji: string;
  objective: string;
  scope: string;
  target: number;
  windowHours: number;
  endsAt: Date;
  rewardCoins: number;
  rewardXp: number;
  rewardClanPoints: number;
  current: number;
  status: string;
  teamName: string | null;
}

/** Quêtes en cours d'un membre : les siennes, puis celles de son équipe. */
export async function getMemberQuests(client: Client, guildId: string, userId: string): Promise<QuestView[]> {
  const quests = await prisma.rpgQuest.findMany({ where: { guildId, enabled: true }, orderBy: { name: 'asc' } });
  if (quests.length === 0) return [];

  const views: QuestView[] = [];
  const teams = new Map<string, { key: string; name: string } | null>();

  for (const quest of quests) {
    const windowKey = questWindowKey(quest.windowHours);
    const { endsAt } = questWindowBounds(quest.windowHours);
    const base = {
      id: quest.id,
      name: quest.name,
      description: quest.description,
      emoji: quest.emoji,
      objective: quest.objective,
      scope: quest.scope,
      target: quest.target,
      windowHours: quest.windowHours,
      endsAt,
      rewardCoins: quest.rewardCoins,
      rewardXp: quest.rewardXp,
      rewardClanPoints: quest.rewardClanPoints,
    };

    if (quest.scope === 'MEMBER') {
      const progress = await prisma.rpgQuestProgress.findUnique({
        where: { questId_userId_windowKey_teamKey: { questId: quest.id, userId, windowKey, teamKey: NO_TEAM } },
      });
      views.push({
        ...base,
        current: progress?.current ?? 0,
        status: progress?.status ?? 'IN_PROGRESS',
        teamName: null,
      });
      continue;
    }

    // Une même équipe sert souvent plusieurs quêtes : on ne la résout qu'une fois par mode.
    const mode = asRpgTeamMode(quest.teamMode);
    if (!teams.has(mode)) {
      const identity = await resolveRpgTeamForUser(guildId, userId, mode, client);
      teams.set(mode, identity ? { key: identity.key, name: identity.name } : null);
    }
    const team = teams.get(mode) ?? null;
    if (!team) continue;

    const progress = await prisma.rpgQuestTeamProgress.findUnique({
      where: { questId_teamKey_windowKey: { questId: quest.id, teamKey: team.key, windowKey } },
    });
    views.push({
      ...base,
      current: progress?.current ?? 0,
      status: progress?.rewardedAt ? 'CLAIMED' : (progress && progress.current >= quest.target ? 'COMPLETED' : 'IN_PROGRESS'),
      teamName: team.name,
    });
  }

  return views;
}

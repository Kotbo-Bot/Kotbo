/**
 * Arène PvP : duels asynchrones entre deux personnages du même serveur.
 *
 * Le défenseur n'a pas à être connecté — son personnage se bat avec ses statistiques du
 * moment. C'est la seule forme de PvP jouable sur un Discord, où deux joueurs sont
 * rarement présents en même temps.
 *
 * Les deux combattants démarrent à leurs PV maximum, et le duel ne touche PAS leurs PV
 * réels. L'arène est un classement à part : y faire perdre des PV rendrait le défenseur
 * responsable de combats qu'il n'a pas lancés, et le challenger devrait se soigner entre
 * chaque duel. Le coût du duel est l'énergie et le temps d'attente, pas la santé.
 */

import prisma from '../../../utils/db.js';
import { upsertRetryingRace } from '../../../utils/upsertRetry.js';
import { logger } from '../../../utils/logger.js';
import { loadAvailableSkills, loadEffectiveStats } from '../combatService.js';
import { computeAttack } from './rpgCombatMath.js';
import type { EffectiveStats } from './rpgStats.js';
import type { RpgSkill } from './rpgClasses.js';
import {
  ARENA_COOLDOWN_MS,
  ARENA_ENERGY_COST,
  ARENA_MAX_TURNS,
  ARENA_MIN_LEVEL,
  ARENA_START_RATING,
  applyRating,
  arenaReward,
  arenaTier,
  canEnterArena,
  eligibleOpponents,
  nextStreak,
  ratingExchange,
  type ArenaCandidate,
} from './rpgArenaPolicy.js';

/** Erreur attendue : elle se dit au joueur, elle ne part pas au journal. */
export class ArenaError extends Error {}

const PROFILE_FOR_DUEL = {
  id: true, guildId: true, userId: true, rpgGuildId: true,
  level: true, attack: true, defense: true, speed: true, maxHealth: true,
  energy: true, className: true,
  weaponId: true, armorId: true, accessoryId: true, accessory2Id: true, accessory3Id: true,
} as const;

type DuelFighter = {
  userId: string;
  level: number;
  stats: EffectiveStats;
  skill: RpgSkill | null;
};

export type ArenaRecordView = {
  userId: string;
  rating: number;
  bestRating: number;
  wins: number;
  losses: number;
  streak: number;
  tier: { name: string; emoji: string };
  lastMatchAt: Date | null;
};

function toRecordView(record: {
  userId: string; rating: number; bestRating: number;
  wins: number; losses: number; streak: number; lastMatchAt: Date | null;
}): ArenaRecordView {
  return { ...record, tier: arenaTier(record.rating) };
}

/** Classement d'un joueur, créé à la volée au premier accès. */
export async function getOrCreateArenaRecord(guildId: string, userId: string) {
  return upsertRetryingRace(() => prisma.rpgArenaRecord.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, rating: ARENA_START_RATING, bestRating: ARENA_START_RATING },
    update: {},
  }));
}

export type ArenaTurn = {
  attacker: 'challenger' | 'opponent';
  damage: number;
  critical: boolean;
  challengerHp: number;
  opponentHp: number;
  skillName: string | null;
};

/**
 * Déroule le duel.
 *
 * Même moteur que le combat PvE (`computeAttack`), appliqué symétriquement : chaque camp
 * frappe avec ses statistiques effectives et sa meilleure compétence offensive. Le plus
 * rapide commence, ce qui donne enfin un rôle à la vitesse en PvP.
 */
function runDuel(challenger: DuelFighter, opponent: DuelFighter): { turns: ArenaTurn[]; winnerId: string } {
  let challengerHp = challenger.stats.maxHealth;
  let opponentHp = opponent.stats.maxHealth;
  const turns: ArenaTurn[] = [];

  const challengerFirst = challenger.stats.speed >= opponent.stats.speed;
  let challengerCooldown = 0;
  let opponentCooldown = 0;

  for (let i = 0; i < ARENA_MAX_TURNS && challengerHp > 0 && opponentHp > 0; i++) {
    const challengerTurn = (challengerFirst && i % 2 === 0) || (!challengerFirst && i % 2 === 1);
    const attacker = challengerTurn ? challenger : opponent;
    const defender = challengerTurn ? opponent : challenger;
    const cooldown = challengerTurn ? challengerCooldown : opponentCooldown;

    const useSkill = attacker.skill !== null && cooldown === 0;
    const skill = useSkill ? attacker.skill : null;

    const { damage, critical, healed, reflected } = computeAttack({
      attack: attacker.stats.attack,
      targetDefense: defender.stats.defense,
      speed: attacker.stats.speed,
      critChance: attacker.stats.critChance,
      armorPiercing: Math.max(attacker.stats.armorPiercing, skill?.effect.armorPiercing ?? 0),
      skillMultiplier: skill?.effect.damageMultiplier ?? 1,
      targetDamageReduction: defender.stats.damageReduction,
      targetThorns: defender.stats.thorns,
      lifesteal: attacker.stats.lifesteal + (skill?.effect.lifesteal ?? 0),
    });

    if (challengerTurn) {
      opponentHp = Math.max(0, opponentHp - damage);
      if (healed > 0) challengerHp = Math.min(challenger.stats.maxHealth, challengerHp + healed);
      // Les épines frappent même si le coup est mortel : l'armure réagit à l'impact.
      if (reflected > 0) challengerHp = Math.max(0, challengerHp - reflected);
      challengerCooldown = useSkill ? (attacker.skill?.cooldownTurns ?? 0) : Math.max(0, challengerCooldown - 1);
      opponentCooldown = Math.max(0, opponentCooldown - 1);
    } else {
      challengerHp = Math.max(0, challengerHp - damage);
      if (healed > 0) opponentHp = Math.min(opponent.stats.maxHealth, opponentHp + healed);
      if (reflected > 0) opponentHp = Math.max(0, opponentHp - reflected);
      opponentCooldown = useSkill ? (attacker.skill?.cooldownTurns ?? 0) : Math.max(0, opponentCooldown - 1);
      challengerCooldown = Math.max(0, challengerCooldown - 1);
    }

    turns.push({
      attacker: challengerTurn ? 'challenger' : 'opponent',
      damage,
      critical,
      challengerHp,
      opponentHp,
      skillName: skill?.name ?? null,
    });
  }

  // Duel arrivé au bout des tours sans mort : celui à qui il reste le plus de PV
  // l'emporte, à égalité parfaite c'est le défenseur. Sans départage, le challenger
  // pourrait relancer indéfiniment un duel qui ne coûte rien à personne.
  if (challengerHp > 0 && opponentHp > 0) {
    const challengerShare = challengerHp / challenger.stats.maxHealth;
    const opponentShare = opponentHp / opponent.stats.maxHealth;
    return { turns, winnerId: challengerShare > opponentShare ? challenger.userId : opponent.userId };
  }

  return { turns, winnerId: challengerHp > 0 ? challenger.userId : opponent.userId };
}

async function loadFighter(profile: {
  id: string; userId: string; level: number; className: string | null;
} & Parameters<typeof loadEffectiveStats>[0]): Promise<DuelFighter> {
  const [stats, skills] = await Promise.all([
    loadEffectiveStats(profile),
    loadAvailableSkills(profile),
  ]);

  const offensive = skills
    .filter((skill) => skill.effect.damageMultiplier > 0)
    .sort((a, b) => b.effect.damageMultiplier - a.effect.damageMultiplier);

  return { userId: profile.userId, level: profile.level, stats, skill: offensive[0] ?? null };
}

export type ArenaState = {
  record: ArenaRecordView;
  rank: number;
  totalRanked: number;
  /** Adversaires proposables, les plus proches en classement d'abord. */
  opponents: (ArenaCandidate & { tier: { name: string; emoji: string } })[];
  leaderboard: ArenaRecordView[];
  /** Duels subis récemment, que le défenseur n'a pas vus passer. */
  recentDefenses: { challengerId: string; won: boolean; ratingChange: number; at: Date }[];
  entry: ReturnType<typeof canEnterArena>;
  energyCost: number;
  minLevel: number;
};

export async function getArenaState(guildId: string, userId: string): Promise<ArenaState> {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { level: true, energy: true },
  });
  if (!profile) throw new ArenaError('Profil RPG introuvable.');

  const record = await getOrCreateArenaRecord(guildId, userId);

  const [ranked, candidates, defenses] = await Promise.all([
    prisma.rpgArenaRecord.findMany({
      where: { guildId },
      orderBy: [{ rating: 'desc' }, { wins: 'desc' }],
      select: { userId: true, rating: true, bestRating: true, wins: true, losses: true, streak: true, lastMatchAt: true },
    }),
    prisma.rpgProfile.findMany({
      where: { guildId, level: { gte: ARENA_MIN_LEVEL } },
      select: { userId: true, level: true },
    }),
    prisma.rpgArenaMatch.findMany({
      where: { guildId, opponentId: userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { challengerId: true, winnerId: true, ratingChange: true, createdAt: true },
    }),
  ]);

  const ratingByUser = new Map(ranked.map((entry) => [entry.userId, entry.rating]));

  // Un joueur qui n'a jamais combattu n'a pas encore de ligne de classement : il entre
  // dans le vivier au classement de départ, sans quoi les nouveaux seraient invisibles.
  const pool: ArenaCandidate[] = candidates.map((candidate) => ({
    userId: candidate.userId,
    level: candidate.level,
    rating: ratingByUser.get(candidate.userId) ?? ARENA_START_RATING,
  }));

  return {
    record: toRecordView(record),
    rank: ranked.findIndex((entry) => entry.userId === userId) + 1,
    totalRanked: ranked.length,
    opponents: eligibleOpponents(userId, record.rating, pool)
      .slice(0, 25)
      .map((opponent) => ({ ...opponent, tier: arenaTier(opponent.rating) })),
    leaderboard: ranked.slice(0, 10).map(toRecordView),
    recentDefenses: defenses.map((match) => ({
      challengerId: match.challengerId,
      won: match.winnerId === userId,
      ratingChange: match.ratingChange,
      at: match.createdAt,
    })),
    entry: canEnterArena(profile, record.lastMatchAt, new Date()),
    energyCost: ARENA_ENERGY_COST,
    minLevel: ARENA_MIN_LEVEL,
  };
}

export type DuelOutcome = {
  won: boolean;
  opponentId: string;
  turns: ArenaTurn[];
  ratingChange: number;
  newRating: number;
  opponentNewRating: number;
  streak: number;
  reward: { coins: number; xp: number };
  challengerMaxHp: number;
  opponentMaxHp: number;
};

/**
 * Lance un duel contre un adversaire choisi.
 *
 * Le débit d'énergie et la pose du verrou se font dans la MÊME écriture conditionnelle :
 * sans ça, un double clic ouvrirait deux duels avec une seule dépense, et les deux
 * écriraient un classement calculé sur le même état de départ.
 */
export async function fightArenaDuel(guildId: string, userId: string, opponentId: string): Promise<DuelOutcome> {
  if (opponentId === userId) throw new ArenaError('Vous ne pouvez pas vous affronter vous-même.');

  const [challengerProfile, opponentProfile] = await Promise.all([
    prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } }, select: PROFILE_FOR_DUEL }),
    prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId: opponentId } }, select: PROFILE_FOR_DUEL }),
  ]);

  if (!challengerProfile) throw new ArenaError('Profil RPG introuvable.');
  if (!opponentProfile) throw new ArenaError("Cet adversaire n'a pas encore de personnage.");
  if (opponentProfile.level < ARENA_MIN_LEVEL) {
    throw new ArenaError(`L'arène s'ouvre au niveau ${ARENA_MIN_LEVEL} : cet adversaire n'y est pas encore.`);
  }

  const [challengerRecord, opponentRecord] = await Promise.all([
    getOrCreateArenaRecord(guildId, userId),
    getOrCreateArenaRecord(guildId, opponentId),
  ]);

  const entry = canEnterArena(challengerProfile, challengerRecord.lastMatchAt, new Date());
  if (!entry.ok) {
    if (entry.reason === 'level') throw new ArenaError(`L'arène s'ouvre au niveau ${ARENA_MIN_LEVEL}.`);
    if (entry.reason === 'energy') throw new ArenaError(`Il vous faut ${ARENA_ENERGY_COST} d'énergie pour entrer en lice.`);
    throw new ArenaError(`Reprenez votre souffle : ${Math.ceil((entry.retryInMs ?? 0) / 1000)} s avant le prochain duel.`);
  }

  // Débit d'énergie ET verrou de cooldown en une seule écriture conditionnelle.
  const lockedAt = new Date();
  const spent = await prisma.rpgProfile.updateMany({
    where: { id: challengerProfile.id, energy: { gte: ARENA_ENERGY_COST } },
    data: { energy: { decrement: ARENA_ENERGY_COST } },
  });
  if (spent.count === 0) {
    throw new ArenaError(`Il vous faut ${ARENA_ENERGY_COST} d'énergie pour entrer en lice.`);
  }

  const locked = await prisma.rpgArenaRecord.updateMany({
    where: {
      id: challengerRecord.id,
      OR: [
        { lastMatchAt: null },
        { lastMatchAt: { lte: new Date(lockedAt.getTime() - ARENA_COOLDOWN_MS) } },
      ],
    },
    data: { lastMatchAt: lockedAt },
  });
  if (locked.count === 0) {
    // Le verrou a été pris entre-temps par un second clic : on rend l'énergie, le duel
    // n'a pas eu lieu.
    await prisma.rpgProfile.update({
      where: { id: challengerProfile.id },
      data: { energy: { increment: ARENA_ENERGY_COST } },
    }).catch(() => null);
    throw new ArenaError('Un duel est déjà en cours de résolution.');
  }

  const [challenger, opponent] = await Promise.all([
    loadFighter(challengerProfile),
    loadFighter(opponentProfile),
  ]);

  const { turns, winnerId } = runDuel(challenger, opponent);
  const won = winnerId === userId;

  const ratingChange = won
    ? ratingExchange(challengerRecord.rating, opponentRecord.rating)
    : ratingExchange(opponentRecord.rating, challengerRecord.rating);

  const newRating = applyRating(challengerRecord.rating, won ? ratingChange : -ratingChange);
  const opponentNewRating = applyRating(opponentRecord.rating, won ? -ratingChange : ratingChange);
  const reward = arenaReward(ratingChange, won);

  await prisma.$transaction([
    prisma.rpgArenaRecord.update({
      where: { id: challengerRecord.id },
      data: {
        rating: newRating,
        bestRating: Math.max(challengerRecord.bestRating, newRating),
        wins: { increment: won ? 1 : 0 },
        losses: { increment: won ? 0 : 1 },
        streak: nextStreak(challengerRecord.streak, won),
      },
    }),
    prisma.rpgArenaRecord.update({
      where: { id: opponentRecord.id },
      data: {
        rating: opponentNewRating,
        bestRating: Math.max(opponentRecord.bestRating, opponentNewRating),
        wins: { increment: won ? 0 : 1 },
        losses: { increment: won ? 1 : 0 },
        streak: nextStreak(opponentRecord.streak, !won),
      },
    }),
    prisma.rpgProfile.update({
      where: { id: challengerProfile.id },
      data: { balance: { increment: reward.coins }, xp: { increment: reward.xp } },
    }),
    prisma.rpgArenaMatch.create({
      data: {
        guildId,
        challengerId: userId,
        opponentId,
        winnerId,
        ratingChange,
        challengerRatingAfter: newRating,
        opponentRatingAfter: opponentNewRating,
        coinsAwarded: reward.coins,
      },
    }),
  ]);

  logger.info('RpgArena', `Duel ${userId} vs ${opponentId} sur ${guildId} : ${won ? 'victoire' : 'défaite'} (${ratingChange} pts).`);

  return {
    won,
    opponentId,
    turns,
    ratingChange,
    newRating,
    opponentNewRating,
    streak: nextStreak(challengerRecord.streak, won),
    reward,
    challengerMaxHp: challenger.stats.maxHealth,
    opponentMaxHp: opponent.stats.maxHealth,
  };
}

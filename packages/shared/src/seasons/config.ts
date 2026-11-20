/**
 * Règles des saisons partagées entre le bot et le dashboard.
 *
 * Une saison ne remet rien à zéro : elle classe l'XP gagnée entre son ouverture
 * et sa clôture, pendant que l'XP des niveaux poursuit son cumul.
 */

export const SEASON_NAME_MAX = 80;
export const SEASON_REWARDS_MAX = 10;
export const SEASON_REWARD_RANK = { min: 1, max: 100 } as const;
export const SEASON_REWARD_COINS = { min: 0, max: 1_000_000 } as const;
export const SEASON_DURATION_DAYS = { min: 1, max: 366 } as const;
export const SEASON_TIERS_MAX = 5;
export const SEASON_TIER_XP = { min: 1, max: 10_000_000 } as const;

/** Ce que donne une récompense : rôle, pièces ou les deux. */
interface SeasonRewardParts {
  roleId: string | null;
  coins: number;
  /** Le rôle est repris à la clôture de la saison suivante, sauf à qui le regagne. Absent : gardé. */
  rotate?: boolean;
}

export interface SeasonReward extends SeasonRewardParts {
  rank: number;
}

/** Palier d'XP : tous ceux qui gagnent au moins `minXp` pendant la saison reçoivent la récompense. */
export interface SeasonTierReward extends SeasonRewardParts {
  minXp: number;
}

export type SeasonRewardError =
  | 'NOT_ARRAY'
  | 'TOO_MANY'
  | 'BAD_RANK'
  | 'BAD_ROLE'
  | 'BAD_COINS'
  | 'EMPTY_REWARD'
  | 'DUPLICATE_RANK';

export type SeasonTierError =
  | 'TIERS_NOT_ARRAY'
  | 'TOO_MANY_TIERS'
  | 'BAD_TIER_XP'
  | 'BAD_TIER_ROLE'
  | 'BAD_TIER_COINS'
  | 'EMPTY_TIER'
  | 'DUPLICATE_TIER';

export type SeasonScheduleError = 'BAD_NAME' | 'BAD_DATE' | 'END_BEFORE_START' | 'END_IN_PAST' | 'BAD_DURATION';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isIntIn(value: unknown, range: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** Rôle, pièces et reprise d'une récompense, mêmes règles pour un rang et pour un palier. */
function readRewardParts(item: Record<string, unknown> | null): SeasonRewardParts | 'BAD_ROLE' | 'BAD_COINS' | 'EMPTY_REWARD' {
  const rawRole = typeof item?.roleId === 'string' ? item.roleId.trim() : '';
  if (rawRole && !SNOWFLAKE_RE.test(rawRole)) return 'BAD_ROLE';
  const coins = item?.coins ?? 0;
  if (!isIntIn(coins, SEASON_REWARD_COINS)) return 'BAD_COINS';
  if (!rawRole && coins === 0) return 'EMPTY_REWARD';
  // Sans rôle, il n'y a rien à reprendre.
  return { roleId: rawRole || null, coins, ...(item?.rotate === true && rawRole ? { rotate: true } : {}) };
}

/** Valide une liste reçue de l'API. Rendue triée par rang. */
export function validateSeasonRewards(value: unknown): { rewards: SeasonReward[] } | { error: SeasonRewardError } {
  if (!Array.isArray(value)) return { error: 'NOT_ARRAY' };
  if (value.length > SEASON_REWARDS_MAX) return { error: 'TOO_MANY' };

  const rewards: SeasonReward[] = [];
  for (const item of value as Array<Record<string, unknown> | null>) {
    const rank = item?.rank;
    if (!isIntIn(rank, SEASON_REWARD_RANK)) return { error: 'BAD_RANK' };
    const parts = readRewardParts(item);
    if (typeof parts === 'string') return { error: parts };
    rewards.push({ rank, ...parts });
  }

  if (new Set(rewards.map((reward) => reward.rank)).size !== rewards.length) return { error: 'DUPLICATE_RANK' };
  return { rewards: rewards.sort((a, b) => a.rank - b.rank) };
}

/**
 * Relit le JSON enregistré sur la saison. Ce qui ne passe plus la validation
 * (ancienne forme, édition à la main) ne donne aucune récompense plutôt que
 * d'en donner une fausse.
 */
export function readStoredSeasonRewards(value: unknown): SeasonReward[] {
  const result = validateSeasonRewards(value ?? []);
  return 'rewards' in result ? result.rewards : [];
}

const TIER_PART_ERRORS = { BAD_ROLE: 'BAD_TIER_ROLE', BAD_COINS: 'BAD_TIER_COINS', EMPTY_REWARD: 'EMPTY_TIER' } as const;

/** Valide les paliers reçus de l'API. Rendus triés par seuil croissant. */
export function validateSeasonTiers(value: unknown): { tiers: SeasonTierReward[] } | { error: SeasonTierError } {
  if (!Array.isArray(value)) return { error: 'TIERS_NOT_ARRAY' };
  if (value.length > SEASON_TIERS_MAX) return { error: 'TOO_MANY_TIERS' };

  const tiers: SeasonTierReward[] = [];
  for (const item of value as Array<Record<string, unknown> | null>) {
    const minXp = item?.minXp;
    if (!isIntIn(minXp, SEASON_TIER_XP)) return { error: 'BAD_TIER_XP' };
    const parts = readRewardParts(item);
    if (typeof parts === 'string') return { error: TIER_PART_ERRORS[parts] };
    tiers.push({ minXp, ...parts });
  }

  if (new Set(tiers.map((tier) => tier.minXp)).size !== tiers.length) return { error: 'DUPLICATE_TIER' };
  return { tiers: tiers.sort((a, b) => a.minXp - b.minXp) };
}

/** Relit les paliers enregistrés ; illisibles, ils ne donnent rien plutôt qu'une fausse récompense. */
export function readStoredSeasonTiers(value: unknown): SeasonTierReward[] {
  const result = validateSeasonTiers(value ?? []);
  return 'tiers' in result ? result.tiers : [];
}

/**
 * Nom et dates d'une saison. Un début passé est accepté : la saison s'ouvre
 * dès sa création. Une fin passée, non : elle se clôturerait aussitôt, sans
 * avoir rien classé.
 */
export function validateSeasonSchedule(
  input: { name: unknown; startDate: unknown; endDate: unknown },
  now: Date = new Date(),
): { schedule: { name: string; startDate: Date; endDate: Date } } | { error: SeasonScheduleError } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > SEASON_NAME_MAX) return { error: 'BAD_NAME' };

  const startDate = typeof input.startDate === 'string' || input.startDate instanceof Date ? new Date(input.startDate) : null;
  const endDate = typeof input.endDate === 'string' || input.endDate instanceof Date ? new Date(input.endDate) : null;
  if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return { error: 'BAD_DATE' };
  if (endDate <= startDate) return { error: 'END_BEFORE_START' };
  if (endDate <= now) return { error: 'END_IN_PAST' };

  // Une seconde de marge : le formulaire va de 00:00 à 23:59:59, et une saison
  // d'un seul jour choisi doit compter pour un jour.
  const duration = endDate.getTime() - startDate.getTime() + 1000;
  if (duration < SEASON_DURATION_DAYS.min * DAY_MS || duration > SEASON_DURATION_DAYS.max * DAY_MS + 1000) return { error: 'BAD_DURATION' };

  return { schedule: { name, startDate, endDate } };
}

export interface PlannedSeasonReward {
  userId: string;
  rank: number;
  roleId: string | null;
  coins: number;
  rotate?: boolean;
  /** Seuil du palier qui donne cette récompense ; absent pour une récompense de rang. */
  tierXp?: number;
}

const rotateFlag = (reward: { rotate?: boolean }) => (reward.rotate ? { rotate: true } : {});

/**
 * Qui reçoit quoi à la clôture. Le rôle du premier (`topRoleId`) s'ajoute aux
 * récompenses du rang 1 sans les remplacer.
 */
export function planSeasonRewards(
  rewards: readonly SeasonReward[],
  standings: ReadonlyArray<{ userId: string; rank: number }>,
  topRoleId?: string | null,
): PlannedSeasonReward[] {
  const byRank = new Map(standings.map((entry) => [entry.rank, entry.userId]));
  const plan: PlannedSeasonReward[] = [];

  for (const reward of rewards) {
    const userId = byRank.get(reward.rank);
    if (userId) plan.push({ userId, rank: reward.rank, roleId: reward.roleId, coins: reward.coins, ...rotateFlag(reward) });
  }

  const winner = byRank.get(1);
  const alreadyGiven = plan.some((entry) => entry.rank === 1 && entry.roleId === topRoleId);
  if (winner && topRoleId && !alreadyGiven) plan.push({ userId: winner, rank: 1, roleId: topRoleId, coins: 0 });

  return plan;
}

/**
 * Récompenses de paliers : chaque palier atteint donne la sienne, cumulée avec
 * celles du rang. `members` : tous les classés au-dessus du plus bas seuil.
 */
export function planSeasonTiers(
  tiers: readonly SeasonTierReward[],
  members: ReadonlyArray<{ userId: string; rank: number; xp: number }>,
): PlannedSeasonReward[] {
  return tiers.flatMap((tier) => members
    .filter((member) => member.xp >= tier.minXp)
    .map((member) => ({ userId: member.userId, rank: member.rank, roleId: tier.roleId, coins: tier.coins, tierXp: tier.minXp, ...rotateFlag(tier) })));
}

/** Sort d'un rôle de récompense à la clôture. `blocked` : Discord le refusera (hiérarchie, intégration, permission). */
export type SeasonRoleOutcome = 'given' | 'blocked' | 'member_left' | 'failed';
/** Sort des pièces d'une récompense. */
export type SeasonCoinsOutcome = 'given' | 'economy_off' | 'failed';

/** Ce qu'un membre a réellement reçu ; un statut `null` : rien de tel n'était prévu. */
export interface SeasonRewardOutcome {
  userId: string;
  rank: number;
  roleId: string | null;
  coins: number;
  roleStatus: SeasonRoleOutcome | null;
  coinsStatus: SeasonCoinsOutcome | null;
  rotate?: boolean;
  tierXp?: number;
}

const ROLE_OUTCOMES: ReadonlySet<unknown> = new Set<SeasonRoleOutcome>(['given', 'blocked', 'member_left', 'failed']);
const COINS_OUTCOMES: ReadonlySet<unknown> = new Set<SeasonCoinsOutcome>(['given', 'economy_off', 'failed']);

/** Relit la trace enregistrée à la clôture ; une entrée illisible est écartée plutôt que devinée. */
export function readSeasonRewardOutcomes(value: unknown): SeasonRewardOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SeasonRewardOutcome => {
    const entry = item as Record<string, unknown> | null;
    return !!entry
      && typeof entry.userId === 'string'
      && typeof entry.rank === 'number'
      && (entry.roleId === null || typeof entry.roleId === 'string')
      && typeof entry.coins === 'number'
      && (entry.roleStatus === null || ROLE_OUTCOMES.has(entry.roleStatus))
      && (entry.coinsStatus === null || COINS_OUTCOMES.has(entry.coinsStatus))
      && (entry.rotate === undefined || typeof entry.rotate === 'boolean')
      && (entry.tierXp === undefined || typeof entry.tierXp === 'number');
  });
}

/**
 * Rôles « repris » remis à la saison d'avant, à retirer à la clôture de
 * celle-ci. Qui regagne le même rôle le garde.
 */
export function rolesToTakeBack(
  previous: readonly SeasonRewardOutcome[],
  plan: ReadonlyArray<{ userId: string; roleId: string | null }>,
): Array<{ userId: string; roleId: string }> {
  const kept = new Set(plan.filter((entry) => entry.roleId).map((entry) => `${entry.userId}:${entry.roleId}`));
  const seen = new Set<string>();
  const result: Array<{ userId: string; roleId: string }> = [];
  for (const outcome of previous) {
    if (!outcome.rotate || !outcome.roleId || outcome.roleStatus !== 'given') continue;
    const key = `${outcome.userId}:${outcome.roleId}`;
    if (kept.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push({ userId: outcome.userId, roleId: outcome.roleId });
  }
  return result;
}

/** Bilan chiffré figé à la clôture, pour comparer les saisons entre elles. */
export interface SeasonStats {
  /** Membres ayant gagné au moins 1 XP, au-delà des 100 figés au classement. */
  participants: number;
  totalXp: number;
  /** XP gagnée par le premier. */
  topXp: number;
}

export function readSeasonStats(value: unknown): SeasonStats | null {
  const stats = value as Record<string, unknown> | null;
  if (!stats || typeof stats !== 'object') return null;
  const { participants, totalXp, topXp } = stats;
  if (typeof participants !== 'number' || typeof totalXp !== 'number' || typeof topXp !== 'number') return null;
  return { participants, totalXp, topXp };
}

/** Tout ce qui était prévu pour ce membre lui a été donné. */
export function isRewardOutcomeComplete(outcome: SeasonRewardOutcome): boolean {
  return (outcome.roleStatus ?? 'given') === 'given' && (outcome.coinsStatus ?? 'given') === 'given';
}

/**
 * Dates de la saison qui prend la suite : même durée que celle prévue pour la
 * saison close (pas celle écourtée par une clôture anticipée), à partir de maintenant.
 */
export function renewedSeasonSchedule(planned: { startDate: Date; endDate: Date }, now: Date = new Date()): { startDate: Date; endDate: Date } {
  const days = Math.round((planned.endDate.getTime() - planned.startDate.getTime()) / DAY_MS);
  const bounded = Math.min(SEASON_DURATION_DAYS.max, Math.max(SEASON_DURATION_DAYS.min, days));
  return { startDate: now, endDate: new Date(now.getTime() + bounded * DAY_MS) };
}

/** Le rappel part dans les dernières heures d'une saison. */
export const SEASON_REMINDER_HOURS = 24;

/**
 * Le rappel est dû dans les dernières 24 h. Une saison de deux jours ou moins
 * n'en a pas : il tomberait sur son ouverture.
 */
export function seasonReminderDue(startDate: Date, endDate: Date, now: Date = new Date()): boolean {
  const windowMs = SEASON_REMINDER_HOURS * 60 * 60 * 1000;
  if (endDate.getTime() - startDate.getTime() <= 2 * DAY_MS) return false;
  return now < endDate && endDate.getTime() - now.getTime() <= windowMs;
}

/** Palmarès d'un membre à partir de ses rangs de saison. */
export function summarizeSeasonHistory(entries: ReadonlyArray<{ rank: number }>): { seasons: number; wins: number; podiums: number; bestRank: number | null } {
  return {
    seasons: entries.length,
    wins: entries.filter((entry) => entry.rank === 1).length,
    podiums: entries.filter((entry) => entry.rank <= 3).length,
    bestRank: entries.length > 0 ? Math.min(...entries.map((entry) => entry.rank)) : null,
  };
}

/** Avancement en pourcentage entier et jours restants, un jour entamé compté. */
export function seasonProgress(startDate: Date, endDate: Date, now: Date = new Date()): { percent: number; daysLeft: number } {
  const total = endDate.getTime() - startDate.getTime();
  const elapsed = now.getTime() - startDate.getTime();
  const percent = total > 0 ? Math.round(Math.min(100, Math.max(0, (elapsed / total) * 100))) : 100;
  const daysLeft = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / DAY_MS));
  return { percent, daysLeft };
}

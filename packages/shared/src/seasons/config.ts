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

export interface SeasonReward {
  rank: number;
  roleId: string | null;
  coins: number;
}

export type SeasonRewardError =
  | 'NOT_ARRAY'
  | 'TOO_MANY'
  | 'BAD_RANK'
  | 'BAD_ROLE'
  | 'BAD_COINS'
  | 'EMPTY_REWARD'
  | 'DUPLICATE_RANK';

export type SeasonScheduleError = 'BAD_NAME' | 'BAD_DATE' | 'END_BEFORE_START' | 'END_IN_PAST' | 'BAD_DURATION';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isIntIn(value: unknown, range: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** Valide une liste reçue de l'API. Rendue triée par rang. */
export function validateSeasonRewards(value: unknown): { rewards: SeasonReward[] } | { error: SeasonRewardError } {
  if (!Array.isArray(value)) return { error: 'NOT_ARRAY' };
  if (value.length > SEASON_REWARDS_MAX) return { error: 'TOO_MANY' };

  const rewards: SeasonReward[] = [];
  for (const item of value as Array<Record<string, unknown> | null>) {
    const rank = item?.rank;
    if (!isIntIn(rank, SEASON_REWARD_RANK)) return { error: 'BAD_RANK' };
    const rawRole = typeof item?.roleId === 'string' ? item.roleId.trim() : '';
    if (rawRole && !SNOWFLAKE_RE.test(rawRole)) return { error: 'BAD_ROLE' };
    const coins = item?.coins ?? 0;
    if (!isIntIn(coins, SEASON_REWARD_COINS)) return { error: 'BAD_COINS' };
    if (!rawRole && coins === 0) return { error: 'EMPTY_REWARD' };
    rewards.push({ rank, roleId: rawRole || null, coins });
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

  const days = (endDate.getTime() - startDate.getTime()) / DAY_MS;
  if (days < SEASON_DURATION_DAYS.min || days > SEASON_DURATION_DAYS.max) return { error: 'BAD_DURATION' };

  return { schedule: { name, startDate, endDate } };
}

export interface PlannedSeasonReward {
  userId: string;
  rank: number;
  roleId: string | null;
  coins: number;
}

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
    if (userId) plan.push({ userId, rank: reward.rank, roleId: reward.roleId, coins: reward.coins });
  }

  const winner = byRank.get(1);
  const alreadyGiven = plan.some((entry) => entry.rank === 1 && entry.roleId === topRoleId);
  if (winner && topRoleId && !alreadyGiven) plan.push({ userId: winner, rank: 1, roleId: topRoleId, coins: 0 });

  return plan;
}

/** Avancement en pourcentage entier et jours restants, un jour entamé compté. */
export function seasonProgress(startDate: Date, endDate: Date, now: Date = new Date()): { percent: number; daysLeft: number } {
  const total = endDate.getTime() - startDate.getTime();
  const elapsed = now.getTime() - startDate.getTime();
  const percent = total > 0 ? Math.round(Math.min(100, Math.max(0, (elapsed / total) * 100))) : 100;
  const daysLeft = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / DAY_MS));
  return { percent, daysLeft };
}

/**
 * Règles du module Réputation partagées entre le bot et le dashboard : les
 * bornes affichées dans le formulaire sont celles que l'API applique.
 */

export const REPUTATION_PERIODS = ['week', 'month', 'all'] as const;
export type ReputationPeriod = (typeof REPUTATION_PERIODS)[number];

/** Votes qu'un membre peut donner par jour du serveur. */
export const REPUTATION_DAILY_LIMIT = { min: 1, max: 20, default: 3 } as const;

/** Gains du membre remercié, par remerciement reçu. `0` = aucun gain. */
export const REPUTATION_XP_PER_REP = { min: 0, max: 500 } as const;
export const REPUTATION_COINS_PER_REP = { min: 0, max: 10_000 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS: Record<Exclude<ReputationPeriod, 'all'>, number> = { week: 7, month: 30 };

export function isReputationPeriod(value: unknown): value is ReputationPeriod {
  return typeof value === 'string' && (REPUTATION_PERIODS as readonly string[]).includes(value);
}

/**
 * Début d'une période de classement. Fenêtre glissante plutôt que semaine
 * calendaire : un classement « de la semaine » vide le lundi matin ne donne
 * rien à regarder.
 */
export function reputationPeriodStart(period: ReputationPeriod, now: Date = new Date()): Date | null {
  if (period === 'all') return null;
  return new Date(now.getTime() - PERIOD_DAYS[period] * DAY_MS);
}

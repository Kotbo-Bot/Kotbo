/**
 * Paliers de réputation : à un total donné, le membre reçoit un rôle.
 *
 * Partagé entre le bot (attribution, validation de l'API) et le dashboard
 * (bornes et contrôles du formulaire).
 */

export interface ReputationTier {
  threshold: number;
  roleId: string;
}

export const REPUTATION_TIERS_MAX = 20;
export const REPUTATION_TIER_THRESHOLD = { min: 1, max: 100_000 } as const;

const SNOWFLAKE_RE = /^\d{17,20}$/;

export type ReputationTierError =
  | 'NOT_ARRAY'
  | 'TOO_MANY'
  | 'BAD_THRESHOLD'
  | 'BAD_ROLE'
  | 'DUPLICATE_THRESHOLD'
  | 'DUPLICATE_ROLE';

function byThreshold<T extends ReputationTier>(tiers: readonly T[]): T[] {
  return [...tiers].sort((a, b) => a.threshold - b.threshold);
}

/** Paliers atteints en passant de `before` à `after`, du plus bas au plus haut. */
export function crossedTiers<T extends ReputationTier>(before: number, after: number, tiers: readonly T[]): T[] {
  return byThreshold(tiers).filter((tier) => tier.threshold > before && tier.threshold <= after);
}

/** Paliers qu'un total n'atteint pas : leurs rôles n'ont plus lieu d'être. */
export function tiersAbove<T extends ReputationTier>(total: number, tiers: readonly T[]): T[] {
  return byThreshold(tiers).filter((tier) => tier.threshold > total);
}

/** Valide une liste reçue de l'API. Rendue triée par seuil. */
export function validateReputationTiers(value: unknown): { tiers: ReputationTier[] } | { error: ReputationTierError } {
  if (!Array.isArray(value)) return { error: 'NOT_ARRAY' };
  if (value.length > REPUTATION_TIERS_MAX) return { error: 'TOO_MANY' };

  const tiers: ReputationTier[] = [];
  for (const item of value as Array<Record<string, unknown> | null>) {
    const threshold = item?.threshold;
    const roleId = typeof item?.roleId === 'string' ? item.roleId.trim() : '';
    if (
      typeof threshold !== 'number'
      || !Number.isInteger(threshold)
      || threshold < REPUTATION_TIER_THRESHOLD.min
      || threshold > REPUTATION_TIER_THRESHOLD.max
    ) {
      return { error: 'BAD_THRESHOLD' };
    }
    if (!SNOWFLAKE_RE.test(roleId)) return { error: 'BAD_ROLE' };
    tiers.push({ threshold, roleId });
  }

  if (new Set(tiers.map((tier) => tier.threshold)).size !== tiers.length) return { error: 'DUPLICATE_THRESHOLD' };
  if (new Set(tiers.map((tier) => tier.roleId)).size !== tiers.length) return { error: 'DUPLICATE_ROLE' };
  return { tiers: byThreshold(tiers) };
}

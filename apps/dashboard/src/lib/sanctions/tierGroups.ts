/**
 * Paliers répétés d'un tableau de sanctions.
 *
 * Le tableau reste une liste plate de paliers (1, 2, 3…), telle que le bot
 * l'enregistre et l'applique. L'éditeur montre seulement les paliers
 * identiques qui se suivent comme une seule ligne « × N » : « rappel × 8 puis
 * timeout » s'écrit en deux lignes au lieu de neuf.
 */

export interface TierLike {
  id?: string;
  level: number;
  action: string;
  durationSeconds: number | null;
  weight: number;
  customReason: string | null;
}

export interface TierGroup<T extends TierLike> {
  /** Index du premier palier du groupe dans la liste plate. */
  start: number;
  count: number;
  tier: T;
}

export const MAX_TIER_REPEAT = 50;
/** Durée d'un nouveau timeout ou ban temporaire : celle que l'éditeur affiche faute de valeur. */
export const DEFAULT_TIER_DURATION_SECONDS = 3600;
const ACTIONS_WITH_DURATION = ['TIMEOUT', 'TEMP_BAN'];

/**
 * Changement d'action d'un palier. Une action à durée reçoit la durée par
 * défaut si le palier n'en a pas : sans elle, l'éditeur affiche « 1 h » mais
 * le bot refuse l'enregistrement.
 */
export function actionPatch(tier: TierLike, action: string): Partial<TierLike> {
  if (ACTIONS_WITH_DURATION.includes(action) && !tier.durationSeconds) {
    return { action, durationSeconds: DEFAULT_TIER_DURATION_SECONDS };
  }
  return { action };
}

/** Même sanction : même action, même durée, même raison, et même gravité pour un avertissement. */
function sameTier(a: TierLike, b: TierLike): boolean {
  return a.action === b.action
    && (a.durationSeconds ?? null) === (b.durationSeconds ?? null)
    && (a.action !== 'WARN' || a.weight === b.weight)
    && (a.customReason || '') === (b.customReason || '');
}

export function groupTiers<T extends TierLike>(tiers: T[]): TierGroup<T>[] {
  const groups: TierGroup<T>[] = [];
  tiers.forEach((tier, index) => {
    const last = groups[groups.length - 1];
    if (last && sameTier(last.tier, tier)) last.count += 1;
    else groups.push({ start: index, count: 1, tier });
  });
  return groups;
}

function renumber<T extends TierLike>(tiers: T[]): T[] {
  return tiers.map((tier, index) => ({ ...tier, level: index + 1 }));
}

/** Passe un groupe à `nextCount` paliers : les copies reprennent le premier, les surplus partent. */
export function resizeGroup<T extends TierLike>(tiers: T[], start: number, count: number, nextCount: number): T[] {
  const size = Math.min(MAX_TIER_REPEAT, Math.max(1, Math.round(nextCount) || 1));
  const model = tiers[start];
  const group = Array.from({ length: size }, (_, i) => (i < count ? tiers[start + i] : { ...model, id: '' }));
  return renumber([...tiers.slice(0, start), ...group, ...tiers.slice(start + count)]);
}

export function patchGroup<T extends TierLike>(tiers: T[], start: number, count: number, patch: Partial<TierLike>): T[] {
  return tiers.map((tier, index) => (index >= start && index < start + count ? { ...tier, ...patch } : tier));
}

export function removeGroup<T extends TierLike>(tiers: T[], start: number, count: number): T[] {
  return renumber([...tiers.slice(0, start), ...tiers.slice(start + count)]);
}

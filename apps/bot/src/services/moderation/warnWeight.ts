/**
 * Un warn de poids 0 est un rappel : il reste dans l'historique du membre mais
 * ne compte ni dans le nombre de warns ni dans le score qui déclenche les seuils.
 */
export const REMINDER_WEIGHT = 0;
const MAX_WARN_WEIGHT = 3;

export function normalizeWarnWeight(weight: number | undefined): number {
  return Math.min(MAX_WARN_WEIGHT, Math.max(REMINDER_WEIGHT, weight ?? 1));
}

/** Gravité portée par un palier de tableau : seul un palier WARN en a une. */
export function tierWarnWeight(action: string, weight: unknown): number {
  if (action !== 'WARN') return 1;
  return normalizeWarnWeight(typeof weight === 'number' ? Math.floor(weight) : undefined);
}

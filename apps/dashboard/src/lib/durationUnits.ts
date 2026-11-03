/**
 * Durée saisie en « 2 heures » plutôt qu'en « 7200 secondes ». La valeur rangée
 * reste en secondes : seul l'affichage change d'unité.
 */
export type DurationUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export const DURATION_UNITS: { unit: DurationUnit; seconds: number }[] = [
  { unit: 'seconds', seconds: 1 },
  { unit: 'minutes', seconds: 60 },
  { unit: 'hours', seconds: 3600 },
  { unit: 'days', seconds: 86_400 },
];

/** La plus grande unité dans laquelle la durée s'exprime sans reste. */
export function splitDuration(seconds: number): { amount: number; unit: DurationUnit } {
  const fitting = [...DURATION_UNITS].reverse().find((entry) => seconds >= entry.seconds && seconds % entry.seconds === 0);
  const unit = fitting ?? DURATION_UNITS[0];
  return { amount: seconds / unit.seconds, unit: unit.unit };
}

export function toSeconds(amount: number, unit: DurationUnit): number {
  const size = DURATION_UNITS.find((entry) => entry.unit === unit)?.seconds ?? 1;
  return Math.max(1, Math.round(amount * size));
}

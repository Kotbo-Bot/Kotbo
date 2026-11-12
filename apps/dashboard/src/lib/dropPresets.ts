/**
 * Crans du mode simple de la page Drops.
 *
 * Chaque cran pose deux valeurs qui vont de pair. Ils vivent hors de la page pour être
 * confrontés aux bornes de `@kotbo/shared` (voir `dropPresets.test.ts`).
 */

/**
 * Attente d'activité, de la plus légère à la plus forte. Vingt messages en cinq minutes
 * ne veut rien dire pour un salon ordinaire : la fenêtre s'élargit avec l'exigence.
 */
export const ACTIVITY_PRESETS = [
  { minMessages: 2, windowMinutes: 15 },
  { minMessages: 3, windowMinutes: 15 },
  { minMessages: 5, windowMinutes: 15 },
  { minMessages: 10, windowMinutes: 20 },
  { minMessages: 20, windowMinutes: 30 },
] as const;

/** Cran posé quand on allume l'option : « Moyenne ». */
export const ACTIVITY_DEFAULT_STEP = 3;

/**
 * Jackpot, du plus rare au plus fréquent. Un jackpot fréquent doit rester modeste, sinon il
 * pèse sur l'économie : le gain moyen reste proche d'un cran à l'autre.
 */
export const JACKPOT_PRESETS = [
  { chance: 50, multiplier: 10 },
  { chance: 20, multiplier: 5 },
  { chance: 10, multiplier: 3 },
] as const;

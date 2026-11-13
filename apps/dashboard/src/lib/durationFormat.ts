/**
 * Durées des drops, saisies en minutes et affichées lisiblement (« 6 h », « 1 h 30 min »).
 * Les unités viennent d'`Intl` : elles suivent la langue de l'interface sans traduction
 * à tenir à jour.
 */
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

function unit(locale: string, value: number, name: 'day' | 'hour' | 'minute'): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
}

/** Équivalent lisible d'une durée en minutes ; vide pour une valeur absente ou nulle. */
export function formatDuration(minutes: number, locale: string): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const total = Math.round(minutes);
  const days = Math.floor(total / MINUTES_PER_DAY);
  const hours = Math.floor((total % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const rest = total % MINUTES_PER_HOUR;
  return [
    days > 0 ? unit(locale, days, 'day') : null,
    hours > 0 ? unit(locale, hours, 'hour') : null,
    rest > 0 ? unit(locale, rest, 'minute') : null,
  ].filter(Boolean).join(' ');
}

/** Crans proposés à un champ : ceux qui tombent dans ses bornes. */
export function presetsWithin(candidates: readonly number[], range: { min: number; max: number }): number[] {
  return candidates.filter((value) => value >= range.min && value <= range.max);
}

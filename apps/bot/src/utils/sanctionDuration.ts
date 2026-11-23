const DAY_MS = 24 * 60 * 60 * 1000;
// Mois de 30 jours et années de 365 : une durée de sanction n'a pas à suivre le calendrier.
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  seconde: 1000,
  secondes: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  heure: 60 * 60 * 1000,
  heures: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  j: 24 * 60 * 60 * 1000,
  jour: 24 * 60 * 60 * 1000,
  jours: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  semaine: 7 * 24 * 60 * 60 * 1000,
  semaines: 7 * 24 * 60 * 60 * 1000,
  mo: MONTH_MS,
  mois: MONTH_MS,
  month: MONTH_MS,
  months: MONTH_MS,
  y: YEAR_MS,
  an: YEAR_MS,
  ans: YEAR_MS,
  year: YEAR_MS,
  years: YEAR_MS,
};

function normalizeDurationInput(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ');
}

export function parseDurationToMs(input: string): number | null {
  const normalized = normalizeDurationInput(input);
  if (!normalized) return null;

  const pattern = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;
  let total = 0;
  let matched = false;

  for (const match of normalized.matchAll(pattern)) {
    const rawValue = match[1];
    const rawUnit = match[2];
    if (!rawValue || !rawUnit) continue;

    const value = Number(rawValue);
    const unit = rawUnit.toLowerCase();
    const unitMs = DURATION_UNITS_MS[unit];

    if (!Number.isFinite(value) || value <= 0 || !unitMs) {
      return null;
    }

    total += Math.round(value * unitMs);
    matched = true;
  }

  if (!matched) return null;
  if (total < 1000) return null;
  return total;
}

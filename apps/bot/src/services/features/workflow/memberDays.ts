/**
 * Fenêtres du balayage des déclencheurs d'ancienneté et d'inactivité.
 *
 * Un membre « atteint » son seuil à sa date de référence (arrivée, dernier
 * message) plus N jours. Chaque balayage prend les seuils tombés depuis le
 * précédent, ni plus ni moins : un redémarrage ne fait rien perdre, et un
 * passage n'est jamais compté deux fois.
 */

const DAY_MS = 86_400_000;

/** Dates de référence dont le seuil tombe dans `(from, to]`. */
export function crossingRange(from: Date, to: Date, days: number): { gt: Date; lte: Date } {
  return { gt: new Date(from.getTime() - days * DAY_MS), lte: new Date(to.getTime() - days * DAY_MS) };
}

/**
 * Jusqu'où le balayage est fait. Un lot plein s'arrête au seuil du dernier
 * membre traité : les suivants passent au balayage d'après.
 */
export function nextSweptUntil(input: {
  to: Date;
  days: number;
  found: number;
  limit: number;
  lastReference: Date | null;
}): Date {
  if (input.found < input.limit || !input.lastReference) return input.to;
  return new Date(input.lastReference.getTime() + input.days * DAY_MS);
}

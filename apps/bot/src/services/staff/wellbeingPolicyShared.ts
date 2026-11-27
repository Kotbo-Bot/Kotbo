/** Outils communs aux règles de la cellule de suivi. */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Texte nettoyé et tronqué à `max` caractères, ou `null` s'il est vide ou n'est pas un texte. */
export function trimmedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

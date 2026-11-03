/**
 * Recherche des sélecteurs d'automatisation (déclencheurs, actions).
 *
 * Insensible à la casse et aux accents, et mot par mot : « membre bienvenue »
 * trouve un déclencheur dont la phrase parle du membre et l'exemple de la
 * bienvenue.
 */

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function matchesQuery(query: string, texts: readonly string[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(texts.join(' '));
  return words.every((word) => haystack.includes(word));
}

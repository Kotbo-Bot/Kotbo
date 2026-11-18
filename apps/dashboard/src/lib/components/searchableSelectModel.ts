/**
 * Logique pure de `SearchableSelect`, sortie du composant pour etre testee.
 */

export type SelectOption = { id: string; name: string };

export function normalizeSearch(text: string): string {
  return (text || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * Options a afficher pour le texte saisi.
 *
 * Tant que le champ affiche le nom du choix courant, ce texte n'est pas une
 * recherche : filtrer dessus ne laissait que le choix courant dans la liste,
 * et il fallait passer par la croix pour voir les autres salons.
 */
export function filterOptions<T extends SelectOption>(options: readonly T[], query: string, selectedName: string | null): T[] {
  const search = selectedName !== null && query === selectedName ? '' : query;
  const needle = normalizeSearch(search);
  return (options || [])
    .filter((o) => normalizeSearch(o.name).includes(needle) || (o.id ?? '').includes(search))
    .filter((o, i, arr) => arr.findIndex((x) => x.id === o.id) === i);
}

/**
 * Texte a montrer dans le champ quand il n'est pas en cours de saisie : le nom
 * du choix courant, ou rien. `null` quand le choix n'est pas (encore) dans les
 * options, pour ne pas effacer le texte avant leur chargement.
 */
export function displayedText(value: string | null, options: readonly SelectOption[]): string | null {
  if (!value) return '';
  return options.find((o) => o.id === value)?.name ?? null;
}

/**
 * Longueur du texte d'une règle de tag de serveur.
 *
 * Un tag de serveur Discord fait 4 caractères au plus : en mode exact ou
 * contient, un texte plus long ne peut jamais correspondre. Une expression
 * régulière décrit plusieurs tags, elle garde donc plus de place.
 */

export const MAX_SERVER_TAG_LENGTH = 4;

const MAX_TAG_REGEX_LENGTH = 100;

export type TagMatchMode = 'EXACT' | 'CONTAINS' | 'REGEX';

export function tagPatternMaxLength(mode: TagMatchMode): number {
  return mode === 'REGEX' ? MAX_TAG_REGEX_LENGTH : MAX_SERVER_TAG_LENGTH;
}

/** Liste de tags saisie : en capitales, à la longueur d'un tag, sans vide ni doublon. */
export function normalizeTagList(values: readonly unknown[]): string[] {
  const tags = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0 && value.length <= MAX_SERVER_TAG_LENGTH);
  return [...new Set(tags)];
}

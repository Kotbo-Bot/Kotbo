/**
 * Listes de tags de serveur à bloquer, maintenues par Kotbo (#24).
 *
 * Chaque serveur active les catégories qu'il veut, choisit l'action, et peut
 * retirer un tag précis en cas de faux positif. Un tag Discord fait de 1 à 4
 * caractères : les entrées en tiennent compte.
 *
 * Les codes en lettres sont aussi reconnus sous leurs imitations (homoglyphes,
 * accents). Les codes chiffrés ne le sont que tels quels : ramener les chiffres
 * à des lettres ferait de « 88 » un « BB » innocent.
 */

export const TAG_PRESET_CATEGORIES = ['HATE', 'ANTISEMITISM', 'EXTREMISM', 'POLITICS'] as const;
export type TagPresetCategory = (typeof TAG_PRESET_CATEGORIES)[number];

/** Catégories posées quand un serveur active la détection ; la politique reste à cocher à part. */
export const DEFAULT_TAG_PRESET_CATEGORIES: readonly TagPresetCategory[] = ['HATE', 'ANTISEMITISM', 'EXTREMISM'];

export const TAG_PRESET_LISTS: Record<TagPresetCategory, readonly string[]> = {
  // Haine raciale : codes néonazis et suprémacistes.
  HATE: ['1488', '14', '88', 'HH', 'SS', 'KKK', 'AKIA', 'WPWW'],
  // Antisémitisme.
  ANTISEMITISM: ['ZOG', 'JQ', '6MWE'],
  // Groupes extrémistes ou terroristes.
  EXTREMISM: ['ISIS', 'ISIL', 'AWD', 'NSM', 'NRM'],
  // Partis et mouvements politiques, pour les serveurs qui interdisent la politique.
  POLITICS: ['RN', 'LFI', 'PS', 'LR', 'EELV', 'PCF', 'REC', 'NPA', 'MAGA', 'GOP'],
};

export function isTagPresetCategory(value: unknown): value is TagPresetCategory {
  return TAG_PRESET_CATEGORIES.includes(value as TagPresetCategory);
}

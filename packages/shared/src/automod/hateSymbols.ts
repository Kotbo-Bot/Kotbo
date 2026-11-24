/**
 * Symboles haineux en caractères Unicode (#22).
 *
 * Les listes de mots de l'AutoMod ne les voient pas : une croix gammée est un
 * caractère, pas un mot. Chaque serveur active la liste d'un coup, puis peut
 * autoriser un symbole précis : plusieurs ont un sens religieux ou culturel
 * (le svastika dans le bouddhisme, l'hindouisme, le jaïnisme).
 *
 * Variantes proches : les caractères invisibles sont retirés avant la
 * recherche, et les symboles doublés tolèrent une espace entre les deux.
 */

export interface HateSymbol {
  id: string;
  /** Nom utilisé dans le motif de sanction du bot. */
  label: string;
  /** Caractère montré dans le dashboard. */
  sample: string;
  /** Le symbole a aussi un sens religieux ou culturel. */
  religious: boolean;
  pattern: RegExp;
}

export const HATE_SYMBOLS: readonly HateSymbol[] = [
  { id: 'swastika', label: 'croix gammée', sample: '卐', religious: true, pattern: /卐/u },
  { id: 'manji', label: 'croix gammée inversée', sample: '卍', religious: true, pattern: /卍/u },
  { id: 'svasti_tibetan', label: 'svastika tibétain', sample: '࿕', religious: true, pattern: /[࿕-࿘]/u },
  { id: 'ss_runes', label: 'runes SS', sample: 'ᛋᛋ', religious: false, pattern: /ᛋ\s?ᛋ/u },
  { id: 'ss_lightning', label: 'éclairs SS', sample: 'ϟϟ', religious: false, pattern: /ϟ\s?ϟ/u },
];

const INVISIBLE = /[​-‍⁠﻿︎️]/g;

/** Premier symbole de la liste présent dans le texte, hors symboles autorisés par le serveur. */
export function findHateSymbol(content: string, allowedIds: readonly string[]): HateSymbol | null {
  if (!content) return null;
  const text = content.replace(INVISIBLE, '');
  return HATE_SYMBOLS.find((symbol) => !allowedIds.includes(symbol.id) && symbol.pattern.test(text)) ?? null;
}

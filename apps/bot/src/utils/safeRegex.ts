/**
 * Expressions régulières saisies par les admins (réponses automatiques).
 *
 * `RegExp.test` tourne sur le fil principal sans délai : un motif à retour arrière catastrophique
 * (`(a+)+$`) sur une entrée construite bloque tout le bot. Sans moteur linéaire (re2) disponible,
 * on refuse les formes qui le permettent et on borne l'entrée.
 *
 * shortcut: heuristique, elle refuse les quantificateurs imbriqués, les alternatives sous
 * quantificateur et les références arrière, mais ne prouve pas la sûreté de tout motif ;
 * passer à `re2` si ce garde-fou se révèle insuffisant.
 */

import { ALTERNATION_UNDER_QUANTIFIER, BACKREFERENCE, NESTED_QUANTIFIER } from '@kotbo/shared';

export const MAX_REGEX_LENGTH = 200;
export const MAX_REGEX_INPUT = 1000;

/** Raison du refus, ou `null` si le motif est accepté. */
export function regexProblem(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) return `Expression trop longue (${MAX_REGEX_LENGTH} caractères maximum).`;
  if (BACKREFERENCE.test(pattern)) return 'Les références arrière ne sont pas autorisées.';
  if (NESTED_QUANTIFIER.test(pattern) || ALTERNATION_UNDER_QUANTIFIER.test(pattern)) {
    return 'Expression trop coûteuse : évitez les groupes répétés qui contiennent eux-mêmes une répétition.';
  }
  try {
    new RegExp(pattern, 'i');
  } catch {
    return 'Expression régulière invalide.';
  }
  return null;
}

const compiled = new Map<string, RegExp | null>();

/** Teste un motif déjà validé ; un motif refusé ne correspond jamais. */
export function testSafeRegex(pattern: string, input: string): boolean {
  let regex = compiled.get(pattern);
  if (regex === undefined) {
    regex = regexProblem(pattern) ? null : new RegExp(pattern, 'i');
    if (compiled.size > 500) compiled.clear();
    compiled.set(pattern, regex);
  }
  return regex ? regex.test(input.slice(0, MAX_REGEX_INPUT)) : false;
}

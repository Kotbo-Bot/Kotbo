/**
 * Formes de motif à retour arrière catastrophique, refusées dans toute regex
 * qu'un admin saisit et que le bot évalue sur chaque message : quantificateur,
 * y compris `{n,}`, sur un groupe qui en contient déjà un, `(a+)+` ;
 * alternative sous quantificateur, `(a|a)+` ; référence arrière.
 */
export const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/;
export const ALTERNATION_UNDER_QUANTIFIER = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;
export const BACKREFERENCE = /\\[1-9]|\\k</;

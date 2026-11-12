/**
 * Remplissage des gabarits d'annonce renvoyés par le bot (`announcement` de la route des
 * drops). Un trou sans valeur reste visible plutôt que de disparaître : l'aperçu montre
 * alors ce qui manque au lieu d'un texte faussement complet.
 */
export function fillDropTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (marker, key: string) => values[key] ?? marker);
}

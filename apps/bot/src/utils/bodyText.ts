/**
 * Champ texte d'un corps JSON. Un client peut envoyer n'importe quel type :
 * appeler `.trim()` sur un nombre ferait planter la route en 500. Tout ce qui
 * n'est pas une chaîne devient une chaîne vide, que la route refuse ou ignore.
 */
export function bodyText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

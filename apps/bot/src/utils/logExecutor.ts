/**
 * Auteur d'un log avancé : un pseudo seul, ou un pseudo et son identifiant.
 *
 * Le journal du dashboard ne rend un auteur cliquable que s'il trouve son
 * identifiant, écrit `pseudo (<@id>)`. Sans lui, « Rôle créé » ou « Salon
 * supprimé » affichaient un auteur qu'on ne pouvait pas ouvrir.
 */
export type LogExecutor = string | { tag: string; id: string } | null | undefined;

/** Pseudo seul, pour le pied de page de l'embed. */
export function executorTag(executor: LogExecutor): string | null {
  if (!executor) return null;
  return typeof executor === 'string' ? executor : executor.tag;
}

/** Auteur inscrit au journal d'audit, identifiant compris quand il est connu. */
export function executorAuditUser(executor: LogExecutor): string {
  if (!executor) return 'Système';
  return typeof executor === 'string' ? executor : `${executor.tag} (<@${executor.id}>)`;
}

/**
 * Brouillon d'un formulaire au rafraîchissement du store : il suit le serveur
 * tant qu'il n'a pas été modifié depuis la dernière synchronisation, sinon la
 * saisie en cours est gardée.
 */
export function resyncDraft<T>(draft: T, synced: T, stored: T): T {
  return JSON.stringify(draft) === JSON.stringify(synced) ? stored : draft;
}

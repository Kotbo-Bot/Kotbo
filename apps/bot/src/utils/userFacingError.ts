/**
 * Erreur dont le message est rédigé pour l'utilisateur final. Les erreurs de
 * domaine (« Solde insuffisant », « Ce donjon est fermé ») en dérivent, et
 * `publicErrorMessage` (utils/publicError.ts) les laisse passer telles quelles.
 *
 * Fichier sans dépendance : les modules de politique pure en héritent sans
 * tirer Prisma, le journal ni Sentry.
 */
export class UserFacingError extends Error {
  readonly expose = true;
}

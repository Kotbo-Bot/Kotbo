/**
 * L'upsert Prisma n'est pas atomique : deux appels simultanés sur une ligne absente tentent
 * tous deux l'insertion, et le second échoue sur la contrainte d'unicité (P2002). Le
 * rejouer une fois suffit : la ligne existe désormais et l'upsert passe par la mise à jour.
 *
 * Vit hors de `db.ts` : les tests remplacent ce module en entier par un faux client, et un
 * helper pur n'a aucune raison d'être emporté avec lui.
 */
export async function upsertRetryingRace<T>(upsert: () => Promise<T>): Promise<T> {
  try {
    return await upsert();
  } catch (err) {
    if ((err as { code?: string })?.code !== 'P2002') throw err;
    return upsert();
  }
}

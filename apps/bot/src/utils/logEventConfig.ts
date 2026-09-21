/**
 * La configuration des logs, événement par événement : la clé de cache, et
 * l'écriture qui doit la vider.
 *
 * Module feuille — il n'importe ni Prisma ni le cache, l'appelant fournit ses
 * accès. Deux raisons, pas une :
 *
 * 1. Le site de **lecture** (`events/advancedLogs.ts`) et le site d'**écriture**
 *    (la route dashboard) partagent désormais la même fonction de clé. Deux
 *    formats qui divergent, c'est une invalidation qui ne vide rien — et rien
 *    ne le signalerait, la sauvegarde répondant `200`.
 * 2. L'écriture et l'invalidation sont **soudées** dans la même fonction : on
 *    ne peut plus enregistrer une configuration sans vider le cache, ce qui
 *    est exactement ce que faisait la route jusqu'ici.
 */

/**
 * La clé sous laquelle la configuration d'un événement est mise en cache.
 *
 * Le préfixe `guild:<id>:` n'est pas décoratif : c'est lui qui rend la clé
 * atteignable par `cache.invalidateGuild`.
 */
export function cleConfigEvenement(guildId: string, eventType: string): string {
  return `guild:${guildId}:log_event_config:${eventType}`;
}

export interface ConfigEvenementDemandee {
  eventType: string;
  enabled: boolean;
  channelId: string | null;
}

/** Les deux accès dont l'enregistrement a besoin, fournis par l'appelant. */
export interface EcritureConfigsEvenements {
  /** Écrit les configurations en base, en un seul lot. */
  enregistrer(configs: ReadonlyArray<ConfigEvenementDemandee>): Promise<void>;
  /** Retire une clé du cache (mémoire locale + Redis). */
  oublier(cle: string): Promise<void>;
}

/**
 * Enregistre les configurations demandées, puis vide le cache de chaque
 * événement touché. Rend les clés vidées, dans l'ordre.
 *
 * L'ordre compte : vider **avant** d'écrire laisserait une lecture concurrente
 * remettre l'ancienne valeur en cache pour soixante secondes, c'est-à-dire
 * exactement le défaut qu'on corrige, en plus rare et en plus difficile à
 * reproduire.
 */
export async function enregistrerConfigsEvenements(
  io: EcritureConfigsEvenements,
  guildId: string,
  demandees: ReadonlyArray<ConfigEvenementDemandee>,
): Promise<string[]> {
  await io.enregistrer(demandees);

  // Une même sauvegarde peut lister deux fois le même événement : la suite
  // d'écritures fait gagner la dernière, et une seule clé est à vider.
  const cles = [...new Set(demandees.map((config) => cleConfigEvenement(guildId, config.eventType)))];
  for (const cle of cles) {
    await io.oublier(cle);
  }

  return cles;
}

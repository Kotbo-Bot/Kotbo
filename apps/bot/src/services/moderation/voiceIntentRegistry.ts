/**
 * Qui a déplacé ou déconnecté ce membre en vocal.
 *
 * Le journal d'audit de Discord ne peut pas répondre : `MemberMove` et
 * `MemberDisconnect` n'ont **aucun `target_id`** — leur `extra` vaut
 * `{ channel, count }` et `{ count }`. Il est donc impossible de savoir de quel
 * membre une entrée parle. Pour les actions faites dans Discord, `advancedLogs`
 * apparie par la hausse du compteur (`voiceAuditAttribution.ts`) et se tait
 * dès que le lot d'événements est ambigu ; c'est une déduction, pas une preuve.
 *
 * Mais pour tout ce que **Kotbo** provoque lui-même, la question a une réponse
 * certaine : le code sait déjà qui a demandé le déplacement. Ce registre le lui
 * fait dire. L'appelant annonce son intention juste **avant** l'appel Discord,
 * l'écouteur `VOICE_STATE_UPDATE` la consomme quand l'événement arrive.
 *
 * Une `Map` de module suffit, et ce n'est pas une approximation : le
 * `ShardingManager` lance un processus par shard, chacun avec un seul `Client`,
 * et `registerAdvancedLogsListener` / `registerTempVoiceListener` / le captcha
 * vocal sont attachés à ce même client dans `index.ts`. Discord ne livre
 * `VOICE_STATE_UPDATE` qu'au shard qui possède le serveur : l'annonceur et le
 * consommateur d'un même serveur sont donc toujours le même processus. Quant à
 * l'outil MCP, il ne tourne que sur le shard 0 et échoue si le serveur n'est pas
 * dans son cache — un appel qui réussit tourne forcément au bon endroit.
 */

export type GenreIntentionVocale = 'move' | 'disconnect';

export interface AuteurIntentionVocale {
  /**
   * Texte affiché au pied de page du log. Jamais une mention : Discord ne les
   * résout pas dans un footer, elles s'y afficheraient telles quelles.
   */
  libelle: string;
}

interface IntentionEnAttente {
  auteur: AuteurIntentionVocale;
  perimeA: number;
}

/**
 * Large marge sur la latence REST + passerelle (moins de deux secondes en
 * pratique), assez court pour qu'une annonce jamais consommée — appel échoué
 * sans `catch`, course improbable — ne traîne pas en mémoire.
 */
const DUREE_DE_VIE_MS = 10_000;

/** `guildId:userId:genre` -> file d'annonces, la plus ancienne en tête. */
const enAttente = new Map<string, IntentionEnAttente[]>();

function cle(guildId: string, userId: string, genre: GenreIntentionVocale): string {
  return `${guildId}:${userId}:${genre}`;
}

function purger(maintenant: number): void {
  for (const [k, file] of enAttente) {
    const fraiches = file.filter((entree) => entree.perimeA > maintenant);
    if (fraiches.length === 0) enAttente.delete(k);
    else if (fraiches.length !== file.length) enAttente.set(k, fraiches);
  }
}

/**
 * Annonce un déplacement ou une déconnexion que le bot est sur le point de
 * poser. À appeler **avant** l'appel Discord, jamais après : l'écouteur peut
 * recevoir `VOICE_STATE_UPDATE` avant que l'`await` ne rende la main.
 *
 * La fonction rendue retire **cette** annonce précise — à appeler dans le
 * `.catch()` de l'appel Discord. Un appel qui échoue n'a produit aucun
 * changement d'état vocal ; laisser l'annonce traîner la ferait attribuer à
 * tort au premier déplacement sans rapport survenu avant péremption.
 */
export function annoncerIntentionVocale(
  guildId: string,
  userId: string,
  genre: GenreIntentionVocale,
  auteur: AuteurIntentionVocale,
  maintenant: number = Date.now(),
): () => void {
  purger(maintenant);

  const k = cle(guildId, userId, genre);
  const entree: IntentionEnAttente = { auteur, perimeA: maintenant + DUREE_DE_VIE_MS };
  const file = enAttente.get(k);
  if (file) file.push(entree);
  else enAttente.set(k, [entree]);

  return () => {
    const courante = enAttente.get(k);
    if (!courante) return;
    const i = courante.indexOf(entree);
    if (i !== -1) courante.splice(i, 1);
    if (courante.length === 0) enAttente.delete(k);
  };
}

/**
 * Rend l'auteur annoncé pour ce déplacement, s'il y en a un, et le consomme.
 *
 * File **FIFO** et non un emplacement unique : deux déplacements rapprochés du
 * même membre doivent être appariés dans l'ordre où ils ont été annoncés. Un
 * emplacement unique écraserait le premier, et le log du premier déplacement
 * porterait le nom de l'auteur du second.
 *
 * `undefined` ne veut pas dire « c'est le membre lui-même » : il veut dire
 * « Kotbo n'est pas à l'origine de ce changement ». L'appelant ne doit alors
 * afficher aucun auteur.
 */
export function prendreIntentionVocale(
  guildId: string,
  userId: string,
  genre: GenreIntentionVocale,
  maintenant: number = Date.now(),
): AuteurIntentionVocale | undefined {
  const k = cle(guildId, userId, genre);
  const file = enAttente.get(k);
  if (!file) return undefined;

  while (file.length > 0) {
    const entree = file.shift() as IntentionEnAttente;
    if (entree.perimeA > maintenant) {
      if (file.length === 0) enAttente.delete(k);
      return entree.auteur;
    }
  }

  enAttente.delete(k);
  return undefined;
}

/** Réservé aux tests : le registre est un état de module. */
export function reinitialiserIntentionsVocales(): void {
  enAttente.clear();
}

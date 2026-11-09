/**
 * Qui a déplacé ou déconnecté un membre en vocal, d'après le journal d'audit.
 *
 * `MemberMove` et `MemberDisconnect` n'ont pas de cible : Discord regroupe les
 * actions d'un même modérateur (et, pour un déplacement, vers un même salon)
 * dans UNE entrée dont `extra.count` s'incrémente. Le seul signal fiable est
 * donc la hausse d'un compteur entre deux lectures : on garde, par serveur, le
 * compteur déjà attribué de chaque entrée, et l'entrée qui a monté depuis est
 * l'auteur.
 *
 * Rend `string` (id de l'auteur), `null` (personne : le membre a agi lui-même)
 * ou `undefined` (impossible à dire : pas de relevé antérieur, ou deux
 * modérateurs différents candidats). On préfère ne rien afficher qu'un faux.
 */

export type EntreeAuditVocale = {
  id: string;
  createdTimestamp: number;
  executorId: string | null;
  count: number;
  channelId: string | null;
};

/** id d'entrée → compteur déjà attribué. */
export type ReleveAudit = Map<string, number>;

export function attribuerParCompteur(
  entrees: EntreeAuditVocale[],
  releve: ReleveAudit | undefined,
  salonId: string | null,
  now: number,
  fenetreMs: number,
): { auteurId: string | null | undefined; releve: ReleveAudit } {
  const suivant: ReleveAudit = new Map();
  const candidates: Array<{ entree: EntreeAuditVocale; base: number }> = [];

  for (const entree of entrees) {
    // Entrée jamais vue : récente, tout son compteur est neuf ; ancienne, on ne
    // sait pas ce qui a monté depuis, elle sert seulement de point de départ.
    const base = releve?.get(entree.id) ?? (now - entree.createdTimestamp <= fenetreMs ? 0 : entree.count);
    suivant.set(entree.id, base);
    if (salonId && entree.channelId !== salonId) continue;
    if (entree.executorId && entree.count > base) candidates.push({ entree, base });
  }

  const auteurs = new Set(candidates.map((c) => c.entree.executorId));
  if (auteurs.size === 1) {
    const { entree, base } = candidates[0];
    suivant.set(entree.id, base + 1);
    return { auteurId: entree.executorId, releve: suivant };
  }
  if (auteurs.size > 1) {
    // Ambigu : on solde les compteurs, sinon chaque événement suivant le serait aussi.
    for (const { entree } of candidates) suivant.set(entree.id, entree.count);
    return { auteurId: undefined, releve: suivant };
  }
  return { auteurId: releve ? null : undefined, releve: suivant };
}

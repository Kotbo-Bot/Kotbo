/**
 * Qui a déplacé ou déconnecté un membre en vocal, d'après le journal d'audit.
 *
 * `MemberMove` et `MemberDisconnect` n'ont pas de cible : Discord regroupe les
 * actions d'un même modérateur (et, pour un déplacement, vers un même salon)
 * dans UNE entrée dont `extra.count` s'incrémente. Le seul signal est donc la
 * hausse d'un compteur entre deux lectures, et une hausse ne dit pas QUEL
 * membre elle concerne.
 *
 * Les événements proches sont donc jugés ensemble : un auteur n'est donné que
 * si un seul modérateur a agi et que ses hausses couvrent tous les événements
 * du lot. Sinon, personne : une absence de hausse ne prouve pas non plus que
 * le membre a agi seul (exclusion, timeout, salon supprimé n'en laissent pas).
 * On préfère ne rien afficher qu'un faux.
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

/**
 * Un auteur (ou `null`) par événement, dans l'ordre de `salons` : le salon
 * d'arrivée d'un déplacement, `null` pour une déconnexion. Les entrées de
 * `botId` sont soldées sans compter : Kotbo annonce ses actions par le registre
 * d'intention, et ces événements n'arrivent pas jusqu'ici.
 */
export function attribuerLot(
  entrees: EntreeAuditVocale[],
  releve: ReleveAudit | undefined,
  salons: Array<string | null>,
  botId: string | undefined,
  now: number,
  fenetreMs: number,
): { auteurs: Array<string | null>; releve: ReleveAudit } {
  // Entrée jamais vue : récente, tout son compteur est neuf ; ancienne, on ne
  // sait pas ce qui a monté depuis, elle sert seulement de point de départ.
  const bases = new Map(entrees.map((e) => [
    e.id,
    releve?.get(e.id) ?? (now - e.createdTimestamp <= fenetreMs ? 0 : e.count),
  ]));
  const suivant: ReleveAudit = new Map(bases);
  const auteurParSalon = new Map<string | null, string | null>();

  for (const salonId of new Set(salons)) {
    const evenements = salons.filter((s) => s === salonId).length;
    const auteurs = new Set<string | null>();
    let hausses = 0;
    for (const entree of entrees) {
      if (salonId && entree.channelId !== salonId) continue;
      const hausse = entree.count - (bases.get(entree.id) ?? entree.count);
      // Soldé dans tous les cas : un reste serait pris pour l'action suivante.
      suivant.set(entree.id, entree.count);
      if (hausse <= 0 || entree.executorId === botId) continue;
      hausses += hausse;
      auteurs.add(entree.executorId);
    }
    const [seul = null] = auteurs;
    auteurParSalon.set(salonId, auteurs.size === 1 && hausses >= evenements ? seul : null);
  }

  return { auteurs: salons.map((s) => auteurParSalon.get(s) ?? null), releve: suivant };
}

/**
 * Regroupe les demandes d'une même clé : le lot part après `calmeMs` sans
 * nouvelle demande, ou au plus tard `plafondMs` après la première. Les lots
 * d'une clé passent l'un après l'autre, et un échec répond `null` à tout le lot.
 */
export function creerRegroupeurLots<D, R>(
  traiter: (cle: string, demandes: D[]) => Promise<R[]>,
  { calmeMs, plafondMs }: { calmeMs: number; plafondMs: number },
): (cle: string, demande: D) => Promise<R | null> {
  type Lot = {
    debut: number;
    attentes: Array<{ demande: D; repondre: (r: R | null) => void }>;
    minuteur?: ReturnType<typeof setTimeout>;
  };
  const lots = new Map<string, Lot>();
  const files = new Map<string, Promise<void>>();

  const fermer = (cle: string, lot: Lot) => {
    lots.delete(cle);
    const suite = (files.get(cle) ?? Promise.resolve())
      .then(() => traiter(cle, lot.attentes.map((a) => a.demande)))
      .then(
        (reponses) => lot.attentes.forEach((a, i) => a.repondre(reponses[i] ?? null)),
        () => lot.attentes.forEach((a) => a.repondre(null)),
      )
      .finally(() => {
        if (files.get(cle) === suite) files.delete(cle);
      });
    files.set(cle, suite);
  };

  return (cle, demande) => new Promise((repondre) => {
    const lot: Lot = lots.get(cle) ?? { debut: Date.now(), attentes: [] };
    lots.set(cle, lot);
    lot.attentes.push({ demande, repondre });
    clearTimeout(lot.minuteur);
    const reste = Math.max(0, lot.debut + plafondMs - Date.now());
    lot.minuteur = setTimeout(() => fermer(cle, lot), Math.min(calmeMs, reste));
  });
}

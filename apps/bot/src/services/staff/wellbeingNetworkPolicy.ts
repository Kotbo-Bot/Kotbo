/**
 * Référents partagés entre les cellules de suivi d'un réseau de serveurs,
 * sans accès à la base ni à Discord.
 *
 * Une cellule qui partage ses référents peut confier un dossier à un membre
 * d'une autre cellule du réseau qui partage aussi : un regard extérieur quand
 * la personne concernée connaît trop bien l'équipe locale, ou des bras en
 * plus pour une petite cellule. Le référent du réseau lit et annote ce seul
 * dossier depuis la cellule de son propre serveur ; la cellule d'origine
 * garde la main sur tout le reste (statut, plan d'action, signaleur).
 *
 * L'accès n'est jamais copié : il se vérifie à chaque requête, si bien que
 * couper le partage d'un côté, quitter le réseau ou sortir de sa cellule le
 * ferme aussitôt.
 */

/** Entrée d'historique quand le référent du réseau change. */
export const NETWORK_REFERENT_EVENT = 'NETWORK_REFERENT';

/** Valeur d'une entrée VIEWED laissée par le référent du réseau. */
export const NETWORK_VIEW = 'NETWORK';

export function sharesNetworkPool(config: { enabled: boolean; networkPool?: boolean } | null | undefined): boolean {
  return !!config && config.enabled && config.networkPool === true;
}

export interface PoolCandidate {
  userId: string;
  /** Serveur dont la cellule compte ce membre : il y lira le dossier. */
  guildId: string;
}

/**
 * Référents proposés à la cellule de `homeGuildId` : les membres des autres
 * cellules qui partagent, sans ceux de la cellule d'origine (ils suivent déjà
 * le dossier) ni les personnes écartées (la personne concernée).
 */
export function networkPoolCandidates(
  cells: ReadonlyArray<{ guildId: string; memberIds: readonly string[] }>,
  homeGuildId: string,
  excludeIds: readonly string[],
): PoolCandidate[] {
  const excluded = new Set([...excludeIds, ...(cells.find((cell) => cell.guildId === homeGuildId)?.memberIds ?? [])]);
  const candidates: PoolCandidate[] = [];
  for (const cell of cells) {
    if (cell.guildId === homeGuildId) continue;
    for (const userId of cell.memberIds) {
      if (excluded.has(userId)) continue;
      excluded.add(userId);
      candidates.push({ userId, guildId: cell.guildId });
    }
  }
  return candidates;
}

/** Refus de désigner ce référent du réseau, ou null s'il convient. */
export function networkReferentError(
  candidate: PoolCandidate,
  pool: readonly PoolCandidate[],
  subjectUserId: string | null,
): string | null {
  if (subjectUserId && candidate.userId === subjectUserId) {
    return 'La personne concernée ne peut pas suivre son propre dossier.';
  }
  if (!pool.some((entry) => entry.userId === candidate.userId && entry.guildId === candidate.guildId)) {
    return "Ce membre ne fait pas partie d'une cellule du réseau qui partage ses référents.";
  }
  return null;
}

/** Le référent du réseau lit le dossier tant que toutes ces conditions tiennent. */
export function networkReferentAllowed(state: {
  assigned: boolean;
  sameNetwork: boolean;
  caseCellShares: boolean;
  homeCellShares: boolean;
  isHomeTeamMember: boolean;
  isSubject: boolean;
}): boolean {
  return state.assigned && state.sameNetwork && state.caseCellShares && state.homeCellShares
    && state.isHomeTeamMember && !state.isSubject;
}

/** Message privé au référent désigné : aucun contenu du dossier, seulement où le lire. */
export function networkReferentText(caseGuildName: string): string {
  return `La cellule de suivi de ${caseGuildName} vous confie le suivi d'un dossier en tant que référent du réseau. `
    + 'Ouvrez-le depuis la cellule de suivi de votre serveur, dans le dashboard (Dossiers du réseau).';
}

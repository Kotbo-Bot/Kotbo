/**
 * Ouverture d'un poste de recrutement d'apres ses compteurs. Fichier sans
 * dependance : teste sans base ni client Discord.
 */

export type AutoCloseReason = 'PENDING' | 'ACCEPTED';

/**
 * Un poste ferme a la main (`autoClosedReason` vide) reste ferme : seul ce que
 * le bot a ferme lui-meme peut se rouvrir tout seul.
 */
export function decideFormAvailability(state: {
  isActive: boolean;
  autoClosedReason: string | null;
  pending: number;
  accepted: number;
  maxPending: number | null;
  maxAccepted: number | null;
}): { isActive: boolean; autoClosedReason: AutoCloseReason | null } {
  if (!state.isActive && !state.autoClosedReason) return { isActive: false, autoClosedReason: null };

  // Le plafond d'acceptes passe avant : il ne se leve pas en tranchant des candidatures.
  if (state.maxAccepted !== null && state.accepted >= state.maxAccepted) return { isActive: false, autoClosedReason: 'ACCEPTED' };
  if (state.maxPending !== null && state.pending >= state.maxPending) return { isActive: false, autoClosedReason: 'PENDING' };
  return { isActive: true, autoClosedReason: null };
}

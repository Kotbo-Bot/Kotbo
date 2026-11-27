/** Conservation des dossiers de la cellule de suivi : effacement, préavis, corbeille et effacement anticipé. */
import { DAY_MS } from './wellbeingPolicyShared.js';

/** Durée de conservation d'un dossier fermé, comptée depuis sa dernière modification. */
export const CLOSED_CASE_RETENTION_DAYS = 365;

/** Un dossier fermé et inchangé avant cette date est supprimé. */
export function closedCaseCutoff(now: Date): Date {
  return new Date(now.getTime() - CLOSED_CASE_RETENTION_DAYS * DAY_MS);
}

/** Date d'effacement d'un dossier fermé, comptée depuis sa dernière modification. */
export function casePurgeDate(updatedAt: Date): Date {
  return new Date(updatedAt.getTime() + CLOSED_CASE_RETENTION_DAYS * DAY_MS);
}

/** La cellule est prévenue ce nombre de jours avant l'effacement d'un dossier fermé. */
export const PURGE_NOTICE_DAYS = 7;

/** Un dossier fermé modifié avant cette date sera effacé dans `PURGE_NOTICE_DAYS` jours ou moins. */
export function purgeNoticeCutoff(now: Date): Date {
  return closedCaseCutoff(new Date(now.getTime() + PURGE_NOTICE_DAYS * DAY_MS));
}

/** Seul un dossier annoncé avant cette date peut être effacé : le préavis est toujours tenu. */
export function purgeWarnedCutoff(now: Date): Date {
  return new Date(now.getTime() - PURGE_NOTICE_DAYS * DAY_MS);
}

// ── Corbeille et conflit d'intérêts ───────────────────────────────────────

/** Un dossier supprimé reste restaurable ce nombre de jours, puis il est purgé. */
export const CASE_TRASH_DAYS = 30;

/** Un dossier mis à la corbeille avant cette date est purgé. */
export function trashCutoff(now: Date): Date {
  return new Date(now.getTime() - CASE_TRASH_DAYS * DAY_MS);
}

/** Une demande d'effacement anticipé attend sa seconde clé ce nombre d'heures. */
export const PURGE_REQUEST_HOURS = 72;

interface PurgeRequestState {
  deletedAt: Date | null;
  purgeRequestedById: string | null;
  purgeRequestedAt: Date | null;
}

const purgeRequestExpired = (requestedAt: Date, now: Date) =>
  now.getTime() - requestedAt.getTime() >= PURGE_REQUEST_HOURS * 60 * 60 * 1000;

/** Une demande d'effacement attend sa validation : elle ne peut pas être remplacée. */
export function purgeRequestPending(item: PurgeRequestState, now: Date): boolean {
  return !!item.purgeRequestedById && !!item.purgeRequestedAt && !purgeRequestExpired(item.purgeRequestedAt, now);
}

/**
 * Raison de refuser l'effacement définitif d'un dossier de la corbeille avant
 * son délai, ou `null`. Une seconde personne de la cellule doit valider.
 */
export function purgeApprovalError(
  item: PurgeRequestState,
  approverId: string,
  now: Date,
): 'not_trashed' | 'not_requested' | 'self' | 'expired' | null {
  if (!item.deletedAt) return 'not_trashed';
  if (!item.purgeRequestedById || !item.purgeRequestedAt) return 'not_requested';
  if (item.purgeRequestedById === approverId) return 'self';
  if (purgeRequestExpired(item.purgeRequestedAt, now)) return 'expired';
  return null;
}

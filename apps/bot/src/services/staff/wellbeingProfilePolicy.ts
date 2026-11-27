/**
 * Fiches confidentielles de la cellule bien-être, sans accès à la base.
 *
 * Une fiche réunit ce que la cellule sait d'une personne, sans qu'il y ait
 * quoi que ce soit à traiter : des notes datées, chiffrées, sans statut ni
 * relance. Quand une situation demande d'agir, la cellule ouvre un dossier.
 *
 * Chaque note a sa propre échéance : rien n'est gardé sans limite. La durée
 * se règle entre 1 et 36 mois (12 par défaut) et tombe à 3 mois quand la
 * personne quitte le serveur. Avant l'effacement, la cellule est prévenue et
 * peut prolonger une note en disant pourquoi : la prolongation est tracée.
 */
import { PURGE_NOTICE_DAYS } from './wellbeingPolicy.js';

export const PROFILE_RETENTION_DEFAULT_MONTHS = 12;
export const PROFILE_RETENTION_MIN_MONTHS = 1;
export const PROFILE_RETENTION_MAX_MONTHS = 36;
/** Durée de vie d'une note une fois la personne partie du serveur. */
export const PROFILE_DEPARTURE_MONTHS = 3;
/** Même plafond qu'une note de dossier. */
export const PROFILE_NOTE_MAX = 4000;
export const PROFILE_EXTEND_REASON_MAX = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Durée réglée par le propriétaire, bornée ; undefined si la valeur n'est pas un entier. */
export function cleanProfileRetention(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return Math.min(Math.max(value, PROFILE_RETENTION_MIN_MONTHS), PROFILE_RETENTION_MAX_MONTHS);
}

/** `months` mois après `date`, au calendrier : le 31 janvier plus un mois donne le 28 février. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Échéance d'une note écrite ou prolongée maintenant : la durée réglée, ou
 * le délai de départ si la personne a quitté le serveur, le plus court des deux.
 */
export function profileNoteExpiry(now: Date, retentionMonths: number, subjectLeftAt: Date | null): Date {
  const months = subjectLeftAt ? Math.min(retentionMonths, PROFILE_DEPARTURE_MONTHS) : retentionMonths;
  return addMonths(now, months);
}

/** Échéance la plus lointaine d'une note quand la personne quitte le serveur maintenant. */
export function departureCap(now: Date): Date {
  return addMonths(now, PROFILE_DEPARTURE_MONTHS);
}

/** Une note qui expire avant cette date est annoncée à la cellule. */
export function profilePurgeNoticeCutoff(now: Date): Date {
  return new Date(now.getTime() + PURGE_NOTICE_DAYS * DAY_MS);
}

/** Seule une note annoncée avant cette date peut être effacée : le préavis est toujours tenu. */
export function profilePurgeWarnedCutoff(now: Date): Date {
  return new Date(now.getTime() - PURGE_NOTICE_DAYS * DAY_MS);
}

/** Refus de prolonger une note, ou null : garder plus longtemps se justifie. */
export function profileExtendError(reason: string): string | null {
  return reason.trim() ? null : 'Indiquez pourquoi cette note doit être gardée plus longtemps.';
}

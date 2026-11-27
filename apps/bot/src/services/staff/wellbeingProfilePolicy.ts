/**
 * Fiches confidentielles de la cellule de suivi, sans accès à la base.
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
/**
 * Durée de vie d'une note sensible (santé, vie privée), cochée par qui l'écrit :
 * ces données appellent plus de prudence (RGPD, article 9).
 */
export const PROFILE_SENSITIVE_MONTHS = 3;
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

export interface ProfileNoteContext {
  subjectLeftAt: Date | null;
  sensitive: boolean;
}

/**
 * Durée de vie d'une note, en mois : la durée réglée, ramenée au délai de
 * départ si la personne a quitté le serveur, et à celui des notes sensibles.
 */
export function noteRetentionMonths(retentionMonths: number, note: ProfileNoteContext): number {
  return Math.min(
    retentionMonths,
    note.subjectLeftAt ? PROFILE_DEPARTURE_MONTHS : Infinity,
    note.sensitive ? PROFILE_SENSITIVE_MONTHS : Infinity,
  );
}

/** Échéance d'une note écrite ou prolongée maintenant. */
export function profileNoteExpiry(now: Date, retentionMonths: number, note: ProfileNoteContext): Date {
  return addMonths(now, noteRetentionMonths(retentionMonths, note));
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

/** Refus d'ouvrir sa propre fiche : elle serait lue ou écrite par la personne qu'elle concerne. */
export const PROFILE_SELF_REFUSAL = 'Cette fiche vous concerne : seuls les autres membres de la cellule peuvent la tenir.';

/** Refus de prolonger une note, ou null : garder plus longtemps se justifie. */
export function profileExtendError(reason: string): string | null {
  return reason.trim() ? null : 'Indiquez pourquoi cette note doit être gardée plus longtemps.';
}

/**
 * Nouvelle échéance d'une note quand le propriétaire baisse la durée réglée :
 * la note ne vit pas plus que cette durée depuis son écriture ou sa dernière
 * prolongation, préavis d'une semaine tenu. null si elle n'a pas à changer :
 * une hausse ne rallonge rien, garder plus longtemps se justifie note par note.
 */
export function shortenedExpiry(
  note: { createdAt: Date; extendedAt: Date | null; expiresAt: Date; sensitive?: boolean },
  retentionMonths: number,
  now: Date,
): Date | null {
  // Le départ du serveur a déjà ramené l'échéance : seul le caractère sensible compte ici.
  const months = noteRetentionMonths(retentionMonths, { subjectLeftAt: null, sensitive: note.sensitive === true });
  const target = addMonths(note.extendedAt ?? note.createdAt, months);
  const notice = profilePurgeNoticeCutoff(now);
  const next = target > notice ? target : notice;
  return next < note.expiresAt ? next : null;
}

/** Nouveau nom à écrire sur la fiche, ou null : seul un pseudo différent et non vide la réécrit. */
export function profileNameChange(stored: string | null, current: string): string | null {
  const name = current.trim();
  return name && name !== stored ? name : null;
}

/** Refus d'effacer une note, ou null : seul son auteur revient sur ce qu'il a écrit. */
export function profileNoteDeleteError(authorId: string, userId: string): string | null {
  return authorId === userId ? null : "Seule la personne qui a écrit cette note peut l'effacer.";
}

/** Règles d'un dossier de suivi : visibilité, historique, pièces jointes, clôture et protocole de crise. */
import { createHash } from 'node:crypto';
import { shouldSendReadAlert } from './wellbeingAlertPolicy.js';
import { DAY_MS, trimmedText } from './wellbeingPolicyShared.js';

/**
 * Dossiers qu'une personne peut voir sur ce serveur : jamais ceux qui la
 * concernent (conflit d'intérêts), et la corbeille à part. Le `OR` garde les
 * dossiers sans membre lié, qu'un simple `not` écarterait (NULL en SQL).
 */
export function caseVisibilityWhere(guildId: string, viewerId: string, options: { trashed?: boolean } = {}) {
  return {
    guildId,
    deletedAt: options.trashed ? { not: null } : null,
    OR: [{ subjectUserId: null }, { subjectUserId: { not: viewerId } }],
  };
}

/** La personne est-elle celle que le dossier concerne ? Elle ne le voit alors pas. */
export function isCaseSubject(subjectUserId: string | null, userId: string | null): boolean {
  return !!subjectUserId && !!userId && subjectUserId === userId;
}

/** La personne concernée ne suit pas son propre dossier. */
export function assigneeConflict(subjectUserId: string | null, assigneeId: string | null): boolean {
  return isCaseSubject(subjectUserId, assigneeId);
}

/** Une ouverture de dossier est tracée au plus une fois par période et par personne. */
export function shouldRecordView(lastViewedAt: Date | null, now: Date): boolean {
  return shouldSendReadAlert(lastViewedAt?.getTime(), now.getTime());
}

// ── Historique ─────────────────────────────────────────────────────────────

export interface CaseTracked {
  status: string;
  severity: string;
  assigneeId: string | null;
  reviewAt: Date | null;
}

export interface CaseEventDraft {
  type: 'STATUS' | 'SEVERITY' | 'ASSIGNEE' | 'REVIEW';
  fromValue: string | null;
  toValue: string | null;
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

/** Entrées d'historique d'une modification : un champ changé, une entrée. */
export function caseChangeEvents(before: CaseTracked, patch: Partial<CaseTracked>): CaseEventDraft[] {
  const events: CaseEventDraft[] = [];
  const push = (type: CaseEventDraft['type'], from: string | null, to: string | null) => {
    if (from !== to) events.push({ type, fromValue: from, toValue: to });
  };
  if (patch.status !== undefined) push('STATUS', before.status, patch.status);
  if (patch.severity !== undefined) push('SEVERITY', before.severity, patch.severity);
  if (patch.assigneeId !== undefined) push('ASSIGNEE', before.assigneeId, patch.assigneeId);
  if (patch.reviewAt !== undefined) push('REVIEW', iso(before.reviewAt), iso(patch.reviewAt));
  return events;
}

// ── Historique chaîné ──────────────────────────────────────────────────────

export interface ChainedCaseEvent {
  caseId: string;
  type: string;
  actorId: string | null;
  actorName: string;
  fromValue: string | null;
  toValue: string | null;
  createdAt: Date;
}

/**
 * Empreinte d'une entrée d'historique, liée à la précédente : une entrée
 * modifiée ou retirée directement en base casse la suite des empreintes.
 */
export function caseEventHash(previousHash: string | null, event: ChainedCaseEvent): string {
  const fields = [previousHash ?? '', event.caseId, event.type, event.actorId ?? '', event.actorName,
    event.fromValue ?? '', event.toValue ?? '', event.createdAt.toISOString()];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Vérifie l'historique d'un dossier, dans l'ordre chronologique. Les entrées
 * écrites avant le chaînage (sans empreinte) ne sont admises qu'en tête :
 * `partial` dit alors que seule la suite est garantie.
 */
export function verifyCaseEventChain(events: ReadonlyArray<ChainedCaseEvent & { hash: string | null }>): 'ok' | 'partial' | 'broken' {
  let previous: string | null = null;
  let chained = false;
  let legacy = false;
  for (const event of events) {
    if (!event.hash) {
      if (chained) return 'broken';
      legacy = true;
      continue;
    }
    if (caseEventHash(previous, event) !== event.hash) return 'broken';
    previous = event.hash;
    chained = true;
  }
  return legacy ? 'partial' : 'ok';
}

// ── Documents Google Drive ─────────────────────────────────────────────────

/** Hôtes acceptés : Drive et les éditeurs Docs, Sheets, Slides, Forms. */
const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
export const MAX_CASE_ATTACHMENTS = 20;
/** Plan d'action : tâches par dossier et longueur d'un libellé. */
export const MAX_CASE_TASKS = 30;
export const TASK_LABEL_MAX = 200;
export const ATTACHMENT_LABEL_MAX = 120;

/**
 * Lien vers un document Google Drive, ou `null`. Seul le lien est gardé : le
 * fichier reste chez Google, et ses droits de partage décident qui l'ouvre.
 */
export function cleanDriveLink(value: unknown): string | null {
  const raw = trimmedText(value, 500);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !DRIVE_HOSTS.has(url.hostname)) return null;
    return raw;
  } catch {
    return null;
  }
}

// ── Relances et signalements ───────────────────────────────────────────────

export function staleCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// ── Motif de clôture ───────────────────────────────────────────────────────

/** Comment un dossier se termine : le bilan les compte. */
export const CLOSE_REASONS = ['RESOLVED', 'REFERRED', 'NO_FOLLOWUP', 'DUPLICATE'] as const;

export function cleanCloseReason(input: unknown): (typeof CLOSE_REASONS)[number] | null {
  return CLOSE_REASONS.find((reason) => reason === input) ?? null;
}

// ── Correction d'une note ──────────────────────────────────────────────────

/** Une note se corrige par son auteur, dans ce délai ; la version d'origine reste lisible. */
export const NOTE_EDIT_HOURS = 48;

export function canEditNote(note: { authorId: string; createdAt: Date }, editorId: string, now: Date): boolean {
  return note.authorId === editorId && now.getTime() - note.createdAt.getTime() < NOTE_EDIT_HOURS * 60 * 60 * 1000;
}

// ── Protocole de crise ─────────────────────────────────────────────────────

/**
 * Étapes ajoutées au plan d'action d'un dossier qui devient critique, avec
 * leur délai en heures. Elles se cochent comme toute tâche.
 */
export const CRISIS_PROTOCOL_TASKS: ReadonlyArray<{ label: string; dueHours: number }> = [
  { label: 'Contacter la personne concernée et vérifier sa sécurité immédiate', dueHours: 2 },
  { label: "Lui transmettre les ressources d'urgence (numéros d'écoute, secours)", dueHours: 2 },
  { label: 'Prévenir la direction si un danger immédiat est en jeu', dueHours: 4 },
  { label: 'Consigner les échanges dans une note du dossier', dueHours: 24 },
  { label: 'Faire le point avec un autre membre de la cellule', dueHours: 48 },
];
/** Échéance de suivi d'un dossier critique qui n'en a pas. */
export const CRISIS_REVIEW_HOURS = 48;

/** Le dossier vient de devenir critique et le protocole ne lui a pas encore été appliqué. */
export function crisisProtocolDue(
  previousSeverity: string | null,
  nextSeverity: string,
  options: { enabled: boolean; applied: boolean },
): boolean {
  return options.enabled && !options.applied && nextSeverity === 'CRITICAL' && previousSeverity !== 'CRITICAL';
}

/** Tâches du protocole pour un dossier : les étapes de la cellule, sinon celles de départ. */
export function crisisTaskDrafts(
  now: Date,
  tasks: ReadonlyArray<{ label: string; dueHours: number }> = CRISIS_PROTOCOL_TASKS,
): Array<{ label: string; dueAt: Date }> {
  return tasks.map((task) => ({ label: task.label, dueAt: new Date(now.getTime() + task.dueHours * 60 * 60 * 1000) }));
}

// ── Prise de nouvelles après clôture ───────────────────────────────────────

export const MAX_FOLLOW_UP_DAYS = 180;

/** Date du rappel « prendre des nouvelles » d'un dossier fermé, ou `null`. Seul un dossier résolu y a droit. */
export function followUpDate(closedAt: Date, days: number, closedReason: string | null): Date | null {
  if (closedReason !== 'RESOLVED' || days <= 0) return null;
  return new Date(closedAt.getTime() + days * DAY_MS);
}

// ── Transfert d'un ticket ──────────────────────────────────────────────────

export function ticketCaseSummary(ticket: { reason: string; description: string; ticketTypeLabel: string | null; username: string }): string {
  const header = `Ticket « ${ticket.ticketTypeLabel || 'sans type'} » ouvert par ${ticket.username}.`;
  return [header, `Motif : ${ticket.reason}`, ticket.description].filter(Boolean).join('\n\n').slice(0, 4000);
}

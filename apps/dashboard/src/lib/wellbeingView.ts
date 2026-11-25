/**
 * Logique d'affichage de la page Bien-être : teintes des pastilles, filtre
 * de la liste, chiffres clés et chronologie d'un dossier. Sans dépendance à
 * Svelte, pour être testée seule.
 */

export interface WbNoteView {
  id: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface WbEventView {
  id: string;
  type: string;
  actorName: string;
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
}

/** Champs d'un dossier lus par la page ; l'API en renvoie d'autres. */
export interface WbCaseView {
  id: string;
  status: string;
  severity: string;
  reviewAt: string | null;
  notes?: WbNoteView[];
  events?: WbEventView[];
}

export type WbCaseFilter = 'active' | 'closed' | 'all';

export type WbTimelineEntry =
  | { kind: 'note'; id: string; at: string; note: WbNoteView }
  | { kind: 'event'; id: string; at: string; event: WbEventView };

const PILL = 'border';
const NEUTRAL = `bg-surface-container-high/40 text-on-surface-variant border-outline-variant/30 ${PILL}`;

const STATUS_TONES: Record<string, string> = {
  OPEN: `bg-primary/10 text-primary border-primary/20 ${PILL}`,
  MONITORING: `bg-warning/10 text-on-warning-container border-warning/20 ${PILL}`,
  CLOSED: NEUTRAL,
};

const SEVERITY_TONES: Record<string, string> = {
  LOW: `bg-success/10 text-on-success-container border-success/20 ${PILL}`,
  NORMAL: `bg-surface-container-high/60 text-on-surface border-outline-variant/40 ${PILL}`,
  HIGH: `bg-warning/15 text-on-warning-container border-warning/30 ${PILL}`,
  CRITICAL: `bg-error/15 text-on-error-container border-error/30 ${PILL}`,
};

/** Liseré gauche d'une ligne de dossier, de la couleur de sa gravité. */
const SEVERITY_ACCENTS: Record<string, string> = {
  LOW: 'border-l-success/60',
  NORMAL: 'border-l-outline-variant',
  HIGH: 'border-l-warning',
  CRITICAL: 'border-l-error',
};

const ACTIVE = new Set(['OPEN', 'MONITORING']);
const URGENT = new Set(['HIGH', 'CRITICAL']);

export const wbStatusTone = (code: string): string => STATUS_TONES[code] ?? NEUTRAL;
export const wbSeverityTone = (code: string): string => SEVERITY_TONES[code] ?? NEUTRAL;
export const wbSeverityAccent = (code: string): string => SEVERITY_ACCENTS[code] ?? SEVERITY_ACCENTS.NORMAL;

const isActive = (c: WbCaseView) => ACTIVE.has(c.status);

/** Date de revue atteinte (jour compris) sur un dossier encore actif. */
export function wbIsReviewDue(c: WbCaseView, now: Date): boolean {
  if (!c.reviewAt || !isActive(c)) return false;
  return c.reviewAt.slice(0, 10) <= now.toISOString().slice(0, 10);
}

export function wbFilterCases<T extends WbCaseView>(cases: T[], filter: WbCaseFilter): T[] {
  if (filter === 'active') return cases.filter(isActive);
  if (filter === 'closed') return cases.filter((c) => !isActive(c));
  return cases;
}

export function wbCaseStats(cases: WbCaseView[], now: Date) {
  const active = cases.filter(isActive);
  return {
    active: active.length,
    urgent: active.filter((c) => URGENT.has(c.severity)).length,
    reviewDue: active.filter((c) => wbIsReviewDue(c, now)).length,
    closed: cases.length - active.length,
  };
}

/**
 * Notes et historique en une seule chronologie, du plus récent au plus ancien.
 * L'entrée « note ajoutée » est retirée : la note elle-même la remplace.
 */
export function wbCaseTimeline(c: WbCaseView): WbTimelineEntry[] {
  const notes: WbTimelineEntry[] = (c.notes ?? []).map((note) => ({ kind: 'note', id: note.id, at: note.createdAt, note }));
  const events: WbTimelineEntry[] = (c.events ?? [])
    .filter((event) => event.type !== 'NOTE')
    .map((event) => ({ kind: 'event', id: event.id, at: event.createdAt, event }));
  return [...notes, ...events].sort((a, b) => b.at.localeCompare(a.at));
}

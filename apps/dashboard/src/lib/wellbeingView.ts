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

/**
 * Champs d'un dossier lus par la page ; l'API en renvoie d'autres. La liste
 * n'a que l'en-tête, le contenu (notes, historique) vient du dossier ouvert.
 */
export interface WbCaseView {
  id: string;
  status: string;
  severity: string;
  reviewAt: string | null;
  title?: string;
  subjectName?: string;
  subjectUserId?: string | null;
  source?: string;
  assigneeId?: string | null;
  updatedAt?: string;
  notes?: WbNoteView[];
  events?: WbEventView[];
}

export type WbCaseFilter = 'triage' | 'active' | 'mine' | 'closed' | 'all';
export type WbCaseSort = 'recent' | 'severity' | 'review';

/** Inactivité au-delà de laquelle la page masque le dossier ouvert. */
export const WB_IDLE_LOCK_MS = 5 * 60 * 1000;

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
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 3, HIGH: 2, NORMAL: 1, LOW: 0 };

export const wbStatusTone = (code: string): string => STATUS_TONES[code] ?? NEUTRAL;
export const wbSeverityTone = (code: string): string => SEVERITY_TONES[code] ?? NEUTRAL;
export const wbSeverityAccent = (code: string): string => SEVERITY_ACCENTS[code] ?? SEVERITY_ACCENTS.NORMAL;

const isActive = (c: WbCaseView) => ACTIVE.has(c.status);
/** Signalement reçu depuis Discord que personne n'a encore pris en charge. */
const needsTriage = (c: WbCaseView) => isActive(c) && c.source === 'DISCORD' && !c.assigneeId;

/** Date de revue atteinte (jour compris) sur un dossier encore actif. */
export function wbIsReviewDue(c: WbCaseView, now: Date): boolean {
  if (!c.reviewAt || !isActive(c)) return false;
  return c.reviewAt.slice(0, 10) <= now.toISOString().slice(0, 10);
}

/** `viewerId` : la personne connectée, pour « mes dossiers ». */
export function wbFilterCases<T extends WbCaseView>(cases: T[], filter: WbCaseFilter, viewerId?: string): T[] {
  if (filter === 'triage') return cases.filter(needsTriage);
  if (filter === 'mine') return cases.filter((c) => isActive(c) && !!viewerId && c.assigneeId === viewerId);
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
    triage: active.filter(needsTriage).length,
  };
}

/** Texte comparable : sans casse ni accents. */
const fold = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Recherche sur le titre et la personne concernée. */
export function wbSearchCases<T extends WbCaseView>(cases: T[], query: string): T[] {
  const needle = fold(query.trim());
  if (!needle) return cases;
  return cases.filter((c) => fold(`${c.title ?? ''} ${c.subjectName ?? ''}`).includes(needle));
}

const byRecent = (a: WbCaseView, b: WbCaseView) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

/** Copie triée : activité récente, gravité décroissante, ou échéance la plus proche (sans échéance en dernier). */
export function wbSortCases<T extends WbCaseView>(cases: T[], sort: WbCaseSort): T[] {
  const sorted = [...cases];
  if (sort === 'severity') {
    return sorted.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || byRecent(a, b));
  }
  if (sort === 'review') {
    return sorted.sort((a, b) => {
      if (!a.reviewAt || !b.reviewAt) return (a.reviewAt ? -1 : 0) + (b.reviewAt ? 1 : 0) || byRecent(a, b);
      return a.reviewAt.localeCompare(b.reviewAt);
    });
  }
  return sorted.sort(byRecent);
}

/** Autres dossiers sur le même membre du serveur. */
export function wbLinkedCases<T extends WbCaseView>(cases: T[], current: WbCaseView): T[] {
  if (!current.subjectUserId) return [];
  return cases.filter((c) => c.id !== current.id && c.subjectUserId === current.subjectUserId);
}

/**
 * En-tête de la liste après une modification : les champs du dossier renvoyé
 * remplacent les anciens, sans y faire entrer son contenu.
 */
const HEADER_FIELDS = ['title', 'subjectName', 'subjectUserId', 'status', 'severity', 'category', 'source', 'assigneeId', 'reviewAt', 'updatedAt'] as const;

export function wbMergeHeader<T extends WbCaseView>(header: T, item: Record<string, unknown>): T {
  const fresh = Object.fromEntries(HEADER_FIELDS.filter((key) => key in item).map((key) => [key, item[key]]));
  return { ...header, ...fresh };
}

/** Date du champ `<input type="date">`, `days` jours après aujourd'hui (heure locale). */
export function wbReviewShortcut(now: Date, days: number): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

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

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mêmes durées que le bot (CLOSED_CASE_RETENTION_DAYS, PURGE_NOTICE_DAYS). */
const RETENTION_DAYS = 365;
const PURGE_NOTICE_DAYS = 7;

/** Date d'effacement d'un dossier fermé, et si elle tombe dans la semaine. */
export function wbPurgeInfo(c: WbCaseView, now: Date): { date: Date; soon: boolean } | null {
  if (c.status !== 'CLOSED' || !c.updatedAt) return null;
  const date = new Date(new Date(c.updatedAt).getTime() + RETENTION_DAYS * DAY_MS);
  return { date, soon: date.getTime() - now.getTime() <= PURGE_NOTICE_DAYS * DAY_MS };
}

export function wbTaskProgress(tasks: ReadonlyArray<{ doneAt: string | null }> | undefined) {
  const total = tasks?.length ?? 0;
  const done = tasks?.filter((task) => task.doneAt).length ?? 0;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export interface WbExportContent {
  title: string;
  meta: string[];
  summary: string;
  notes: Array<{ author: string; date: string; content: string }>;
  tasks: Array<{ label: string; done: boolean }>;
  attachments: Array<{ label: string; url: string }>;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Page imprimable d'un dossier, filigranée au nom de qui l'exporte : une copie
 * qui circule dit d'où elle sort. Tout le contenu est échappé.
 */
export function wbCaseExportHtml(
  content: WbExportContent,
  labels: { summary: string; notes: string; tasks: string; attachments: string; exported: string },
  watermark: string,
): string {
  const e = escapeHtml;
  const section = (title: string, body: string) => (body ? `<h2>${e(title)}</h2>${body}` : '');
  const notes = content.notes.map((note) => `<div class="note"><p class="meta">${e(note.author)} · ${e(note.date)}</p><p>${e(note.content)}</p></div>`).join('');
  const tasks = content.tasks.length ? `<ul>${content.tasks.map((task) => `<li>${task.done ? '[x]' : '[ ]'} ${e(task.label)}</li>`).join('')}</ul>` : '';
  const attachments = content.attachments.length ? `<ul>${content.attachments.map((item) => `<li>${e(item.label)} : ${e(item.url)}</li>`).join('')}</ul>` : '';
  const mark = e(watermark);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(content.title)}</title><style>
body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 24px;position:relative}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
p{white-space:pre-wrap;margin:4px 0}.meta{color:#555;font-size:12px}.note{margin:8px 0;padding-left:10px;border-left:3px solid #ccc}
.mark{position:fixed;inset:0;display:flex;flex-wrap:wrap;align-content:space-around;justify-content:space-around;pointer-events:none;opacity:.08;font-size:28px;transform:rotate(-30deg);z-index:9}
footer{margin-top:32px;color:#555;font-size:12px}
</style></head><body><div class="mark" aria-hidden="true">${Array.from({ length: 12 }, () => `<span>${mark}</span>`).join('')}</div>
<h1>${e(content.title)}</h1><p class="meta">${content.meta.map(e).join(' · ')}</p>
${section(labels.summary, `<p>${e(content.summary)}</p>`)}${section(labels.notes, notes)}${section(labels.tasks, tasks)}${section(labels.attachments, attachments)}
<footer>${e(labels.exported)}</footer></body></html>`;
}

/** Charge de la cellule de suivi : bilan, résumé hebdomadaire, échéances, référents absents ou surchargés. */
import { isCaseSubject } from './wellbeingCasePolicy.js';
import { DAY_MS } from './wellbeingPolicyShared.js';

// ── Bilan de la cellule ────────────────────────────────────────────────────

export interface CellStatsCase {
  status: string;
  severity: string;
  category: string;
  source: string;
  assigneeId: string | null;
  createdAt: Date;
  closedReason?: string | null;
  events: ReadonlyArray<{ type: string; toValue: string | null; createdAt: Date }>;
}

const MONTHS_IN_STATS = 6;
const monthKey = (date: Date) => date.toISOString().slice(0, 7);

/**
 * Chiffres du bilan, sans contenu : dossiers ouverts et fermés, charge active,
 * délai médian de prise en charge des signalements Discord, six derniers mois.
 */
export function wellbeingCellStats(cases: readonly CellStatsCase[], now: Date) {
  const since = now.getTime() - 30 * DAY_MS;
  const closedAt = (item: CellStatsCase) =>
    [...item.events].reverse().find((event) => event.type === 'STATUS' && event.toValue === 'CLOSED')?.createdAt ?? null;
  const active = cases.filter((item) => item.status !== 'CLOSED');

  const activeByCategory: Record<string, number> = {};
  for (const item of active) activeByCategory[item.category] = (activeByCategory[item.category] ?? 0) + 1;
  // Fermés sans motif (avant les motifs, ou fermés depuis Discord) : comptés à part.
  const closedByReason: Record<string, number> = {};
  for (const item of cases.filter((c) => c.status === 'CLOSED')) {
    const reason = item.closedReason ?? 'UNSPECIFIED';
    closedByReason[reason] = (closedByReason[reason] ?? 0) + 1;
  }

  const triageHours = cases
    .filter((item) => item.source === 'DISCORD')
    .map((item) => {
      const first = item.events.find((event) => event.type === 'ASSIGNEE' && event.toValue);
      return first ? (first.createdAt.getTime() - item.createdAt.getTime()) / 3_600_000 : null;
    })
    .filter((hours): hours is number => hours !== null)
    .sort((a, b) => a - b);
  const middle = Math.floor(triageHours.length / 2);
  const medianTriageHours = triageHours.length === 0
    ? null
    : Math.round(triageHours.length % 2 ? triageHours[middle]! : (triageHours[middle - 1]! + triageHours[middle]!) / 2);

  const months = Array.from({ length: MONTHS_IN_STATS }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_IN_STATS - 1 - index), 1));
    return { month: monthKey(date), opened: 0, closed: 0 };
  });
  const byMonth = new Map(months.map((entry) => [entry.month, entry]));
  for (const item of cases) {
    const opened = byMonth.get(monthKey(item.createdAt));
    if (opened) opened.opened += 1;
    const closed = closedAt(item);
    const closedEntry = closed && item.status === 'CLOSED' ? byMonth.get(monthKey(closed)) : undefined;
    if (closedEntry) closedEntry.closed += 1;
  }

  return {
    openedLast30: cases.filter((item) => item.createdAt.getTime() >= since).length,
    closedLast30: cases.filter((item) => {
      const closed = closedAt(item);
      return item.status === 'CLOSED' && !!closed && closed.getTime() >= since;
    }).length,
    active: active.length,
    criticalUnassigned: active.filter((item) => item.severity === 'CRITICAL' && !item.assigneeId).length,
    activeByCategory,
    closedByReason,
    medianTriageHours,
    months,
  };
}

// ── Résumé hebdomadaire ────────────────────────────────────────────────────

/** Un résumé ne part qu'une fois par semaine et par serveur. */
export const DIGEST_INTERVAL_DAYS = 6;

/** Message privé du lundi : des chiffres, jamais de titre ni de personne. `null` s'il n'y a rien. */
export function weeklyDigestText(
  guildName: string,
  counts: { assigned: number; reviewsThisWeek: number; triage: number; criticalUnassigned: number; notesExpiring?: number },
): string | null {
  if (Object.values(counts).every((value) => !value)) return null;
  return [
    `Cellule de suivi de ${guildName}, votre semaine :`,
    `- dossiers dont vous êtes référent : ${counts.assigned}`,
    `- échéances de suivi cette semaine : ${counts.reviewsThisWeek}`,
    `- signalements à trier : ${counts.triage}`,
    `- dossiers critiques sans référent : ${counts.criticalUnassigned}`,
    ...(counts.notesExpiring ? [`- notes de fiche effacées cette semaine : ${counts.notesExpiring} (à prolonger avec un motif si besoin)`] : []),
    ...(counts.assigned >= REFERENT_OVERLOAD_ACTIVE
      ? [`Vous suivez ${counts.assigned} dossiers : pensez à en confier à un collègue moins chargé.`]
      : []),
    'Le détail est sur la page Suivi confidentiel du dashboard.',
  ].join('\n');
}

/**
 * Chiffres du résumé d'une personne de la cellule. Les dossiers qui la
 * concernent sont écartés, comme partout ailleurs (conflit d'intérêts).
 */
export function digestCounts(
  cases: ReadonlyArray<{ status: string; severity: string; source: string; assigneeId: string | null; subjectUserId: string | null; reviewAt: Date | null }>,
  memberId: string,
  now: Date,
  profileNotes: ReadonlyArray<{ subjectUserId: string; expiresAt: Date }> = [],
) {
  const visible = cases.filter((item) => item.status !== 'CLOSED' && !isCaseSubject(item.subjectUserId, memberId));
  const mine = visible.filter((item) => item.assigneeId === memberId);
  const weekEnd = now.getTime() + 7 * DAY_MS;
  return {
    assigned: mine.length,
    reviewsThisWeek: mine.filter((item) => item.reviewAt && item.reviewAt.getTime() <= weekEnd).length,
    triage: visible.filter((item) => item.source === 'DISCORD' && !item.assigneeId).length,
    criticalUnassigned: visible.filter((item) => item.severity === 'CRITICAL' && !item.assigneeId).length,
    notesExpiring: profileNotes.filter((note) => !isCaseSubject(note.subjectUserId, memberId) && note.expiresAt.getTime() <= weekEnd).length,
  };
}

/** Envoi hebdomadaire : le lundi, à partir de `hour` (UTC), une fois par semaine. */
export function weeklyDue(lastSentAt: Date | null, now: Date, hour: number): boolean {
  if (now.getUTCDay() !== 1 || now.getUTCHours() < hour) return false;
  return !lastSentAt || now.getTime() - lastSentAt.getTime() >= DIGEST_INTERVAL_DAYS * DAY_MS;
}

/** Le résumé part le lundi, à partir de 8 h (UTC), une fois par semaine. */
export function digestDue(lastSentAt: Date | null, now: Date): boolean {
  return weeklyDue(lastSentAt, now, 8);
}

// ── Mes échéances ──────────────────────────────────────────────────────────

const AGENDA_DAYS = 7;

export interface AgendaItem {
  caseId: string;
  kind: 'review' | 'task';
  dueAt: Date;
  overdue: boolean;
}

/**
 * Échéances d'une personne de la cellule sur les 7 prochains jours, retards
 * compris : suivi des dossiers dont elle est référente, et ses tâches (une
 * tâche sans responsable revient au référent du dossier). Sans contenu.
 */
export function agendaItems(
  cases: ReadonlyArray<{ id: string; status: string; assigneeId: string | null; reviewAt: Date | null }>,
  tasks: ReadonlyArray<{ caseId: string; assigneeId: string | null; dueAt: Date | null; doneAt: Date | null }>,
  viewerId: string,
  now: Date,
): AgendaItem[] {
  const horizon = now.getTime() + AGENDA_DAYS * DAY_MS;
  const active = new Map(cases.filter((item) => item.status !== 'CLOSED').map((item) => [item.id, item]));
  const item = (caseId: string, kind: AgendaItem['kind'], dueAt: Date): AgendaItem =>
    ({ caseId, kind, dueAt, overdue: dueAt.getTime() < now.getTime() });
  const reviews = [...active.values()]
    .filter((c) => c.assigneeId === viewerId && c.reviewAt && c.reviewAt.getTime() <= horizon)
    .map((c) => item(c.id, 'review', c.reviewAt!));
  const mine = tasks
    .filter((task) => !task.doneAt && task.dueAt && task.dueAt.getTime() <= horizon && active.has(task.caseId))
    .filter((task) => (task.assigneeId ?? active.get(task.caseId)?.assigneeId) === viewerId)
    .map((task) => item(task.caseId, 'task', task.dueAt!));
  return [...reviews, ...mine].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

// ── Référent absent ────────────────────────────────────────────────────────

/** Absence en cours, prise en compte ou validée (une simple demande ne suffit pas). */
export function absenceActive(
  absence: { status: string; isVoid: boolean; endedAt: Date | null; startDate: Date; endDate: Date | null; isIndefinite: boolean },
  now: Date,
): boolean {
  if (!['APPROVED', 'ACKNOWLEDGED'].includes(absence.status) || absence.isVoid || absence.endedAt) return false;
  if (absence.startDate.getTime() > now.getTime()) return false;
  return absence.isIndefinite || !absence.endDate || absence.endDate.getTime() > now.getTime();
}

/** Qui reçoit la relance d'un dossier : le référent, ou son suppléant s'il est absent. */
export function reminderRecipient(assigneeId: string | null, absentIds: ReadonlySet<string>, backupUserId: string | null): string | null {
  if (!assigneeId) return null;
  if (absentIds.has(assigneeId) && backupUserId && backupUserId !== assigneeId) return backupUserId;
  return assigneeId;
}

// ── Charge des référents ───────────────────────────────────────────────────

/** Au-delà de ce nombre de dossiers actifs, un référent est signalé comme surchargé. */
export const REFERENT_OVERLOAD_ACTIVE = 8;

export interface ReferentLoad {
  userId: string;
  active: number;
  critical: number;
  overloaded: boolean;
}

/** Dossiers actifs de chaque membre de la cellule, ceux sans dossier compris. */
export function referentLoad(
  cases: ReadonlyArray<{ status: string; severity: string; assigneeId: string | null }>,
  teamIds: readonly string[],
): ReferentLoad[] {
  const load = new Map(teamIds.map((userId) => [userId, { userId, active: 0, critical: 0, overloaded: false }]));
  for (const item of cases) {
    if (item.status === 'CLOSED' || !item.assigneeId) continue;
    const entry = load.get(item.assigneeId) ?? { userId: item.assigneeId, active: 0, critical: 0, overloaded: false };
    entry.active += 1;
    if (item.severity === 'CRITICAL') entry.critical += 1;
    load.set(item.assigneeId, entry);
  }
  return [...load.values()]
    .map((entry) => ({ ...entry, overloaded: entry.active >= REFERENT_OVERLOAD_ACTIVE }))
    .sort((a, b) => b.active - a.active || b.critical - a.critical);
}

/** Membre le moins chargé et pas surchargé, hors personnes écartées (la personne concernée). */
export function suggestAssignee(load: readonly ReferentLoad[], excludeIds: readonly string[]): string | null {
  const candidates = load
    .filter((entry) => !entry.overloaded && !excludeIds.includes(entry.userId))
    .sort((a, b) => a.active - b.active || a.critical - b.critical);
  return candidates[0]?.userId ?? null;
}

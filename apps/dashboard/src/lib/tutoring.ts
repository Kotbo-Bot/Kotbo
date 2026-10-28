/** Tutorat : petits calculs et libellés partagés par l'accueil, la fiche et le parcours. */
import { m, dateLocale } from './i18n';
import { localInitialAvatar } from './discordMedia';
import type { TutoringMember, TutoringObjectiveState, TutoringReportType, TutoringStatus, TutoringSummary } from './api/tutoring';

export function memberName(member: Pick<TutoringMember, 'displayName' | 'username' | 'userId'> | null | undefined): string {
  return member?.displayName || member?.username || member?.userId || '';
}

export function memberAvatar(member: TutoringMember): string {
  return member.avatarUrl || localInitialAvatar(memberName(member), member.userId);
}

export function formatDay(value: string | Date): string {
  return new Date(value).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}

/** Part des objectifs acquis, de 0 à 100. */
export function progressPercent(summary: Pick<TutoringSummary, 'progress'>): number {
  return summary.progress.total ? Math.round((summary.progress.acquired / summary.progress.total) * 100) : 0;
}

/** Jours avant le prochain point d'étape (négatif : en retard). */
export function daysUntil(value: string): number {
  return Math.ceil((new Date(value).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

export const STATUS_META: Record<TutoringStatus, { label: () => string; badge: string }> = {
  ONGOING: { label: () => m.tu_status_ongoing(), badge: 'badge-info' },
  PASSED: { label: () => m.tu_status_passed(), badge: 'badge-success' },
  FAILED: { label: () => m.tu_status_failed(), badge: 'badge-danger' },
};

export const OBJECTIVE_STATES: Array<{ value: TutoringObjectiveState; label: () => string }> = [
  { value: 'UNCHECKED', label: () => m.tu_obj_todo() },
  { value: 'KNOWN', label: () => m.tu_obj_seen() },
  { value: 'ACQUIRED', label: () => m.tu_obj_acquired() },
];

export const REPORT_META: Record<TutoringReportType, { label: () => string; badge: string; icon: string }> = {
  POSITIVE: { label: () => m.tu_report_positive(), badge: 'badge-success', icon: 'thumbs-up' },
  NEUTRAL: { label: () => m.tu_report_neutral(), badge: 'badge-neutral', icon: 'minus' },
  NEGATIVE: { label: () => m.tu_report_negative(), badge: 'badge-danger', icon: 'thumbs-down' },
};

/** Où en est le prochain point d'étape, en une phrase. */
export function nextReportText(summary: Pick<TutoringSummary, 'nextReportAt' | 'reportOverdue' | 'mentor' | 'status'>): string {
  if (summary.status !== 'ONGOING') return '';
  if (!summary.mentor) return m.tu_no_mentor();
  if (!summary.nextReportAt) return '';
  const days = daysUntil(summary.nextReportAt);
  if (summary.reportOverdue) return m.tu_report_overdue({ days: Math.abs(days) });
  return days <= 0 ? m.tu_report_today() : m.tu_report_in({ days });
}

/**
 * Codes des dossiers de la cellule bien-être (ceux du bot) et leurs libellés
 * traduits : la page et l'onglet de la fiche membre affichent les mêmes.
 */
import { m } from './i18n';

export const WB_STATUSES = ['OPEN', 'MONITORING', 'CLOSED'] as const;
export const WB_SEVERITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export const WB_CATEGORIES = ['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI'] as const;
export const WB_ALERT_EVENTS = ['BREAK_GLASS', 'EMERGENCY_READ', 'TEAM_READ', 'CASE_CHANGE', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS', 'DISSOLUTION'] as const;
export const WB_CASE_EVENTS = ['CREATED', 'STATUS', 'SEVERITY', 'ASSIGNEE', 'REVIEW', 'NOTE', 'RESOURCES_SENT', 'REMINDER', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED', 'VIEWED', 'TRASHED', 'RESTORED', 'EXTENDED', 'EXPORTED', 'TASK_ADDED', 'TASK_DONE', 'TASK_REOPENED', 'TASK_REMOVED', 'PURGE_REQUESTED', 'CLOSED_REASON', 'NOTE_EDITED', 'REPORTER_REPLY'] as const;
export const WB_CLOSE_REASONS = ['RESOLVED', 'REFERRED', 'NO_FOLLOWUP', 'DUPLICATE'] as const;

const STATUS_LABELS: Record<string, () => string> = {
  OPEN: () => m.wb_status_open(),
  MONITORING: () => m.wb_status_monitoring(),
  CLOSED: () => m.wb_status_closed(),
};
const SEVERITY_LABELS: Record<string, () => string> = {
  LOW: () => m.wb_sev_low(),
  NORMAL: () => m.wb_sev_normal(),
  HIGH: () => m.wb_sev_high(),
  CRITICAL: () => m.wb_sev_critical(),
};
const CATEGORY_LABELS: Record<string, () => string> = {
  SOUTIEN: () => m.wb_cat_soutien(),
  MEDIATION: () => m.wb_cat_mediation(),
  SIGNALEMENT: () => m.wb_cat_signalement(),
  SUIVI: () => m.wb_cat_suivi(),
};

const ALERT_EVENT_LABELS: Record<string, () => string> = {
  BREAK_GLASS: () => m.wb_alert_break_glass(),
  EMERGENCY_READ: () => m.wb_alert_emergency_read(),
  TEAM_READ: () => m.wb_alert_team_read(),
  CASE_CHANGE: () => m.wb_alert_case_change(),
  CONFIG_CHANGE: () => m.wb_alert_config_change(),
  REPORT: () => m.wb_alert_report(),
  REMINDER: () => m.wb_alert_reminder(),
  MEMBERSHIP_CHANGE: () => m.wb_alert_membership_change(),
  PURGE_SOON: () => m.wb_alert_purge_soon(),
  UNUSUAL_ACCESS: () => m.wb_alert_unusual_access(),
  DISSOLUTION: () => m.wb_alert_dissolution(),
};

const CLOSE_REASON_LABELS: Record<string, () => string> = {
  RESOLVED: () => m.wb_close_resolved(),
  REFERRED: () => m.wb_close_referred(),
  NO_FOLLOWUP: () => m.wb_close_no_followup(),
  DUPLICATE: () => m.wb_close_duplicate(),
  UNSPECIFIED: () => m.wb_close_unspecified(),
};

const SUMMARY_TEMPLATES: Record<string, () => string> = {
  SOUTIEN: () => m.wb_tpl_soutien(),
  MEDIATION: () => m.wb_tpl_mediation(),
  SIGNALEMENT: () => m.wb_tpl_signalement(),
  SUIVI: () => m.wb_tpl_suivi(),
};

export const wbStatusLabel = (code: string): string => STATUS_LABELS[code]?.() ?? code;
export const wbSeverityLabel = (code: string): string => SEVERITY_LABELS[code]?.() ?? code;
export const wbCategoryLabel = (code: string): string => CATEGORY_LABELS[code]?.() ?? code;
export const wbAlertEventLabel = (code: string): string => ALERT_EVENT_LABELS[code]?.() ?? code;
/** Motif de clôture ; `UNSPECIFIED` pour un dossier fermé sans motif. */
export const wbCloseReasonLabel = (code: string): string => CLOSE_REASON_LABELS[code]?.() ?? code;

/** Trame de résumé proposée à la création d'un dossier, selon sa catégorie. */
export const wbSummaryTemplate = (category: string): string => SUMMARY_TEMPLATES[category]?.() ?? '';

/** Résumé encore vide ou resté tel que la trame : changer de catégorie peut le remplacer. */
export function wbIsSummaryTemplate(summary: string): boolean {
  const text = summary.trim();
  return text === '' || WB_CATEGORIES.some((category) => wbSummaryTemplate(category).trim() === text);
}

export interface WbCaseEvent {
  type: string;
  fromValue: string | null;
  toValue: string | null;
}

/** Phrase d'une entrée d'historique. `formatDate` met en forme une date ISO. */
export function wbCaseEventLabel(event: WbCaseEvent, formatDate: (iso: string) => string): string {
  const { fromValue: from, toValue: to } = event;
  switch (event.type) {
    case 'CREATED':
      return to === 'DISCORD' ? m.wb_ev_created_discord() : m.wb_ev_created();
    case 'STATUS':
      return m.wb_ev_status({ from: wbStatusLabel(from ?? ''), to: wbStatusLabel(to ?? '') });
    case 'SEVERITY':
      return m.wb_ev_severity({ from: wbSeverityLabel(from ?? ''), to: wbSeverityLabel(to ?? '') });
    case 'ASSIGNEE':
      return to ? m.wb_ev_assignee() : m.wb_ev_assignee_cleared();
    case 'REVIEW':
      return to ? m.wb_ev_review({ date: formatDate(to) }) : m.wb_ev_review_cleared();
    case 'NOTE':
      return m.wb_ev_note();
    case 'RESOURCES_SENT':
      return m.wb_ev_resources_sent({ count: to ?? '0' });
    case 'REMINDER':
      return m.wb_ev_reminder();
    case 'ATTACHMENT_ADDED':
      return m.wb_ev_attachment_added();
    case 'ATTACHMENT_REMOVED':
      return m.wb_ev_attachment_removed();
    case 'VIEWED':
      return to === 'EMERGENCY' ? m.wb_ev_viewed_emergency() : m.wb_ev_viewed();
    case 'TRASHED':
      return m.wb_ev_trashed();
    case 'RESTORED':
      return m.wb_ev_restored();
    case 'EXTENDED':
      return m.wb_ev_extended();
    case 'EXPORTED':
      return m.wb_ev_exported();
    case 'TASK_ADDED':
      return m.wb_ev_task_added();
    case 'TASK_DONE':
      return m.wb_ev_task_done();
    case 'TASK_REOPENED':
      return m.wb_ev_task_reopened();
    case 'TASK_REMOVED':
      return m.wb_ev_task_removed();
    case 'PURGE_REQUESTED':
      return m.wb_ev_purge_requested();
    case 'CLOSED_REASON':
      return m.wb_ev_closed_reason({ reason: wbCloseReasonLabel(to ?? '') });
    case 'NOTE_EDITED':
      return m.wb_ev_note_edited();
    case 'REPORTER_REPLY':
      return to === 'CLEARED' ? m.wb_ev_reporter_reply_cleared() : m.wb_ev_reporter_reply();
    default:
      return event.type;
  }
}

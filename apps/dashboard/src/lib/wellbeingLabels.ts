/**
 * Codes des dossiers de la cellule bien-être (ceux du bot) et leurs libellés
 * traduits : la page et l'onglet de la fiche membre affichent les mêmes.
 */
import { m } from './i18n';

export const WB_STATUSES = ['OPEN', 'MONITORING', 'CLOSED'] as const;
export const WB_SEVERITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export const WB_CATEGORIES = ['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI'] as const;
export const WB_ALERT_EVENTS = ['BREAK_GLASS', 'EMERGENCY_READ', 'TEAM_READ', 'CASE_CHANGE', 'CONFIG_CHANGE', 'REPORT', 'REMINDER'] as const;
export const WB_CASE_EVENTS = ['CREATED', 'STATUS', 'SEVERITY', 'ASSIGNEE', 'REVIEW', 'NOTE', 'RESOURCES_SENT', 'REMINDER'] as const;

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
};

export const wbStatusLabel = (code: string): string => STATUS_LABELS[code]?.() ?? code;
export const wbSeverityLabel = (code: string): string => SEVERITY_LABELS[code]?.() ?? code;
export const wbCategoryLabel = (code: string): string => CATEGORY_LABELS[code]?.() ?? code;
export const wbAlertEventLabel = (code: string): string => ALERT_EVENT_LABELS[code]?.() ?? code;

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
    default:
      return event.type;
  }
}

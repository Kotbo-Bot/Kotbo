/**
 * Codes des dossiers de la cellule bien-être (ceux du bot) et leurs libellés
 * traduits : la page et l'onglet de la fiche membre affichent les mêmes.
 */
import { m } from './i18n';

export const WB_STATUSES = ['OPEN', 'MONITORING', 'CLOSED'] as const;
export const WB_SEVERITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export const WB_CATEGORIES = ['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI'] as const;

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

export const wbStatusLabel = (code: string): string => STATUS_LABELS[code]?.() ?? code;
export const wbSeverityLabel = (code: string): string => SEVERITY_LABELS[code]?.() ?? code;
export const wbCategoryLabel = (code: string): string => CATEGORY_LABELS[code]?.() ?? code;

/** Libellé et teinte d'un statut de suggestion, partagés par la page et la fenêtre de décision. */
import type { SuggestionStatus } from '@kotbo/shared';
import { m } from '../../i18n';

export function suggestionStatusLabel(status: SuggestionStatus): string {
  switch (status) {
    case 'PENDING':
      return m.suggestions_status_pending();
    case 'APPROVED':
      return m.suggestions_status_approved();
    case 'IN_PROGRESS':
      return m.suggestions_status_in_progress();
    case 'REJECTED':
      return m.suggestions_status_rejected();
    case 'IMPLEMENTED':
      return m.suggestions_status_implemented();
  }
}

/** Pastille du statut, avec les teintes du thème plutôt que des couleurs en dur. */
export const SUGGESTION_STATUS_TONE: Record<SuggestionStatus, string> = {
  PENDING: 'bg-warning/10 text-warning border-warning/20',
  APPROVED: 'bg-success/10 text-success border-success/20',
  IN_PROGRESS: 'bg-secondary/10 text-secondary border-secondary/20',
  REJECTED: 'bg-error/10 text-error border-error/20',
  IMPLEMENTED: 'bg-primary/10 text-primary border-primary/20',
};

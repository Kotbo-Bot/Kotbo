import { m } from '../../i18n';

export type EventType = 'QUIZ' | 'CTF' | 'CUSTOM' | 'TOURNAMENT';
export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';

/** Ce que les pages Événements affichent pour chaque type : un seul endroit plutôt qu'une cascade de ternaires. */
export const EVENT_TYPES: { type: EventType; icon: string; tone: string; label: () => string; tag: () => string; description: () => string }[] = [
  { type: 'TOURNAMENT', icon: 'Trophy', tone: 'bg-warning/10 text-warning', label: () => m.ev_type_tournament(), tag: () => m.ev_tournament_tag(), description: () => m.ev_tournament_desc() },
  { type: 'CUSTOM', icon: 'Calendar', tone: 'bg-tertiary/10 text-tertiary', label: () => m.ev_type_custom(), tag: () => m.ev_custom_tag(), description: () => m.ev_custom_desc() },
  { type: 'QUIZ', icon: 'HelpCircle', tone: 'bg-primary/10 text-primary', label: () => m.ev_type_quiz(), tag: () => m.ev_quiz_tag(), description: () => m.ev_quiz_desc() },
  { type: 'CTF', icon: 'Flag', tone: 'bg-success/10 text-success', label: () => m.ev_type_ctf(), tag: () => m.ev_ctf_tag(), description: () => m.ev_ctf_desc() },
];

export const eventTypeMeta = (type: string) => EVENT_TYPES.find((t) => t.type === type) ?? EVENT_TYPES[1];

/** Inscription par bouton et formulaire, annonce Discord : les deux types qui partagent ce parcours. */
export const hasRegistrations = (type: string) => type === 'CUSTOM' || type === 'TOURNAMENT';

export function statusLabel(status: string) {
  switch (status) {
    case 'DRAFT': return m.ev_status_draft();
    case 'PUBLISHED': return m.ev_status_published();
    case 'ONGOING': return m.ev_status_ongoing();
    case 'COMPLETED': return m.ev_status_completed();
    case 'CANCELLED': return m.ev_status_cancelled();
    default: return status;
  }
}

export function statusTone(status: string) {
  switch (status) {
    case 'PUBLISHED': return 'bg-primary/10 text-primary';
    case 'ONGOING': return 'bg-success/10 text-success';
    case 'CANCELLED': return 'bg-error/10 text-error';
    default: return 'bg-surface-container-high text-on-surface-variant';
  }
}

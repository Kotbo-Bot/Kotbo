/**
 * Catalogue des notifications : chaque envoi porte un `kind` précis, d'où se
 * déduit sa famille (pour la grille de préférences et les filtres de la boîte)
 * et ce qu'on a le droit d'en faire.
 *
 * - `mandatory` : ne peut pas être coupé. La personne est directement concernée
 *   (sanction reçue, décision sur sa candidature…) et doit l'apprendre.
 * - `urgent` : part tout de suite en message privé, sans regroupement ni résumé.
 */
export const NOTIFICATION_CATEGORIES = [
  'staff',
  'planning',
  'recruitment',
  'moderation',
  'security',
  'tickets',
  'partnerships',
  'community',
  'system',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationSeverity = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type NotificationKindMeta = {
  category: NotificationCategory;
  mandatory?: boolean;
  urgent?: boolean;
};

export const NOTIFICATION_KINDS = {
  // Staff
  'staff.grade_changed': { category: 'staff', mandatory: true },
  'staff.suspension_changed': { category: 'staff', mandatory: true, urgent: true },
  'staff.warning_received': { category: 'staff', mandatory: true },
  'staff.warning_issued': { category: 'staff' },
  'staff.blacklisted': { category: 'staff', mandatory: true },
  'staff.testing_started': { category: 'staff', mandatory: true },
  'staff.testing_ended': { category: 'staff', mandatory: true },
  'staff.mentor_assigned': { category: 'staff' },
  'staff.mentor_report': { category: 'staff' },
  'staff.manager_note': { category: 'staff' },
  'staff.procedure_published': { category: 'staff' },
  'staff.poll_created': { category: 'staff' },
  'staff.resignation_requested': { category: 'staff' },
  'staff.resignation_decided': { category: 'staff', mandatory: true },
  'staff.news_published': { category: 'staff' },

  // Planning
  'planning.absence_pending': { category: 'planning' },
  'planning.absence_requested': { category: 'planning' },
  'planning.absence_decided': { category: 'planning', mandatory: true },
  'planning.meeting_scheduled': { category: 'planning' },
  'planning.meeting_started': { category: 'planning', urgent: true },
  'planning.meeting_ended': { category: 'planning' },
  'planning.call_scheduled': { category: 'planning' },
  'planning.task_assigned': { category: 'planning' },

  // Recrutement
  'recruitment.application_received': { category: 'recruitment' },
  'recruitment.application_accepted': { category: 'recruitment', mandatory: true },
  'recruitment.application_rejected': { category: 'recruitment', mandatory: true },
  'recruitment.promoted': { category: 'recruitment', mandatory: true },
  'recruitment.tutor_assigned': { category: 'recruitment' },

  // Modération
  'moderation.sanction_applied': { category: 'moderation' },
  'moderation.sanction_report_required': { category: 'moderation' },
  'moderation.sanction_report_overdue': { category: 'moderation' },
  'moderation.sanction_report_missing': { category: 'moderation' },
  'moderation.warning_received': { category: 'moderation', mandatory: true },
  'moderation.ban_hygiene': { category: 'moderation' },

  // Sécurité
  'security.alt_linked': { category: 'security', mandatory: true },
  'security.alt_unlinked': { category: 'security', mandatory: true },
  'security.alt_detected': { category: 'security', urgent: true },
  'security.verification_undelivered': { category: 'security' },

  // Partenariats
  'partnerships.alert': { category: 'partnerships' },

  // Communauté
  'community.daily_algo_feedback': { category: 'community', mandatory: true },

  // Système (repli pour ce qui n'a pas encore de type)
  'system.generic': { category: 'system' },
} as const satisfies Record<string, NotificationKindMeta>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export function getNotificationKind(kind: string): NotificationKindMeta {
  return (NOTIFICATION_KINDS as Record<string, NotificationKindMeta>)[kind] ?? NOTIFICATION_KINDS['system.generic'];
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

/** Où une famille arrive pour une personne. Sans réglage : dashboard et MP, comme avant la refonte. */
export type NotificationChannelPrefs = { dashboard: boolean; dm: boolean; digest: boolean };

export const DEFAULT_NOTIFICATION_CHANNEL_PREFS: NotificationChannelPrefs = { dashboard: true, dm: true, digest: false };

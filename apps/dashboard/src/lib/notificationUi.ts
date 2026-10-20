import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@kotbo/contracts';
import { m } from './i18n';

/** Familles de notifications (catalogue partagé avec le bot), dans l'ordre d'affichage. */
export const CATEGORY_META: Record<NotificationCategory, { label: () => string; icon: string }> = {
  staff: { label: () => m.ntf_cat_staff(), icon: 'user-check' },
  planning: { label: () => m.ntf_cat_planning(), icon: 'calendar' },
  recruitment: { label: () => m.ntf_cat_recruitment(), icon: 'users' },
  moderation: { label: () => m.ntf_cat_moderation(), icon: 'shield' },
  security: { label: () => m.ntf_cat_security(), icon: 'lock' },
  tickets: { label: () => m.ntf_cat_tickets(), icon: 'ticket' },
  partnerships: { label: () => m.ntf_cat_partnerships(), icon: 'handshake' },
  community: { label: () => m.ntf_cat_community(), icon: 'sparkles' },
  system: { label: () => m.ntf_cat_system(), icon: 'cpu' },
};

export const CATEGORIES = NOTIFICATION_CATEGORIES;

export function categoryMeta(category: string) {
  return CATEGORY_META[category as NotificationCategory] ?? CATEGORY_META.system;
}

const SEVERITY_META: Record<string, { icon: string; text: string; bg: string }> = {
  SUCCESS: { icon: 'check-circle', text: 'text-success', bg: 'bg-success/10' },
  WARNING: { icon: 'alert-triangle', text: 'text-warning', bg: 'bg-warning/10' },
  ERROR: { icon: 'alert-circle', text: 'text-error', bg: 'bg-error/10' },
  CRITICAL: { icon: 'alert-octagon', text: 'text-error', bg: 'bg-error/15' },
  INFO: { icon: 'info', text: 'text-primary', bg: 'bg-primary/10' },
};

export function severityMeta(type: string) {
  return SEVERITY_META[type] ?? SEVERITY_META.INFO;
}

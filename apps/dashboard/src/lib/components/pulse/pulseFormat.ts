/**
 * Présentation du Pulse : types de la réponse, libellés des facteurs et des
 * alertes, et page où agir pour chacun. Le calcul vit côté bot
 * (`services/analytics/pulseScoring.ts`) ; ici on ne fait que le lire.
 */
import { m } from '../../i18n';
import { fmtNumber, fmtPct } from '../analytics/analyticsFormat';

export type PulseDimension = 'activity' | 'engagement' | 'growth' | 'moderation' | 'health';

export interface PulseFactor {
  key: string;
  dimension: PulseDimension;
  score: number;
  weight: number;
  impact: number;
  value: number;
  reference: number | null;
  referenceKind: 'server' | 'typical';
}

export interface PulseAlert {
  type: string;
  code?: string;
  severity: string;
  message: string;
  params?: Record<string, number | string>;
}

export interface PulseMetrics {
  totalMessages: number;
  totalVoiceMinutes: number;
  activeMembers: number;
  totalMembers: number;
  membersJoined: number;
  membersLeft: number;
  sanctionsCount: number;
  ticketsResolved: number;
  ticketsOpen: number;
  channelsHealthy: number;
  channelsUnhealthy: number;
}

export interface PulseScores {
  score: number;
  activityScore: number;
  moderationScore: number;
  growthScore: number;
  engagementScore: number;
  healthScore: number;
}

export interface PulseSnapshot extends PulseScores {
  dateKey: string;
  trend: string;
  trendDelta: number;
  alerts: PulseAlert[];
  partial: boolean;
  confidence?: number | null;
  factors?: PulseFactor[];
}

export type PulseHistoryPoint = PulseScores & PulseMetrics & { dateKey: string; alerts?: PulseAlert[] };

export interface PulsePayload {
  hasData: boolean;
  current: PulseSnapshot;
  today: (PulseSnapshot & { metrics: PulseMetrics }) | null;
  history: PulseHistoryPoint[];
  metrics: PulseMetrics;
  bumpStatus: {
    providerLabel: string;
    nextBumpAt: string;
    overdue: boolean;
  } | null;
  benchmark?: { percentile: number; peers: number; minMembers: number; maxMembers: number } | null;
}

export const DIMENSIONS: Array<{ id: PulseDimension; field: keyof PulseScores; icon: string; label: () => string; desc: () => string; weight: number }> = [
  { id: 'activity', field: 'activityScore', icon: 'message-circle', label: () => m.pulse_sub_activity(), desc: () => m.pulse_dim_desc_activity(), weight: 0.25 },
  { id: 'engagement', field: 'engagementScore', icon: 'users', label: () => m.pulse_sub_engagement(), desc: () => m.pulse_dim_desc_engagement(), weight: 0.25 },
  { id: 'growth', field: 'growthScore', icon: 'trending-up', label: () => m.pulse_sub_growth(), desc: () => m.pulse_dim_desc_growth(), weight: 0.2 },
  { id: 'moderation', field: 'moderationScore', icon: 'shield', label: () => m.pulse_sub_moderation(), desc: () => m.pulse_dim_desc_moderation(), weight: 0.15 },
  { id: 'health', field: 'healthScore', icon: 'activity', label: () => m.pulse_sub_health(), desc: () => m.pulse_dim_desc_health(), weight: 0.15 },
];

/** Couleur d'une note, par les jetons de statut du thème. */
export function scoreTone(score: number): string {
  if (score >= 80) return 'var(--color-success)';
  if (score >= 60) return 'var(--color-primary)';
  if (score >= 40) return 'var(--color-warning)';
  return 'var(--color-error)';
}

export function scoreLabel(score: number): string {
  if (score >= 80) return m.pulse_score_excellent();
  if (score >= 60) return m.pulse_score_good();
  if (score >= 40) return m.pulse_score_average();
  if (score >= 20) return m.pulse_score_weak();
  return m.pulse_score_critical();
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 70) return m.pulse_confidence_high();
  if (confidence >= 40) return m.pulse_confidence_medium();
  return m.pulse_confidence_low_label();
}

const round1 = (v: number) => fmtNumber(Math.round(v * 10) / 10);

interface FactorMeta {
  label: () => string;
  /** Mise en forme de la valeur et du repère, à la même échelle. */
  format: (v: number) => string;
  /** Page où agir sur ce facteur. */
  href: string;
}

const pct = (v: number) => fmtPct(v * 100);

const FACTORS: Record<string, FactorMeta> = {
  messages: { label: () => m.pulse_f_messages(), format: (v) => m.pulse_u_msg({ n: round1(v) }), href: '/analytics/messages' },
  voice: { label: () => m.pulse_f_voice(), format: (v) => m.pulse_u_min({ n: round1(v) }), href: '/analytics/voice' },
  participation: { label: () => m.pulse_f_participation(), format: pct, href: '/analytics/members' },
  voiceParticipation: { label: () => m.pulse_f_voice_participation(), format: pct, href: '/analytics/voice' },
  depth: { label: () => m.pulse_f_depth(), format: (v) => m.pulse_u_msg({ n: round1(v) }), href: '/analytics/engagement' },
  stickiness: { label: () => m.pulse_f_stickiness(), format: pct, href: '/analytics/engagement' },
  responses: { label: () => m.pulse_f_responses(), format: pct, href: '/analytics/responses' },
  netGrowth: { label: () => m.pulse_f_net_growth(), format: (v) => m.pulse_u_per_day({ n: `${v > 0 ? '+' : ''}${fmtPct(v * 100, 2)}` }), href: '/analytics/growth' },
  churn: { label: () => m.pulse_f_churn(), format: (v) => m.pulse_u_per_day({ n: fmtPct(v * 100, 2) }), href: '/analytics/churn' },
  sanctions: { label: () => m.pulse_f_sanctions(), format: (v) => m.pulse_u_per100({ n: round1(v * 100) }), href: '/security/sanctions' },
  toxicity: { label: () => m.pulse_f_toxicity(), format: pct, href: '/security/aegis' },
  channels: { label: () => m.pulse_f_channels(), format: pct, href: '/channel-health' },
  ticketResolution: { label: () => m.pulse_f_ticket_resolution(), format: pct, href: '/tickets' },
  ticketBacklog: { label: () => m.pulse_f_ticket_backlog(), format: (v) => fmtNumber(Math.round(v)), href: '/tickets' },
};

export const factorLabel = (f: PulseFactor) => FACTORS[f.key]?.label() ?? f.key;
export const factorHref = (f: PulseFactor) => FACTORS[f.key]?.href ?? '/analytics';

/** « 1,2 msg, d'habitude 0,9 msg » : la mesure et ce qui vaut « normal ». */
export function factorDetail(f: PulseFactor): string {
  const format = FACTORS[f.key]?.format ?? ((v: number) => round1(v));
  const value = format(f.value);
  if (f.reference === null) return value;
  const reference = format(f.reference);
  return f.referenceKind === 'server' ? m.pulse_factor_vs_server({ value, reference }) : m.pulse_factor_vs_typical({ value, reference });
}

/** Page où agir sur une alerte, par son code. */
const ALERT_HREF: Record<string, string> = {
  activity_critical: '/analytics/overview',
  activity_low: '/analytics/overview',
  moderation_critical: '/security/sanctions',
  toxicity_high: '/security/aegis',
  growth_critical: '/analytics/growth',
  growth_stagnant: '/analytics/growth',
  growth_churn: '/analytics/churn',
  engagement_low: '/analytics/engagement',
  responses_low: '/analytics/responses',
  tickets_backlog: '/tickets',
  channels_unhealthy: '/channel-health',
};

export const alertHref = (alert: PulseAlert): string | null => (alert.code ? ALERT_HREF[alert.code] ?? null : null);

/**
 * Les alertes arrivent avec un `code` stable et ses paramètres. `message` n'est
 * qu'un rendu français figé, gardé pour les snapshots antérieurs aux codes.
 */
export function alertText(alert: PulseAlert): string {
  const n = (key: string) => Number(alert.params?.[key] ?? 0);
  switch (alert.code) {
    case 'insufficient_data': return m.pulse_alert_insufficient_data();
    case 'activity_critical': return m.pulse_alert_activity_critical();
    case 'activity_low': return m.pulse_alert_activity_low();
    case 'moderation_critical': return m.pulse_alert_moderation_critical({ count: n('count') });
    case 'toxicity_high': return m.pulse_alert_toxicity_high({ pct: n('pct') });
    case 'growth_critical': return m.pulse_alert_growth_critical({ left: n('left') });
    case 'growth_stagnant': return m.pulse_alert_growth_stagnant();
    case 'growth_churn': return m.pulse_alert_growth_churn({ left: n('left'), joined: n('joined') });
    case 'engagement_low': return m.pulse_alert_engagement_low();
    case 'responses_low': return m.pulse_alert_responses_low({ pct: n('pct') });
    case 'tickets_backlog': return m.pulse_alert_tickets_backlog({ count: n('count') });
    case 'channels_unhealthy': return m.pulse_alert_channels_unhealthy({ count: n('count') });
    case 'excellent': return m.pulse_alert_excellent();
    default: return alert.message;
  }
}

export function alertVariant(severity: string): 'info' | 'success' | 'warning' | 'danger' {
  if (severity === 'danger' || severity === 'warning' || severity === 'success') return severity;
  return 'info';
}

const DAY_KEYS = [
  () => m.pulse_day_0(), () => m.pulse_day_1(), () => m.pulse_day_2(), () => m.pulse_day_3(),
  () => m.pulse_day_4(), () => m.pulse_day_5(), () => m.pulse_day_6(),
];
export const dayLabel = (index: number) => DAY_KEYS[index]?.() ?? '';

/** Le bot renvoie le nom du jour en français (ou en anglais en démo) : on le retraduit via son index. */
const FR_DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function dayName(value: string): string {
  const frIndex = FR_DAYS.indexOf(value);
  const index = frIndex >= 0 ? frIndex : EN_DAYS.indexOf(value?.toLowerCase?.() ?? '');
  return index >= 0 ? dayLabel(index) : value;
}

/** Kotbo × AegisAI : détection de propos toxiques et émotions des messages. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import type { AnalyticsQuery } from './analytics';

export const AEGIS_EMOTIONS = ['joy', 'sad', 'anger', 'fear', 'surprise', 'neutral'] as const;
export type AegisEmotion = (typeof AEGIS_EMOTIONS)[number];
export type AegisAutoAction = 'DELETE' | 'DELETE_AND_WARN' | 'DELETE_AND_TIMEOUT';
export type AegisDetectionKind = 'TOXIC' | 'HARASSMENT' | 'CONFLICT' | 'DISTRESS';
export type AegisDetectionStatus = 'PENDING' | 'AUTO' | 'CONFIRMED' | 'DISMISSED';

export interface AegisConfig {
  guildId: string;
  enabled: boolean;
  /** null : la question du partage pour l'entraînement n'a jamais été posée. */
  trainingConsent: boolean | null;
  trainingConsentById: string | null;
  trainingConsentAt: string | null;
  reviewThreshold: number;
  autoThreshold: number;
  autoAction: AegisAutoAction;
  warnWeight: number;
  timeoutMinutes: number;
  notifyMember: boolean;
  reviewChannelId: string | null;
  exemptChannelIds: string[];
  exemptRoleIds: string[];
  analyzeEdits: boolean;
  analyzeNicknames: boolean;
  analyzeTickets: boolean;
  ticketPriorityBoost: boolean;
  conflictEnabled: boolean;
  conflictWindowSec: number;
  conflictMessageThreshold: number;
  conflictSlowmodeSec: number;
  conflictDurationMin: number;
  harassmentEnabled: boolean;
  harassmentWindowMin: number;
  harassmentThreshold: number;
  harassmentAction: 'ALERT' | 'TIMEOUT';
  distressEnabled: boolean;
  distressThreshold: number;
  distressChannelId: string | null;
  distressCooldownHours: number;
}

/** Champs modifiables depuis le dashboard. */
export type AegisConfigPatch = Partial<Omit<AegisConfig, 'guildId' | 'trainingConsentById' | 'trainingConsentAt'>>;

export interface AegisStatus {
  api: {
    configured: boolean;
    circuit: 'closed' | 'open';
    openUntil: number | null;
    consecutiveFailures: number;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    requests: number;
    failures: number;
  };
  queue: {
    backend: 'redis' | 'memory' | 'stopped';
    depth: number;
    active: number;
    concurrency: number;
    processed: number;
    failed: number;
    dropped: number;
  };
}

export interface AegisState {
  config: AegisConfig;
  saved: boolean;
  pendingCount: number;
  status: AegisStatus;
  canEdit: boolean;
  canReview: boolean;
}

export interface AegisTestResult {
  text: string;
  toxicity: number;
  emotion: { label: AegisEmotion; score: number };
  decision: 'auto' | 'review' | 'none';
  /** Envoyée avec `save: true` : le serveur partage pour l'entraînement. */
  saved: boolean;
}

export interface AegisDetection {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  authorId: string;
  targetUserId: string | null;
  kind: AegisDetectionKind;
  source: 'MESSAGE' | 'EDIT' | 'NICKNAME' | 'TICKET';
  toxicity: number | null;
  emotion: AegisEmotion | null;
  emotionScore: number | null;
  /** Réservé au staff de modération : null pour les autres lecteurs. */
  excerpt: string | null;
  action: string;
  status: AegisDetectionStatus;
  late: boolean;
  sanctionId: string | null;
  /** Transcription du salon prise avant tout retrait. */
  evidenceUrl: string | null;
  previousSlowmode: number | null;
  restoreAt: string | null;
  restoredAt: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  createdAt: string;
  authorName: string | null;
  authorAvatar: string | null;
  targetName: string | null;
  channelName: string | null;
}

const base = '/aegis';

export function fetchAegis(guildId = authStore.selectedGuildId) {
  return dashboardRequest<AegisState>(base, { guildId, errorContext: 'API Error (AegisAI):' });
}

export function updateAegis(patch: AegisConfigPatch, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ config: AegisConfig; saved: true }>(base, {
    method: 'PATCH',
    payload: patch,
    guildId,
    errorContext: 'API Error (Update AegisAI):',
  });
}

export function testAegisText(text: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<AegisTestResult>(`${base}/test`, {
    method: 'POST',
    payload: { text },
    guildId,
    errorContext: 'API Error (Test AegisAI):',
  });
}

export function fetchAegisDetections(
  filters: { status?: AegisDetectionStatus | null; kind?: AegisDetectionKind | null; before?: string | null } = {},
  guildId = authStore.selectedGuildId,
) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.before) params.set('before', filters.before);
  const query = params.toString();
  return dashboardRequest<{ detections: AegisDetection[]; hasMore: boolean }>(`${base}/detections${query ? `?${query}` : ''}`, {
    guildId,
    errorContext: 'API Error (AegisAI detections):',
  });
}

export function decideAegisDetection(id: string, decision: 'confirm' | 'dismiss' | 'unslow', guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ detection: AegisDetection }>(`${base}/detections/${encodeURIComponent(id)}/${decision}`, {
    method: 'POST',
    guildId,
    errorContext: 'API Error (AegisAI decision):',
  });
}

// ── Analytics : climat ──────────────────────────────────────────────────────

export interface ClimateSummary {
  analyzed: number;
  toxic: number;
  severe: number;
  toxicRate: number | null;
  avgToxicity: number | null;
  emotionAnalyzed: number;
  emotions: Record<AegisEmotion, number>;
  dominant: AegisEmotion | null;
}

export type ClimateDay = { dateKey: string; analyzed: number; toxic: number; severe: number; toxicRate: number | null; avgToxicity: number | null } & Record<AegisEmotion, number>;

export interface ClimateAnalytics {
  enabled: boolean;
  thresholds: { review: number; auto: number } | null;
  current: ClimateSummary;
  previous: ClimateSummary;
  daily: ClimateDay[];
  previousDaily: ClimateDay[];
  /** [jour ISO lundi=0][heure UTC] */
  heatmap: Array<Array<{ analyzed: number; toxic: number; anger: number }>>;
  channels: Array<ClimateSummary & { channelId: string; name: string | null; spark: number[] }>;
  members: Array<{ userId: string; name: string | null; avatar: string | null; analyzed: number; toxic: number; toxicRate: number | null; avgToxicity: number | null }>;
  detections: { byKind: Record<string, number>; byStatus: Record<string, number>; total: number; falsePositiveRate: number | null };
}

export function fetchClimateAnalytics(query: AnalyticsQuery, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (query.startDate && query.endDate) {
    params.set('startDate', query.startDate);
    params.set('endDate', query.endDate);
  } else if (query.period) {
    params.set('period', String(query.period));
  }
  return dashboardRequest<ClimateAnalytics>(`/analytics/climate?${params.toString()}`, {
    guildId,
    errorContext: 'API Error (Climate Analytics):',
  });
}

export interface MemberClimate {
  days: Array<{ dateKey: string; analyzed: number; toxic: number; avgToxicity: number | null }>;
  summary: ClimateSummary;
  detections: Array<Pick<AegisDetection, 'id' | 'kind' | 'source' | 'status' | 'action' | 'toxicity' | 'emotion' | 'channelId' | 'createdAt' | 'excerpt'>>;
}

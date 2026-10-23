/** Fiche membre complète : synthèse, statistiques et chronologie. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import type { MemberClimate } from './aegis';

export type TimelineCategory = 'membership' | 'moderation' | 'support' | 'community' | 'changes';
export type TimelineTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface TimelineItem {
  id: string;
  type: string;
  category: TimelineCategory;
  at: string;
  title: string;
  description: string | null;
  actor: { id: string | null; name: string | null } | null;
  link: string | null;
  tone: TimelineTone;
}

export interface MemberSignal {
  key: string;
  label: string;
  tone: 'info' | 'warning' | 'danger';
}

export interface MemberSummary {
  level: { level: number; xp: number; rank: number } | null;
  reputation: { received: number; given: number };
  economy: { balance: number; rank: number } | null;
  invites: { total: number; stillHere: number; leftWithinWeek: number };
  support: { tickets: number; openTickets: number; averageRating: number | null; ratings: number };
  community: { suggestions: number; forms: number; giveawayWins: number };
  joins: number;
  signals: MemberSignal[];
}

export interface MemberRankEntry {
  value: number;
  rank: number | null;
  percentile: number | null;
  guildAverage: number;
  trend: number | null;
}

export interface MemberActivityStats {
  userId: string;
  period: number;
  timezone: string;
  loggingEnabled: boolean;
  activity: {
    heatmap: number[][];
    heatmapTotal: number;
    peakHour: number | null;
    peakWeekday: number | null;
    dailyTrend: Array<{ dateKey: string; messages: number; voiceMinutes: number }>;
    activeDays: number;
    currentStreak: number;
    longestStreak: number;
    totalMessages: number;
    totalVoiceMinutes: number;
  };
  risk: {
    warnCount: number;
    warnScore: number;
    riskLevel: number;
    riskLabel: 'faible' | 'modéré' | 'élevé' | 'critique';
    daysSinceLastSanction: number | null;
    isRepeatOffender: boolean;
  };
  social: {
    topChannels: Array<{ channelId: string; channelName: string; count: number; share: number }>;
    topInterlocutors: Array<{ userId: string; userTag: string | null; avatarUrl: string | null; mentions: number; replies: number; total: number }>;
  };
  ranking: { totalRankedMembers: number; messages: MemberRankEntry; voice: MemberRankEntry };
}

export function fetchMemberSummary(userId: string, guildId = authStore.selectedGuildId) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return dashboardRequest<{ summary: MemberSummary; insights: MemberActivityStats | null; climate?: MemberClimate | null }>(
    `/members/${userId}/summary?days=90&tz=${encodeURIComponent(tz)}`,
    { guildId, errorContext: 'API Error (Member summary):' },
  );
}

export function fetchMemberTimeline(
  userId: string,
  options: { before?: string | null; categories?: TimelineCategory[] } = {},
  guildId = authStore.selectedGuildId,
) {
  const params = new URLSearchParams();
  if (options.before) params.set('before', options.before);
  if (options.categories?.length) params.set('categories', options.categories.join(','));
  const query = params.toString();
  return dashboardRequest<{ items: TimelineItem[]; nextBefore: string | null }>(
    `/members/${userId}/timeline${query ? `?${query}` : ''}`,
    { guildId, errorContext: 'API Error (Member timeline):' },
  );
}

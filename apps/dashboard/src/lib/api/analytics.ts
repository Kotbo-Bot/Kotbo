/** Analytics et profils publics. */
import { authStore } from '../stores/auth.svelte';
import { timezoneStore } from '../stores/timezone.svelte';
import { API_BASE_URL, JSON_HEADERS, getGuildId, dashboardRequest } from './client';

import { DashboardApiError, kindFromStatus } from './errors';
/**
 * Fuseau de lecture joint a toute requete qui renvoie des creneaux horaires.
 *
 * Les agregats sont stockes en UTC : sans ce parametre, l'API repondait avec
 * des heures UTC et le dashboard affichait a minuit un pic reellement observe
 * a 14h. Le serveur retombe sur le fuseau du serveur Discord si le parametre
 * manque ou n'est pas un identifiant IANA connu.
 */
function appendViewTimezone(params: URLSearchParams) {
  params.append('tz', timezoneStore.displayTimezone);
  return params;
}

export async function fetchAnalytics(options: { period?: number, startDate?: string, endDate?: string, granularity?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.period) params.append('period', options.period.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);
  if (options.granularity) params.append('granularity', options.granularity);
  appendViewTimezone(params);

  return dashboardRequest(`/analytics?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Analytics):'
  });
}

export async function fetchInviteAnalytics(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/analytics/invites', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Invite Analytics):'
  });
}

export async function fetchChannelDetails(channelId: string, options: { days?: number } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  appendViewTimezone(params);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return dashboardRequest(`/analytics/channels/${channelId}${suffix}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Channel Details):'
  });
}

export async function fetchMemberDetailedAnalytics(userId, period = 30, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/analytics/members?userId=${userId}&period=${period}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Member Detailed Analytics):'
  });
}

export async function fetchPublicProfile(userId: string) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authStore.token) {
    headers.Authorization = `Bearer ${authStore.token}`;
  }

  const response = await fetch(`${API_BASE_URL}/api/public/profile/${userId}`, { headers });
  if (!response.ok) {
    throw new DashboardApiError({
      kind: kindFromStatus(response.status),
      status: response.status,
      path: response.url,
    });
  }

  return response.json();
}

export async function updatePublicProfile(userId: string, payload: { bio?: string | null; isProfilePrivate?: boolean }) {
  if (!authStore.token) {
    throw new Error('No auth token available');
  }

  const response = await fetch(`${API_BASE_URL}/api/public/profile/${userId}`, {
    method: 'PATCH',
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${authStore.token}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new DashboardApiError({
      kind: kindFromStatus(response.status),
      status: response.status,
      path: response.url,
    });
  }

  return response.json();
}

export async function fetchStaffProfile(userId: string, guildId = authStore.selectedGuildId) {
  const selectedGuildId = getGuildId(guildId);
  if (!selectedGuildId) return null;

  if (!authStore.token) {
    throw new Error('No auth token available');
  }

  const response = await fetch(`${API_BASE_URL}/api/dashboard/users/${userId}/profile?guildId=${selectedGuildId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${authStore.token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new DashboardApiError({
      kind: kindFromStatus(response.status),
      status: response.status,
      path: response.url,
    });
  }

  return response.json();
}

export async function fetchHourlyHeatmap(options: { days?: number, startDate?: string, endDate?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);
  appendViewTimezone(params);

  return dashboardRequest(`/analytics/heatmap?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Hourly Heatmap):'
  });
}

export type AdvancedAnalyticsSection =
  | 'retention' | 'activity' | 'churn' | 'channels' | 'social' | 'words' | 'moderation';

export async function fetchAdvancedAnalytics(section: AdvancedAnalyticsSection, guildId = authStore.selectedGuildId) {
  const params = appendViewTimezone(new URLSearchParams({ section }));
  return dashboardRequest(`/analytics/advanced?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: `API Error (Advanced Analytics ${section}):`
  });
}

export async function fetchWeeklyComparison(options: { offset?: number, mode?: 'week' | 'month' } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.offset) params.append('offset', options.offset.toString());
  if (options.mode) params.append('mode', options.mode);
  return dashboardRequest(`/analytics/weekly-comparison?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Weekly Comparison):'
  });
}

export async function fetchGrowthAndRetention(options: { days?: number, startDate?: string, endDate?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);

  return dashboardRequest(`/analytics/growth-retention?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Growth & Retention):'
  });
}

export async function fetchDailyAlgoAnalytics(options: { days?: number, startDate?: string, endDate?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);

  return dashboardRequest(`/analytics/daily-algo?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Daily Algo Analytics):'
  });
}

export async function fetchGlobalInteractions(options: { period?: number, startDate?: string, endDate?: string } = {}, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.period) params.append('period', options.period.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);

  return dashboardRequest(`/analytics/interactions?${params.toString()}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Global Interactions Graph):'
  });
}

// ── Nouvelle page Analytics ────────────────────────────────────────────────

/** Période et filtres partagés par toutes les sections de la page Analytics. */
export interface AnalyticsQuery {
  period?: number;
  startDate?: string;
  endDate?: string;
  /** Salon ou catégorie. */
  channel?: string | null;
  role?: string | null;
  excludeStaff?: boolean;
  includeBots?: boolean;
  userId?: string | null;
}

export interface AnalyticsRange {
  start: string;
  end: string;
  prevStart: string;
  prevEnd: string;
  days: number;
}

export interface ComparedValue {
  value: number;
  previous: number;
}

export interface ContentEmoji {
  key: string;
  origin: 'unicode' | 'guild' | 'external';
  count: number;
  name: string | null;
  animated: boolean;
  imageUrl: string | null;
  sourceName: string | null;
}

export interface ContentSticker {
  key: string;
  origin: 'guild' | 'external' | 'standard';
  count: number;
  name: string | null;
  imageUrl: string;
  sourceName: string | null;
}

export interface ContentSourceServer {
  guildId: string | null;
  name: string | null;
  count: number;
  items: number;
}

export interface ContentAnalytics {
  range: AnalyticsRange;
  itemBasis: 'server' | 'channel' | 'member';
  totals: Record<string, number>;
  previous: Record<string, number>;
  emojis: ContentEmoji[];
  reactions: ContentEmoji[];
  emojiServers: ContentSourceServer[];
  reactionServers: ContentSourceServer[];
  stickers: ContentSticker[];
  stickerServers: ContentSourceServer[];
  domains: Array<{ domain: string; family: string; count: number }>;
  gifChannels: Array<{ channelId: string; name: string | null; count: number }>;
  backfill: { status: string; processed: number; total: number } | null;
}

export interface ActivityAnalytics {
  range: AnalyticsRange;
  voiceAvailable: boolean;
  kpis: {
    messages: ComparedValue;
    activeMembers: ComparedValue;
    voiceMinutes: ComparedValue;
    netJoins: ComparedValue;
    joined: number;
    left: number;
    memberCount: number | null;
  };
  series: ActivityDay[];
  topChannels: Array<{ channelId: string; name: string | null; messages: number }>;
  /** Jours inhabituels (pic ou creux) par rapport aux mêmes jours de semaine. */
  anomalies?: ActivityAnomaly[];
}

export interface ActivityDay {
  dateKey: string;
  messages: number;
  voiceMinutes: number;
  prevMessages: number;
  prevVoiceMinutes: number;
  activeMembers?: number;
  prevActiveMembers?: number;
  joined?: number;
  left?: number;
  prevJoined?: number;
  prevLeft?: number;
}

export interface ActivityAnomaly {
  dateKey: string;
  metric: 'messages' | 'voiceMinutes';
  value: number;
  expected: number;
  direction: 'up' | 'down';
  driver: { channelId: string; name: string | null; share: number } | null;
}

export type ActivityMetricKind = 'messages' | 'voice';

export interface ActivityHourPoint { key: string; messages: number; voiceMinutes: number; activeMembers: number }

export interface ActivityHourly {
  available: boolean;
  timezone: string;
  points: ActivityHourPoint[];
  prev: ActivityHourPoint[];
}

export interface ActivityRankingItem {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  value: number;
  previous: number;
  share: number;
  spark: number[];
  deleted?: boolean;
}

export interface ActivityRankings {
  available: boolean;
  metric: ActivityMetricKind;
  dimension: 'members' | 'channels';
  total: number;
  prevTotal: number;
  items: ActivityRankingItem[];
}

export interface ActivityBreakdown {
  available: boolean;
  dates: string[];
  groups: Array<{ id: string | null; name: string | null; total: number; values: number[] }>;
  other: number[];
}

export interface AnalyticsAnnotation {
  id: string;
  dateKey: string;
  label: string;
  authorId: string;
  authorName: string | null;
  createdAt: string;
}

export interface ChannelTreeChannel {
  id: string;
  name: string;
  kind: 'text' | 'voice' | 'forum';
  messages: number;
  voiceMinutes: number;
  prevMessages: number;
  prevVoiceMinutes: number;
  authors: number;
  lastActiveDate: string | null;
}

export interface ChannelTreeCategory {
  id: string | null;
  name: string | null;
  messages: number;
  voiceMinutes: number;
  prevMessages: number;
  prevVoiceMinutes: number;
  authors: number;
  channels: ChannelTreeChannel[];
}

export interface ChannelTree {
  range: AnalyticsRange;
  totals: { messages: number; voiceMinutes: number };
  orphan: { messages: number; voiceMinutes: number } | null;
  categories: ChannelTreeCategory[];
}

export interface CategoryDetail {
  range: AnalyticsRange;
  id: string;
  name: string;
  kpis: {
    messages: ComparedValue;
    voiceMinutes: ComparedValue;
    activeMembers: number;
    messageShare: ComparedValue;
    voiceShare: number;
  };
  daily: Array<{ dateKey: string; textOnly: number; voiceOnly: number; both: number }>;
  /** Messages et vocal par jour, la période et celle d'avant alignées jour pour jour. */
  series: {
    current: Array<{ dateKey: string; messages: number; voiceMinutes: number }>;
    previous: Array<{ dateKey: string; messages: number; voiceMinutes: number }>;
  };
  voiceHistoryDays: number;
  channels: ChannelTreeChannel[];
  topMembers: Array<{ userId: string; name: string | null; avatarUrl: string | null; messages: number; voiceMinutes: number }>;
}

export interface AnalyticsFilterOptions {
  categories: Array<{ id: string | null; name: string | null; channels: Array<{ id: string; name: string; kind: string }> }>;
  roles: Array<{ id: string; name: string; color: string; members: number }>;
}

function analyticsParams(query: AnalyticsQuery): string {
  const params = new URLSearchParams();
  if (query.startDate && query.endDate) {
    params.append('startDate', query.startDate);
    params.append('endDate', query.endDate);
  } else if (query.period) {
    params.append('period', String(query.period));
  }
  if (query.channel) params.append('channel', query.channel);
  if (query.role) params.append('role', query.role);
  if (query.userId) params.append('userId', query.userId);
  if (query.excludeStaff) params.append('excludeStaff', '1');
  if (query.includeBots) params.append('includeBots', '1');
  return params.toString();
}

export async function fetchContentAnalytics(query: AnalyticsQuery, guildId = authStore.selectedGuildId): Promise<ContentAnalytics | null> {
  return dashboardRequest<ContentAnalytics>(`/analytics/content?${analyticsParams(query)}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Content Analytics):'
  });
}

export async function fetchActivityAnalytics(query: AnalyticsQuery, guildId = authStore.selectedGuildId): Promise<ActivityAnalytics | null> {
  return dashboardRequest<ActivityAnalytics>(`/analytics/activity?${analyticsParams(query)}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Activity Analytics):'
  });
}

export async function fetchActivityHourly(query: AnalyticsQuery, guildId = authStore.selectedGuildId): Promise<ActivityHourly | null> {
  const params = new URLSearchParams(analyticsParams(query));
  params.append('tz', timezoneStore.displayTimezone);
  return dashboardRequest<ActivityHourly>(`/analytics/activity/hourly?${params}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Activity Hourly):'
  });
}

export async function fetchActivityRankings(
  query: AnalyticsQuery,
  metric: ActivityMetricKind,
  dimension: 'members' | 'channels',
  limit = 10,
  guildId = authStore.selectedGuildId,
): Promise<ActivityRankings | null> {
  const params = new URLSearchParams(analyticsParams(query));
  params.append('metric', metric);
  params.append('dimension', dimension);
  params.append('limit', String(limit));
  return dashboardRequest<ActivityRankings>(`/analytics/activity/rankings?${params}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Activity Rankings):'
  });
}

export async function fetchActivityBreakdown(
  query: AnalyticsQuery,
  metric: ActivityMetricKind,
  dimension: 'channel' | 'category',
  guildId = authStore.selectedGuildId,
): Promise<ActivityBreakdown | null> {
  const params = new URLSearchParams(analyticsParams(query));
  params.append('metric', metric);
  params.append('dimension', dimension);
  return dashboardRequest<ActivityBreakdown>(`/analytics/activity/breakdown?${params}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Activity Breakdown):'
  });
}

export async function fetchAnalyticsAnnotations(query: AnalyticsQuery, guildId = authStore.selectedGuildId): Promise<AnalyticsAnnotation[] | null> {
  return dashboardRequest<AnalyticsAnnotation[]>(`/analytics/annotations?${analyticsParams({ period: query.period, startDate: query.startDate, endDate: query.endDate })}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Analytics Annotations):'
  });
}

export async function createAnalyticsAnnotation(payload: { dateKey: string; label: string }, guildId = authStore.selectedGuildId): Promise<{ id: string } | null> {
  return dashboardRequest<{ id: string }>('/analytics/annotations', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Create Annotation):'
  });
}

export async function deleteAnalyticsAnnotation(id: string, guildId = authStore.selectedGuildId): Promise<{ ok: boolean } | null> {
  return dashboardRequest<{ ok: boolean }>(`/analytics/annotations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Annotation):'
  });
}

export interface EngagementAnalytics {
  step: number;
  channelIgnored: boolean;
  points: Array<{ dateKey: string; dau: number; wau: number; mau: number; prevDau: number; prevWau: number; prevMau: number }>;
}

export interface ActivityCohorts {
  weeks: number;
  channelIgnored: boolean;
  cohorts: Array<{ week: string; size: number; retention: Array<number | null> }>;
}

export interface FunnelSteps {
  joined: number;
  stayed: number;
  firstMessage: number;
  eligible7: number;
  active7: number;
  eligible30: number;
  active30: number;
  medianDaysToFirstMessage: number | null;
}

export interface OnboardingFunnel {
  channelIgnored: boolean;
  overall: FunnelSteps;
  bySource: Array<FunnelSteps & { key: string; label: string | null; kind: 'label' | 'vanity' | 'code' | 'unknown' }>;
}

export type LifecycleSegment = 'new' | 'regular' | 'casual' | 'reactivated' | 'declining' | 'dormant' | 'silent';

export interface LifecycleMember {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  lastActive: string | null;
  recentDays: number;
  previousDays: number;
  joinedAt: string | null;
}

export interface LifecycleAnalytics {
  asOf: string;
  prevAsOf: string;
  channelIgnored: boolean;
  counts: Record<LifecycleSegment, number>;
  prevCounts: Record<LifecycleSegment, number>;
  transitions: Array<{ from: LifecycleSegment; to: LifecycleSegment; count: number }>;
  lists: Partial<Record<LifecycleSegment, LifecycleMember[]>>;
}

function audienceRequest<T>(view: string, query: AnalyticsQuery, guildId: typeof authStore.selectedGuildId): Promise<T | null> {
  return dashboardRequest<T>(`/analytics/audience/${view}?${analyticsParams(query)}`, {
    method: 'GET',
    guildId,
    errorContext: `API Error (Audience ${view}):`
  });
}

export const fetchEngagement = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => audienceRequest<EngagementAnalytics>('engagement', query, guildId);
export const fetchActivityCohorts = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => audienceRequest<ActivityCohorts>('cohorts', query, guildId);
export const fetchOnboardingFunnel = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => audienceRequest<OnboardingFunnel>('funnel', query, guildId);
export const fetchLifecycle = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => audienceRequest<LifecycleAnalytics>('lifecycle', query, guildId);

export interface ResponseSummary {
  turns: number;
  answered: number;
  unanswered: number;
  unansweredRate: number | null;
  medianSec: number | null;
  avgSec: number | null;
  buckets: Array<{ key: 'under1m' | 'under5m' | 'under15m' | 'under1h' | 'under6h'; count: number }>;
}

export interface ResponseTimes {
  userIgnored: boolean;
  total: ResponseSummary;
  previous: ResponseSummary;
  daily: Array<{ dateKey: string; medianSec: number | null; unansweredRate: number | null; turns: number }>;
  channels: Array<ResponseSummary & { channelId: string; name: string | null }>;
}

export interface ConcentrationStats {
  members: number;
  total: number;
  top1Share: number;
  top10Share: number;
  top10MembersShare: number;
  membersForHalf: number;
  gini: number;
  lorenz: Array<{ members: number; activity: number }>;
}

export interface Concentration {
  available: boolean;
  metric: ActivityMetricKind;
  current?: ConcentrationStats;
  previous?: ConcentrationStats;
}

export type ChannelHealthStatus = 'dead' | 'declining' | 'saturated' | 'quiet' | 'healthy' | 'growing';

export interface ChannelHealthRow {
  channelId: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  messages: number;
  prevMessages: number;
  authors: number;
  days: number;
  lastActiveDaysAgo: number | null;
  lastActiveDate: string | null;
  medianResponseSec: number | null;
  unansweredRate: number | null;
  status: ChannelHealthStatus;
  score: number;
  suggestion: 'archive' | 'revive' | 'split' | 'merge' | null;
}

export interface NetworkMember { userId: string; name: string | null; avatarUrl: string | null }

export interface ConversationNetwork {
  channelIgnored: boolean;
  totals: { members: number; links: number; replies: number; mentions: number; reciprocity: number | null; activeMembers: number; isolatedCount: number };
  groups: Array<{ id: string; size: number; internalWeight: number; leaders: NetworkMember[] }>;
  bridges: Array<NetworkMember & { groups: number; outsideWeight: number }>;
  pairs: Array<{ a: NetworkMember; b: NetworkMember; replies: number; mentions: number; reciprocal: boolean }>;
  isolated: Array<NetworkMember & { messages: number }>;
}

function conversationRequest<T>(view: string, query: AnalyticsQuery, guildId: typeof authStore.selectedGuildId, extra = ''): Promise<T | null> {
  return dashboardRequest<T>(`/analytics/conversation/${view}?${analyticsParams(query)}${extra}`, {
    method: 'GET',
    guildId,
    errorContext: `API Error (Conversation ${view}):`
  });
}

export const fetchResponseTimes = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => conversationRequest<ResponseTimes>('responses', query, guildId);
export const fetchConcentration = (query: AnalyticsQuery, metric: ActivityMetricKind, guildId = authStore.selectedGuildId) =>
  conversationRequest<Concentration>('concentration', query, guildId, `&metric=${metric}`);
export const fetchChannelHealthReport = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) =>
  conversationRequest<{ channels: ChannelHealthRow[] }>('channel-health', { period: query.period, startDate: query.startDate, endDate: query.endDate }, guildId);
export const fetchConversationNetwork = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => conversationRequest<ConversationNetwork>('network', query, guildId);

export interface GrowthInsights {
  departures: { total: number; unknownTenure: number; byTenure: Array<{ key: 'under1d' | 'under7d' | 'under30d' | 'under180d' | 'over180d'; count: number }> };
  quickLeave: { joined: number; left24h: number; rate: number | null; previousRate: number | null };
  sources: {
    dates: string[];
    groups: Array<{ key: string; kind: 'unknown' | 'vanity' | 'label' | 'code'; label: string | null; total: number; values: number[] }>;
    other: number[];
  };
}

export interface ModerationTrends {
  total: number;
  previousTotal: number;
  byType: { dates: string[]; series: Array<{ type: string; total: number; values: number[] }> };
  moderators: Array<{ userId: string; name: string | null; count: number; previous: number; types: Record<string, number>; share: number }>;
  recidivism: {
    sanctioned: number;
    repeat: number;
    rate: number | null;
    previousRate: number | null;
    offenders: Array<{ userId: string; name: string | null; count: number; last: string | null }>;
  };
  reportDelay: { reports: number; medianSec: number | null };
}

export interface StaffInsights {
  timezone: string;
  measuredSince: boolean;
  tickets: {
    opened: number;
    previousOpened: number;
    responded: number;
    firstResponseMedianSec: number | null;
    previousFirstResponseMedianSec: number | null;
    within1h: number | null;
    resolutionMedianSec: number | null;
    previousResolutionMedianSec: number | null;
    unresolved: number;
  };
  staff: Array<{ userId: string; name: string | null; claimed: number; closed: number; firstResponses: number; firstResponseMedianSec: number | null; share: number }>;
  coverage: Array<Array<{ opened: number; medianSec: number | null }>>;
}

export interface WordTrend { word: string; count: number; previous: number; change: number | null }

export interface RisingWords {
  enabled: boolean;
  hasData: boolean;
  rising: WordTrend[];
  falling: WordTrend[];
  fresh: WordTrend[];
}

function insightsRequest<T>(view: string, query: AnalyticsQuery, guildId: typeof authStore.selectedGuildId): Promise<T | null> {
  const params = new URLSearchParams(analyticsParams({ period: query.period, startDate: query.startDate, endDate: query.endDate }));
  if (view === 'staff') params.append('tz', timezoneStore.displayTimezone);
  return dashboardRequest<T>(`/analytics/insights/${view}?${params}`, { method: 'GET', guildId, errorContext: `API Error (Insights ${view}):` });
}

export const fetchGrowthInsights = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => insightsRequest<GrowthInsights>('growth', query, guildId);
export const fetchModerationTrends = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => insightsRequest<ModerationTrends>('moderation', query, guildId);
export const fetchStaffInsights = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => insightsRequest<StaffInsights>('staff', query, guildId);
export const fetchRisingWords = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => insightsRequest<RisingWords>('words', query, guildId);

export type AlertMetric = 'messages' | 'voiceMinutes' | 'activeMembers' | 'joins' | 'leaves' | 'netJoins' | 'sanctions' | 'channelRate' | 'unansweredRate' | 'pulseScore';
export type AlertCondition = 'drop_pct' | 'rise_pct' | 'above' | 'below';
export type AlertWindow = 'hour' | 'day' | 'week';

export interface AlertRuleInput {
  name: string;
  metric: AlertMetric;
  condition: AlertCondition;
  threshold: number;
  window: AlertWindow;
  channelId: string | null;
  notifyChannelId: string | null;
  notifyUserIds: string[];
  enabled: boolean;
  cooldownHours: number;
}

export interface AlertRule extends AlertRuleInput {
  id: string;
  lastTriggeredAt: string | null;
  createdById: string;
  createdAt: string;
}

export interface AlertEvent { id: string; ruleId: string; periodKey: string; value: number; baseline: number | null; delivered: boolean; triggeredAt: string }

export type ReportSection = 'kotbo_work' | 'overview' | 'top_members' | 'top_channels' | 'anomalies' | 'moderation' | 'responses';

export interface ReportScheduleInput {
  frequency: 'weekly' | 'monthly';
  weekday: number;
  monthDay: number;
  hour: number;
  channelId: string | null;
  userIds: string[];
  sections: ReportSection[];
  enabled: boolean;
}

export interface ReportSchedule extends ReportScheduleInput {
  id: string;
  nextRunAt: string;
  lastSentAt: string | null;
}

const req = <T>(path: string, method: string, payload?: unknown, guildId = authStore.selectedGuildId) =>
  dashboardRequest<T>(path, { method, payload, guildId, errorContext: `API Error (${method} ${path}):` });

export const fetchAlertRules = () => req<{ rules: AlertRule[]; events: AlertEvent[] }>('/analytics/alerts', 'GET');
export const createAlertRule = (input: AlertRuleInput) => req<AlertRule>('/analytics/alerts', 'POST', input);
export const updateAlertRule = (id: string, input: AlertRuleInput) => req<{ ok: boolean }>(`/analytics/alerts/${encodeURIComponent(id)}`, 'PUT', input);
export const deleteAlertRule = (id: string) => req<{ ok: boolean }>(`/analytics/alerts/${encodeURIComponent(id)}`, 'DELETE');
export const fetchReportSchedules = () => req<{ schedules: ReportSchedule[] }>('/analytics/reports', 'GET');
export const createReportSchedule = (input: ReportScheduleInput) => req<ReportSchedule>('/analytics/reports', 'POST', input);
export const updateReportSchedule = (id: string, input: ReportScheduleInput) => req<{ ok: boolean }>(`/analytics/reports/${encodeURIComponent(id)}`, 'PUT', input);
export const deleteReportSchedule = (id: string) => req<{ ok: boolean }>(`/analytics/reports/${encodeURIComponent(id)}`, 'DELETE');
export const testReportSchedule = (id: string) => req<{ ok: boolean }>(`/analytics/reports/${encodeURIComponent(id)}/test`, 'POST');

export interface SavedViewPayload {
  tab: string;
  period: string;
  start?: string;
  end?: string;
  compare: boolean;
  channel: string | null;
  role: string | null;
  excludeStaff: boolean;
  includeBots: boolean;
}

export interface SavedView { id: string; name: string; payload: SavedViewPayload; shared: boolean; mine: boolean; createdAt: string }

export const fetchSavedViews = () => req<SavedView[]>('/analytics/views', 'GET');
export const createSavedView = (input: { name: string; payload: SavedViewPayload; shared: boolean }) => req<SavedView>('/analytics/views', 'POST', input);
export const deleteSavedView = (id: string) => req<{ ok: boolean }>(`/analytics/views/${encodeURIComponent(id)}`, 'DELETE');

export interface MemberOverview {
  memberCount: number | null;
  series: Array<{
    dateKey: string; members: number; joined: number; left: number; peakOnline: number; onlineMembers: number;
    prevMembers: number; prevJoined: number; prevLeft: number; prevPeakOnline: number; prevOnlineMembers: number;
  }>;
  sources: {
    tracked: number;
    kinds: Array<{ kind: 'invite' | 'vanity' | 'label' | 'unknown'; joined: number; retention: number | null }>;
    links: Array<{ code: string; label: string | null; inviterId: string | null; inviterTag: string | null; joined: number; stayed: number; retention: number | null; isVanity: boolean }>;
  };
  inviters: Array<{ userId: string; name: string | null; avatarUrl: string | null; joined: number; previous: number; stayed: number; retention: number | null; left24h: number }>;
  newcomers: {
    joined: number;
    accountAge: { known: number; buckets: Array<{ key: 'under1d' | 'under7d' | 'under30d' | 'under365d' | 'over365d'; count: number }> };
    onboarding: { completed: number; rate: number | null } | null;
    left24h: { count: number; rate: number | null };
  };
}

export const fetchMemberOverview = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) => {
  const params = new URLSearchParams(analyticsParams({ period: query.period, startDate: query.startDate, endDate: query.endDate, includeBots: query.includeBots }));
  return dashboardRequest<MemberOverview>(`/analytics/members/overview?${params}`, { method: 'GET', guildId, errorContext: 'API Error (Member Overview):' });
};

export interface CommandAnalytics {
  totals: { uses: number; previousUses: number; users: number; previousUsers: number; commands: number; errorRate: number | null; avgMs: number | null };
  daily: Array<{ dateKey: string; uses: number; previous: number }>;
  commands: Array<{ name: string; uses: number; previous: number; users: number; share: number; errorRate: number | null; avgMs: number | null; spark: number[] }>;
  topUsers: Array<{ userId: string; name: string | null; avatarUrl: string | null; uses: number; commands: number }>;
  unused: string[];
  allTime: Array<{ name: string; count: number }> | null;
}

export const fetchCommandAnalytics = (query: AnalyticsQuery, guildId = authStore.selectedGuildId) =>
  dashboardRequest<CommandAnalytics>(`/analytics/commands/stats?${analyticsParams({ period: query.period, startDate: query.startDate, endDate: query.endDate })}`, {
    method: 'GET', guildId, errorContext: 'API Error (Command Analytics):',
  });

export type HeatmapCell = { messages: number; voice: number; active: number; joins: number; leaves: number; net: number };
export type HeatmapGrid = Record<number, Record<number, HeatmapCell>>;

export interface HeatmapComparison {
  current: HeatmapGrid;
  previous: HeatmapGrid;
  timezone: string;
  range: { start: string; end: string; prevStart: string; prevEnd: string };
}

export async function fetchHeatmapComparison(options: { days?: number; startDate?: string; endDate?: string }, guildId = authStore.selectedGuildId) {
  const params = new URLSearchParams();
  if (options.days) params.append('days', options.days.toString());
  if (options.startDate) params.append('startDate', options.startDate);
  if (options.endDate) params.append('endDate', options.endDate);
  params.append('compare', '1');
  appendViewTimezone(params);
  return dashboardRequest<HeatmapComparison>(`/analytics/heatmap?${params}`, { method: 'GET', guildId, errorContext: 'API Error (Heatmap comparison):' });
}

export interface PeriodTotals { messages: number; voiceMinutes: number; joins: number; leaves: number; sanctions: number }
export interface PeriodDay { messages: number; voiceMinutes: number; joins: number; leaves: number; sanctions: number; activeMembers: number; peakOnline: number }

export interface PeriodComparison {
  mode: 'week' | 'month';
  offset: number;
  ranges: { current: { start: string; end: string; elapsedDays: number }; previous: { start: string; end: string; toDateEnd: string } };
  thisWeek: PeriodTotals;
  lastWeek: PeriodTotals;
  lastWeekToDate: PeriodTotals;
  activeMembers: { current: number; previousToDate: number };
  daily: Array<{ index: number; currentKey: string | null; previousKey: string | null; current: PeriodDay | null; previous: PeriodDay | null }>;
}

export async function fetchChannelTree(query: AnalyticsQuery, guildId = authStore.selectedGuildId): Promise<ChannelTree | null> {
  return dashboardRequest<ChannelTree>(`/analytics/channel-tree?${analyticsParams({ period: query.period, startDate: query.startDate, endDate: query.endDate })}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Channel Tree):'
  });
}

export async function fetchCategoryDetail(categoryId: string, query: AnalyticsQuery, guildId = authStore.selectedGuildId): Promise<CategoryDetail | null> {
  return dashboardRequest<CategoryDetail>(`/analytics/categories/${categoryId}?${analyticsParams({ period: query.period, startDate: query.startDate, endDate: query.endDate })}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Category Detail):'
  });
}

export async function fetchAnalyticsFilterOptions(guildId = authStore.selectedGuildId): Promise<AnalyticsFilterOptions | null> {
  return dashboardRequest<AnalyticsFilterOptions>('/analytics/filters', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Analytics Filters):'
  });
}

/** Automod des tags : réglages, règles, recherche de serveurs, aperçu et journal. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

export type TagAction = 'ALERT' | 'DM' | 'TICKET' | 'ROLE' | 'WARN' | 'TIMEOUT' | 'JAIL' | 'KICK' | 'SOFTBAN' | 'BAN';
export type TagTrigger =
  | 'JOIN' | 'TAG_CHANGE' | 'RESCAN' | 'WAVE' | 'NEW_ACCOUNT' | 'MASS_ADOPT'
  | 'IMPERSONATION' | 'SHARED_LIST' | 'ALLOWLIST' | 'ESCALATION';

export interface TagAutomodConfig {
  enabled: boolean;
  testMode: boolean;
  onJoin: boolean;
  onTagChange: boolean;
  exemptRoleIds: string[];
  exemptUserIds: string[];
  alertChannelId: string | null;
  allowlistOnly: boolean;
  allowlistAction: TagAction;
  allowlistDurationMin: number | null;
  sharedListEnabled: boolean;
  sharedListAction: TagAction;
  sharedListDurationMin: number | null;
  waveEnabled: boolean;
  waveMode: 'ADAPTIVE' | 'FIXED';
  wavePreset: 'SOFT' | 'NORMAL' | 'STRICT';
  waveThreshold: number;
  waveWindowSec: number;
  waveAction: TagAction;
  waveDurationMin: number | null;
  waveBlockHours: number;
  waveReportFleet: boolean;
  newAccountEnabled: boolean;
  newAccountDays: number;
  newAccountScope: 'ANY' | 'UNKNOWN';
  newAccountAction: TagAction;
  newAccountDurationMin: number | null;
  massAdoptEnabled: boolean;
  massAdoptThreshold: number;
  massAdoptWindowMin: number;
  massAdoptAction: TagAction;
  impersonationEnabled: boolean;
  impersonationAction: TagAction;
  impersonationDurationMin: number | null;
}

export interface TagAutomodRule {
  id: string;
  name: string;
  enabled: boolean;
  effect: 'BLOCK' | 'ALLOW';
  targetType: 'SERVER' | 'TEXT';
  targetGuildId: string | null;
  targetName: string | null;
  targetIcon: string | null;
  pattern: string | null;
  matchMode: 'EXACT' | 'CONTAINS' | 'REGEX';
  action: TagAction;
  durationMin: number | null;
  roleId: string | null;
  message: string | null;
  escalateAfterMin: number | null;
  escalateAction: TagAction | null;
  escalateDurationMin: number | null;
  expiresAt: string | null;
  source: 'MANUAL' | 'TEMPLATE' | 'WAVE';
  createdAt: string;
  fleetBlocks?: number;
}

export type TagRuleDraft = Partial<Omit<TagAutomodRule, 'id' | 'createdAt' | 'expiresAt' | 'fleetBlocks'>>;

export interface TagWaveSummary {
  id: string;
  tagGuildId: string | null;
  tag: string | null;
  userIds: string[];
  kind: 'ARRIVALS' | 'MASS_ADOPT';
  status: 'OPEN' | 'SANCTIONED' | 'IGNORED' | 'BLOCKED';
  createdAt: string;
}

export interface TagAutomodState {
  config: TagAutomodConfig;
  configured: boolean;
  rules: TagAutomodRule[];
  maxRules: number;
  ownTag: string | null;
  ownBadgeUrl: string | null;
  jailConfigured: boolean;
  fleetMinReporters: number;
  stats: { membersWithOtherTag: number; events7d: number; byStatus: Record<string, number> };
  waves: TagWaveSummary[];
}

export interface TagServerResult {
  guildId: string;
  name: string;
  iconUrl: string | null;
  tag: string | null;
  badgeUrl: string | null;
  memberCount: number | null;
  holders: number;
  fleetBlocks: number;
  /** Identifiant saisi, inconnu de Kotbo : ni nom ni tag connus. */
  unlisted: boolean;
}

export interface TagScanMatch {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  tag: string | null;
  tagGuildId: string;
  action: TagAction;
  trigger: TagTrigger;
  ruleName: string | null;
}

export interface TagScanResult {
  scanned: number;
  withTag: number;
  total: number;
  matches: TagScanMatch[];
}

export interface TagAutomodEvent {
  id: string;
  userId: string;
  userTag: string | null;
  tagGuildId: string | null;
  tag: string | null;
  trigger: TagTrigger;
  ruleId: string | null;
  waveId: string | null;
  action: TagAction;
  status: 'APPLIED' | 'DRY_RUN' | 'PENDING' | 'RESOLVED' | 'FAILED' | 'SKIPPED';
  detail: string | null;
  dueAt: string | null;
  escalateAction: TagAction | null;
  createdAt: string;
}

export async function fetchTagAutomod(guildId = authStore.selectedGuildId): Promise<TagAutomodState | null> {
  return dashboardRequest<TagAutomodState>('/tag-automod', { method: 'GET', guildId, errorContext: 'API Error (Tag Automod):' });
}

export async function updateTagAutomodConfig(payload: Partial<TagAutomodConfig>, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ config: TagAutomodConfig }>('/tag-automod', { method: 'PATCH', payload, guildId, errorContext: 'API Error (Tag Automod Config):' });
}

export async function searchTagServers(q: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ servers: TagServerResult[] }>(`/tag-automod/search?q=${encodeURIComponent(q)}`, {
    method: 'GET', guildId, errorContext: 'API Error (Tag Search):', silent: true,
  });
}

export async function createTagRule(payload: TagRuleDraft, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ rule: TagAutomodRule }>('/tag-automod/rules', { method: 'POST', payload, guildId, errorContext: 'API Error (Tag Rule):' });
}

export async function updateTagRule(id: string, payload: TagRuleDraft & { permanent?: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ rule: TagAutomodRule }>(`/tag-automod/rules/${encodeURIComponent(id)}`, { method: 'PATCH', payload, guildId, errorContext: 'API Error (Tag Rule):' });
}

export async function deleteTagRule(id: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/tag-automod/rules/${encodeURIComponent(id)}`, { method: 'DELETE', guildId, errorContext: 'API Error (Tag Rule):' });
}

export async function fetchTagAutomodEvents(params: { before?: string; tagGuildId?: string; limit?: number } = {}, guildId = authStore.selectedGuildId) {
  const qs = new URLSearchParams();
  if (params.before) qs.set('before', params.before);
  if (params.tagGuildId) qs.set('tagGuildId', params.tagGuildId);
  if (params.limit) qs.set('limit', String(params.limit));
  return dashboardRequest<{ events: TagAutomodEvent[]; hasMore: boolean }>(`/tag-automod/events?${qs}`, {
    method: 'GET', guildId, errorContext: 'API Error (Tag Events):', silent: true,
  });
}

export async function scanTagMembers(draft: TagRuleDraft | null, guildId = authStore.selectedGuildId) {
  return dashboardRequest<TagScanResult>('/tag-automod/scan', { method: 'POST', payload: draft ? { draft } : {}, guildId, errorContext: 'API Error (Tag Scan):' });
}

export async function rescanTagMembers(guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ started: boolean; count: number }>('/tag-automod/rescan', { method: 'POST', payload: {}, guildId, errorContext: 'API Error (Tag Rescan):' });
}

/** Emojis, stickers et serveurs d'origine interdits, une sanction par élément. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

export type EmojiBanKind = 'EMOJI' | 'UNICODE' | 'STICKER' | 'SOURCE_GUILD';
export type EmojiBanAction = 'DELETE' | 'WARN' | 'TIMEOUT' | 'KICK' | 'SOFTBAN' | 'BAN' | 'JAIL';

export interface EmojiBanRule {
  id: string;
  kind: EmojiBanKind;
  key: string;
  name: string | null;
  iconUrl: string | null;
  action: EmojiBanAction;
  durationMin: number | null;
  createdBy: string | null;
  createdAt: string;
}

export interface EmojiBanDraft {
  kind: EmojiBanKind;
  key: string;
  name?: string | null;
  iconUrl?: string | null;
  action: EmojiBanAction;
  durationMin?: number | null;
}

export interface EmojiBanServer {
  guildId: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
  kotboPresent: boolean;
}

export interface EmojiBanSourceAssets {
  kotboPresent: boolean;
  emojis: { id: string; name: string; animated: boolean; url: string }[];
  stickers: { id: string; name: string; url: string }[];
}

export async function fetchEmojiBans(guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ rules: EmojiBanRule[]; maxRules: number; jailConfigured: boolean }>('/emoji-bans', {
    method: 'GET', guildId, errorContext: 'API Error (Emoji Bans):',
  });
}

export async function saveEmojiBan(payload: EmojiBanDraft, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ rule: EmojiBanRule }>('/emoji-bans', { method: 'POST', payload, guildId, errorContext: 'API Error (Emoji Ban):' });
}

export async function deleteEmojiBan(id: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/emoji-bans/${encodeURIComponent(id)}`, { method: 'DELETE', guildId, errorContext: 'API Error (Emoji Ban):' });
}

export async function searchEmojiBanServers(q: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ servers: EmojiBanServer[] }>(`/emoji-bans/search?q=${encodeURIComponent(q)}`, {
    method: 'GET', guildId, errorContext: 'API Error (Emoji Ban Search):', silent: true,
  });
}

export async function fetchEmojiBanSource(sourceId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<EmojiBanSourceAssets>(`/emoji-bans/sources/${encodeURIComponent(sourceId)}`, {
    method: 'GET', guildId, errorContext: 'API Error (Emoji Ban Source):', silent: true,
  });
}

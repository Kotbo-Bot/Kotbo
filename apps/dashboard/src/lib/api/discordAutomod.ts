/** Journal de l'AutoMod natif de Discord. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export interface DiscordAutomodEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  triggerType: number;
  action: 'BLOCK' | 'ALERT' | 'TIMEOUT';
  channelId: string | null;
  keyword: string | null;
  content: string | null;
  managed: boolean;
  createdAt: string;
  user: { userId: string; name: string; avatar: string | null };
}

export interface DiscordAutomodReport {
  days: number;
  total: number;
  events: DiscordAutomodEvent[];
  byRule: Array<{ ruleId: string; ruleName: string; managed: boolean; count: number }>;
  topUsers: Array<{ userId: string; name: string; avatar: string | null; count: number }>;
}

export function fetchDiscordAutomodEvents(
  params: { days?: number; userId?: string; ruleId?: string; limit?: number; offset?: number } = {},
  guildId = authStore.selectedGuildId,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  return dashboardRequest<DiscordAutomodReport>(`/automod/discord-events?${query}`, {
    guildId,
    errorContext: 'API Error (AutoMod Discord):',
  });
}

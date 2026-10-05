/** Simulation d'une règle d'automodération sur l'historique des messages. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type SimulatedRule =
  | { kind: 'spam'; limit: number; intervalSeconds: number }
  | { kind: 'links'; whitelist: string[] }
  | { kind: 'caps'; thresholdPercent: number; minLength: number }
  | { kind: 'emojis'; limit: number }
  | { kind: 'mentions'; limit: number }
  | { kind: 'everyone' }
  | { kind: 'keywords'; keywords: string[]; allowList: string[] }
  | { kind: 'regex'; pattern: string }
  | { kind: 'scam'; whitelist: string[]; customDomains: string[] };

export type SimulatedRuleKind = SimulatedRule['kind'];

export interface SimulationSample {
  messageId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  createdAt: string;
  deleted: boolean;
  detail: string;
  highlights: Array<[number, number]>;
  falsePositiveHint: string | null;
}

export interface SimulationResult {
  matched: number;
  authors: number;
  share: number;
  byDay: Array<{ date: string; count: number }>;
  topChannels: Array<{ channelId: string; name: string; count: number }>;
  topAuthors: Array<{ userId: string; name: string; avatar: string | null; count: number; isStaff: boolean }>;
  samples: SimulationSample[];
  falsePositiveHints: number;
}

export interface SimulationReport {
  window: { days: number; from: string; to: string; firstMessageAt: string | null };
  timezone: string;
  scanned: number;
  exempted: number;
  truncated: boolean;
  approximate: boolean;
  draft: SimulationResult;
  baseline: SimulationResult | null;
  diff: { added: number; removed: number; addedSamples: SimulationSample[]; removedSamples: SimulationSample[] } | null;
  durationMs: number;
}

export function simulateAutomodRule(
  input: { rule: SimulatedRule; baseline?: SimulatedRule | null; days: number },
  guildId = authStore.selectedGuildId,
) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return dashboardRequest<SimulationReport>('/automod/simulate', {
    method: 'POST',
    payload: { ...input, tz },
    guildId,
    errorContext: 'API Error (AutoMod simulation):',
  });
}

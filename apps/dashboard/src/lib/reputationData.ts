/**
 * Contrôle des réponses de l'API Réputation avant que la page ne s'en serve.
 *
 * Le dashboard et le bot ne sont pas toujours déployés en même temps : un bot
 * plus ancien renvoie une autre forme (sans `config`), et la page plantait en
 * lisant `config.tiers`. Une réponse sans réglages est refusée, la page affiche
 * alors son état d'erreur ; un champ ajouté plus tard prend sa valeur par défaut.
 */
import { REPUTATION_DAILY_LIMIT } from '@kotbo/shared';
import type { ReputationConfig, ReputationData } from './api/reputation';

export const DEFAULT_REPUTATION_CONFIG: ReputationConfig = {
  dailyLimit: REPUTATION_DAILY_LIMIT.default,
  reactionEnabled: false,
  reactionEmoji: null,
  xpPerRep: 0,
  coinsPerRep: 0,
  announceChannelId: null,
  minAccountAgeDays: 0,
  minMemberDays: 0,
  sameMemberCooldownDays: 1,
  excludedRoleIds: [],
  excludedChannelIds: [],
  tiers: [],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export function toReputationConfig(raw: unknown): ReputationConfig | null {
  if (!isObject(raw)) return null;
  return {
    ...DEFAULT_REPUTATION_CONFIG,
    ...(raw as Partial<ReputationConfig>),
    tiers: Array.isArray(raw.tiers) ? (raw.tiers as ReputationConfig['tiers']) : [],
    excludedRoleIds: Array.isArray(raw.excludedRoleIds) ? (raw.excludedRoleIds as string[]) : [],
    excludedChannelIds: Array.isArray(raw.excludedChannelIds) ? (raw.excludedChannelIds as string[]) : [],
  };
}

export function toReputationData(raw: unknown): ReputationData | null {
  if (!isObject(raw) || !isObject(raw.stats) || !isObject(raw.leaderboard)) return null;
  const config = toReputationConfig(raw.config);
  if (!config) return null;
  return {
    config,
    leaderboard: raw.leaderboard as ReputationData['leaderboard'],
    stats: raw.stats as ReputationData['stats'],
    announcement: isObject(raw.announcement) ? (raw.announcement as ReputationData['announcement']) : null,
    unmanageableTierRoleIds: Array.isArray(raw.unmanageableTierRoleIds) ? (raw.unmanageableTierRoleIds as string[]) : [],
  };
}

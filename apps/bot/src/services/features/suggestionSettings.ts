/**
 * Réglages du module Suggestions.
 *
 * Le salon vit dans la configuration de fonctionnalité, que `/suggestion-config`
 * écrit aussi ; le reste dans `suggestion_configs`. Pas de cache : deux
 * lectures par clé primaire, et la commande Discord n'aurait pas su l'invalider.
 */
import prisma from '../../utils/db.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { getOrCreateFeatureConfigs, updateFeatureConfig } from '../core/dashboardManagementService.js';

export interface SuggestionSettings {
  /** Salon de publication. `null` = repli sur un salon nommé « suggestions ». */
  channelId: string | null;
  requireComment: boolean;
  voteWhileApproved: boolean;
  /** Rôles autorisés à proposer. Vide = tout le monde. */
  allowedRoleIds: string[];
  /** Garde-fous de qui propose. `0` = aucune exigence. */
  cooldownMinutes: number;
  minAccountAgeDays: number;
  minMemberDays: number;
  /** Prévenir l'auteur en message privé quand le staff tranche. */
  notifyAuthor: boolean;
  /** Ouvrir un fil de discussion sous chaque nouvelle suggestion. */
  createThread: boolean;
  /** Votes « pour » qui signalent la suggestion. `null` = pas de seuil. */
  voteThreshold: number | null;
  pinAtThreshold: boolean;
  /** Récompense de l'auteur d'une suggestion acceptée. `0` = rien. */
  rewardXp: number;
  rewardCoins: number;
  /** Catégories proposées à qui suggère. Vide = pas de catégorie. */
  categories: string[];
  /** Le staff voit qui a voté sur le dashboard. */
  showVoters: boolean;
}

export const DEFAULT_SUGGESTION_SETTINGS: SuggestionSettings = {
  channelId: null,
  requireComment: true,
  voteWhileApproved: false,
  allowedRoleIds: [],
  cooldownMinutes: 0,
  minAccountAgeDays: 0,
  minMemberDays: 0,
  notifyAuthor: true,
  createThread: false,
  voteThreshold: null,
  pinAtThreshold: false,
  rewardXp: 0,
  rewardCoins: 0,
  categories: [],
  showVoters: false,
};

/** Motif temps réel : la page Suggestions se recharge dès qu'une suggestion ou un réglage bouge. */
export const SUGGESTIONS_REALTIME_REASON = 'suggestions_updated';

export async function getSuggestionSettings(guildId: string): Promise<SuggestionSettings> {
  const [feature, row] = await Promise.all([
    prisma.dashboardFeatureConfig.findFirst({ where: { guildId, featureKey: 'suggestions' }, select: { channelId: true } }),
    prisma.suggestionConfig.findUnique({ where: { guildId } }),
  ]);
  if (!row) return { ...DEFAULT_SUGGESTION_SETTINGS, allowedRoleIds: [], categories: [], channelId: feature?.channelId ?? null };
  return {
    channelId: feature?.channelId ?? null,
    requireComment: row.requireComment,
    voteWhileApproved: row.voteWhileApproved,
    allowedRoleIds: row.allowedRoleIds,
    cooldownMinutes: row.cooldownMinutes,
    minAccountAgeDays: row.minAccountAgeDays,
    minMemberDays: row.minMemberDays,
    notifyAuthor: row.notifyAuthor,
    createThread: row.createThread,
    voteThreshold: row.voteThreshold,
    pinAtThreshold: row.pinAtThreshold,
    rewardXp: row.rewardXp,
    rewardCoins: row.rewardCoins,
    categories: row.categories,
    showVoters: row.showVoters,
  };
}

/** Écrit les réglages validés par l'appelant et rend ceux en place. */
export async function saveSuggestionSettings(guildId: string, patch: Partial<SuggestionSettings>): Promise<SuggestionSettings> {
  const { channelId, ...columns } = patch;
  if (channelId !== undefined) {
    await getOrCreateFeatureConfigs(guildId);
    await updateFeatureConfig(guildId, 'suggestions', { channelId });
  }
  if (Object.keys(columns).length > 0) {
    const { channelId: _ignored, ...defaults } = DEFAULT_SUGGESTION_SETTINGS;
    await prisma.suggestionConfig.upsert({
      where: { guildId },
      create: { guildId, ...defaults, ...columns },
      update: columns,
    });
  }
  broadcastDashboardStateChange(guildId, SUGGESTIONS_REALTIME_REASON);
  return getSuggestionSettings(guildId);
}

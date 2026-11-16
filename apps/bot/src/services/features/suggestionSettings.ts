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
}

export const DEFAULT_SUGGESTION_SETTINGS: SuggestionSettings = {
  channelId: null,
  requireComment: true,
  voteWhileApproved: false,
  allowedRoleIds: [],
};

/** Motif temps réel : la page Suggestions se recharge dès qu'une suggestion ou un réglage bouge. */
export const SUGGESTIONS_REALTIME_REASON = 'suggestions_updated';

export async function getSuggestionSettings(guildId: string): Promise<SuggestionSettings> {
  const [feature, row] = await Promise.all([
    prisma.dashboardFeatureConfig.findFirst({ where: { guildId, featureKey: 'suggestions' }, select: { channelId: true } }),
    prisma.suggestionConfig.findUnique({ where: { guildId } }),
  ]);
  return {
    channelId: feature?.channelId ?? null,
    requireComment: row?.requireComment ?? DEFAULT_SUGGESTION_SETTINGS.requireComment,
    voteWhileApproved: row?.voteWhileApproved ?? DEFAULT_SUGGESTION_SETTINGS.voteWhileApproved,
    allowedRoleIds: row?.allowedRoleIds ?? [],
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

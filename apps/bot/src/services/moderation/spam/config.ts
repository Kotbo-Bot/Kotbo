/**
 * spam/config.ts - Configuration du moteur anti-spam, avec cache court.
 */

import type { SpamDetectionConfig } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import type { SpamThresholds, SpamTuning } from './types.js';

const CACHE_TTL_SECONDS = 60;

function cacheKey(guildId: string): string {
  return `guild:${guildId}:spamdetection`;
}

export async function getSpamConfig(guildId: string): Promise<SpamDetectionConfig | null> {
  const key = cacheKey(guildId);
  let config = await cache.get<SpamDetectionConfig>(key);
  if (!config) {
    config = await prisma.spamDetectionConfig.findUnique({ where: { guildId } });
    if (config) await cache.set(key, config, CACHE_TTL_SECONDS);
  }
  return config;
}

export async function upsertSpamConfig(
  guildId: string,
  data: Partial<Omit<SpamDetectionConfig, 'guildId' | 'createdAt' | 'updatedAt'>>
): Promise<SpamDetectionConfig> {
  const config = await prisma.spamDetectionConfig.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });
  await cache.delete(cacheKey(guildId));
  return config;
}

export function tuningFromConfig(config: SpamDetectionConfig): SpamTuning {
  return {
    windowSeconds: config.windowSeconds,
    crossChannelThreshold: config.crossChannelThreshold,
    duplicateSimilarity: config.duplicateSimilarity,
    typingSignalEnabled: config.typingSignalEnabled,
    pasteSignalEnabled: config.pasteSignalEnabled,
    crossChannelEnabled: config.crossChannelEnabled,
    duplicateEnabled: config.duplicateEnabled,
    cadenceEnabled: config.cadenceEnabled,
    contentEnabled: config.contentEnabled,
    trustEnabled: config.trustEnabled,
  };
}

export function thresholdsFromConfig(config: SpamDetectionConfig): SpamThresholds {
  return {
    logThreshold: config.logThreshold,
    deleteThreshold: config.deleteThreshold,
    timeoutThreshold: config.timeoutThreshold,
    banThreshold: config.banThreshold,
  };
}

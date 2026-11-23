import type { AegisDetection } from '@prisma/client';
import { kotboEventBus, type AegisAlertEvent } from '@kotbo/core';

const CATEGORIES = ['TOXIC', 'HARASSMENT', 'CONFLICT', 'DISTRESS'] as const;

type DetectionFields = Pick<AegisDetection, 'id' | 'guildId' | 'authorId' | 'channelId' | 'kind' | 'toxicity' | 'emotionScore' | 'status'>;

/** Une détresse se mesure à l'émotion, le reste à la toxicité. */
export function aegisAlertOf(detection: DetectionFields): AegisAlertEvent | null {
  const category = CATEGORIES.find((kind) => kind === detection.kind);
  if (!category) return null;
  const raw = category === 'DISTRESS' ? detection.emotionScore : detection.toxicity;
  return {
    guildId: detection.guildId,
    detectionId: detection.id,
    userId: detection.authorId,
    channelId: detection.channelId,
    category,
    score: raw === null ? null : Math.round(raw * 100),
    status: detection.status,
    timestamp: Date.now(),
  };
}

export function publishAegisAlert(detection: DetectionFields): void {
  const event = aegisAlertOf(detection);
  if (event) kotboEventBus.publish('aegis:alert', event);
}

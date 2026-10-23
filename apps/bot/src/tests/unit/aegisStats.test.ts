import { describe, expect, mock, test } from 'bun:test';

mock.module('../../utils/db.js', () => ({ default: {}, prisma: {}, prismaRead: {} }));

const { countersFor } = await import('../../services/moderation/aegis/aegisStats');

const thresholds = { reviewThreshold: 80, autoThreshold: 95 };

describe('countersFor', () => {
  test('message calme', () => {
    expect(countersFor({ ...thresholds, toxicity: 0.03, emotion: 'joy' }))
      .toEqual({ analyzed: 1, toxicityMilli: 30, emotionAnalyzed: 1, joy: 1 });
  });

  test('zone grise et action automatique', () => {
    expect(countersFor({ ...thresholds, toxicity: 0.85 })).toEqual({ analyzed: 1, toxicityMilli: 850, toxic: 1 });
    expect(countersFor({ ...thresholds, toxicity: 0.97 })).toEqual({ analyzed: 1, toxicityMilli: 970, toxic: 1, severe: 1 });
  });

  test('émotion seule (membre exempté de modération)', () => {
    expect(countersFor({ ...thresholds, emotion: 'anger' })).toEqual({ emotionAnalyzed: 1, anger: 1 });
  });
});

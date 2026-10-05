import { describe, expect, mock, test } from 'bun:test';

mock.module('../../utils/db.js', () => ({ default: {}, prisma: {}, prismaRead: {} }));

const { dominantEmotion, summarize } = await import('../../services/moderation/aegis/aegisInsights');

const none = { joy: 0, sad: 0, anger: 0, fear: 0, surprise: 0, neutral: 0 };

describe('dominantEmotion', () => {
  test('ignore le neutre tant qu’une autre émotion existe', () => {
    expect(dominantEmotion({ ...none, neutral: 90, anger: 4, joy: 6 })).toBe('joy');
  });

  test('neutre seul, ou rien', () => {
    expect(dominantEmotion({ ...none, neutral: 3 })).toBe('neutral');
    expect(dominantEmotion(none)).toBeNull();
  });
});

describe('summarize', () => {
  test('taux et moyenne en points', () => {
    const s = summarize({ ...none, analyzed: 200, toxic: 5, severe: 1, toxicityMilli: 20_000, emotionAnalyzed: 200, joy: 30, neutral: 170 });
    expect(s.toxicRate).toBe(2.5);
    expect(s.avgToxicity).toBe(10);
    expect(s.dominant).toBe('joy');
  });

  test('rien analysé : pas de taux', () => {
    const s = summarize({ ...none, analyzed: 0, toxic: 0, severe: 0, toxicityMilli: 0, emotionAnalyzed: 0 });
    expect(s.toxicRate).toBeNull();
    expect(s.avgToxicity).toBeNull();
  });
});

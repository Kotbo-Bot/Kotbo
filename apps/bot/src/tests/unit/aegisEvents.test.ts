import { describe, expect, test } from 'bun:test';
import { aegisAlertOf } from '../../services/moderation/aegis/aegisEvents';

const detection = {
  id: 'd1',
  guildId: 'g1',
  authorId: 'u1',
  channelId: 'c1',
  kind: 'TOXIC',
  toxicity: 0.874,
  emotionScore: 0.2,
  status: 'AUTO',
};

describe('aegisAlertOf', () => {
  test('un propos toxique porte sa toxicité en pourcentage', () => {
    expect(aegisAlertOf(detection)).toMatchObject({ category: 'TOXIC', score: 87, status: 'AUTO', userId: 'u1', detectionId: 'd1' });
  });

  test('une détresse porte le score de l’émotion', () => {
    expect(aegisAlertOf({ ...detection, kind: 'DISTRESS' })?.score).toBe(20);
  });

  test('harcèlement et conflit n’ont pas de score', () => {
    expect(aegisAlertOf({ ...detection, kind: 'HARASSMENT', toxicity: null })?.score).toBeNull();
    expect(aegisAlertOf({ ...detection, kind: 'CONFLICT', toxicity: null })?.score).toBeNull();
  });

  test('une catégorie inconnue n’est pas publiée', () => {
    expect(aegisAlertOf({ ...detection, kind: 'AUTRE' })).toBeNull();
  });
});

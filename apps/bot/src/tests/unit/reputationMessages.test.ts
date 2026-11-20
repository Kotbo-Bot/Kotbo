import { describe, expect, test } from 'bun:test';
import { repRefusalMessage, type RepRefusalLimits } from '../../services/community/reputationMessages.js';
import type { RepRefusalCode } from '../../services/community/reputationService.js';

const CODES: RepRefusalCode[] = [
  'SELF',
  'BOT',
  'DAILY_LIMIT',
  'ALREADY_TODAY',
  'COOLDOWN',
  'CHANNEL_EXCLUDED',
  'GIVER_EXCLUDED',
  'RECEIVER_EXCLUDED',
  'ACCOUNT_TOO_NEW',
  'MEMBER_TOO_NEW',
];

const LIMITS: RepRefusalLimits = { dailyLimit: 3, sameMemberCooldownDays: 4, minAccountAgeDays: 7, minMemberDays: 2 };

describe('repRefusalMessage', () => {
  test('chaque motif a un texte dans les deux langues', () => {
    for (const code of CODES) {
      const fr = repRefusalMessage(code, 'fr', LIMITS);
      const en = repRefusalMessage(code, 'en', LIMITS);
      expect(fr.length).toBeGreaterThan(0);
      expect(en.length).toBeGreaterThan(0);
      expect(fr).not.toBe(en);
    }
  });

  test('deux motifs différents ne donnent pas le même texte', () => {
    const texts = new Set(CODES.map((code) => repRefusalMessage(code, 'fr', LIMITS)));
    expect(texts.size).toBe(CODES.length);
  });

  test('les seuils affichés sont ceux du serveur', () => {
    expect(repRefusalMessage('DAILY_LIMIT', 'fr', { ...LIMITS, dailyLimit: 5 })).toContain('5');
    expect(repRefusalMessage('COOLDOWN', 'fr', LIMITS)).toContain('4');
    expect(repRefusalMessage('ACCOUNT_TOO_NEW', 'fr', LIMITS)).toContain('7');
    expect(repRefusalMessage('MEMBER_TOO_NEW', 'fr', LIMITS)).toContain('2');
  });
});

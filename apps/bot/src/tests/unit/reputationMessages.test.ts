import { describe, expect, test } from 'bun:test';
import { repRefusalMessage } from '../../services/community/reputationMessages.js';
import type { RepRefusalCode } from '../../services/community/reputationService.js';

const CODES: RepRefusalCode[] = ['SELF', 'BOT', 'DAILY_LIMIT', 'ALREADY_TODAY'];

describe('repRefusalMessage', () => {
  test('chaque motif a un texte dans les deux langues', () => {
    for (const code of CODES) {
      const fr = repRefusalMessage(code, 'fr', 3);
      const en = repRefusalMessage(code, 'en', 3);
      expect(fr.length).toBeGreaterThan(0);
      expect(en.length).toBeGreaterThan(0);
      expect(fr).not.toBe(en);
    }
  });

  test('deux motifs différents ne donnent pas le même texte', () => {
    const texts = new Set(CODES.map((code) => repRefusalMessage(code, 'fr', 3)));
    expect(texts.size).toBe(CODES.length);
  });

  test('la limite affichée est celle passée en paramètre', () => {
    expect(repRefusalMessage('DAILY_LIMIT', 'fr', 5)).toContain('5');
  });
});

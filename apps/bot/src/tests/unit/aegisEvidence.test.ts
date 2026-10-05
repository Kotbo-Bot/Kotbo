import { describe, expect, test } from 'bun:test';
import { evidenceLinks, reasonWithExcerpt } from '../../services/moderation/aegis/aegisEvidence';

describe('evidenceLinks', () => {
  test('sans doublon ni vide, dans l’ordre', () => {
    expect(evidenceLinks('https://a', null, 'https://b', undefined, 'https://a')).toEqual(['https://a', 'https://b']);
    expect(evidenceLinks(null)).toEqual([]);
  });
});

describe('reasonWithExcerpt', () => {
  test('ajoute l’extrait en cause au motif', () => {
    expect(reasonWithExcerpt('[AegisAI] Propos toxiques (97 %)', "t'es vraiment\nun gros connard"))
      .toBe("[AegisAI] Propos toxiques (97 %) : « t'es vraiment un gros connard »");
  });

  test('tronque un long extrait et laisse le motif seul sans extrait', () => {
    const reason = reasonWithExcerpt('motif', 'x'.repeat(300));
    expect(reason.length).toBeLessThan(220);
    expect(reason.endsWith('… »')).toBe(true);
    expect(reasonWithExcerpt('motif', null)).toBe('motif');
  });
});

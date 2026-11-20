import { describe, expect, test } from 'bun:test';
import { regexProblem, testSafeRegex } from '../../utils/safeRegex.js';

describe('safeRegex', () => {
  test('refuse les motifs à retour arrière catastrophique', () => {
    for (const bad of ['(a+)+$', '(a*)*b', '(a|aa)+$', '(.*a){5,}', '(a+)\\1']) {
      expect(regexProblem(bad)).not.toBeNull();
    }
  });

  test('accepte les motifs ordinaires', () => {
    for (const ok of ['^bonjour\\b', 'bon(jour|soir)', '\\d{3}-\\d{4}', '[a-z]+@[a-z]+\\.fr']) {
      expect(regexProblem(ok)).toBeNull();
    }
  });

  test('un motif refusé ne correspond jamais et rend la main tout de suite', () => {
    const start = Date.now();
    expect(testSafeRegex('(a+)+$', `${'a'.repeat(40)}!`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });

  test('un motif valide correspond, sur une entrée tronquée', () => {
    expect(testSafeRegex('^salut', 'Salut tout le monde')).toBe(true);
    expect(testSafeRegex('fin$', `${'x'.repeat(5000)}fin`)).toBe(false);
  });
});

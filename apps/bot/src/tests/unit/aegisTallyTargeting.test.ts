import { describe, expect, test } from 'bun:test';
import { tallyTargeting } from '../../services/moderation/aegis/aegisSignals.js';

describe('tallyTargeting', () => {
  test('additionne les messages de tous les auteurs', () => {
    const { triggered, authors } = tallyTargeting(['a', 'b', 'a', 'c', 'a'], 5);
    expect(triggered).toBe(true);
    expect(authors).toEqual([
      { id: 'a', count: 3 },
      { id: 'b', count: 1 },
      { id: 'c', count: 1 },
    ]);
  });

  test('sous le seuil, rien', () => {
    expect(tallyTargeting(['a', 'b'], 3).triggered).toBe(false);
  });

  test('un seul auteur insistant suffit aussi', () => {
    const { triggered, authors } = tallyTargeting(['a', 'a', 'a'], 3);
    expect(triggered).toBe(true);
    expect(authors).toEqual([{ id: 'a', count: 3 }]);
  });
});

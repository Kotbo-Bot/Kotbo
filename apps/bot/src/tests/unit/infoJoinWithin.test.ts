import { describe, expect, test } from 'bun:test';
import { joinWithin } from '../../commands/utility/info.js';

const more = (n: number) => `+${n}`;

describe('joinWithin', () => {
  test('garde toute la liste quand elle tient', () => {
    expect(joinWithin(['a', 'b', 'c'], ', ', 100, more)).toBe('a, b, c');
  });

  test('coupe et compte le reste sans dépasser la limite', () => {
    const items = Array.from({ length: 50 }, (_, i) => `role${i}`);
    const out = joinWithin(items, ', ', 40, more);
    expect(out.length).toBeLessThanOrEqual(40);
    const shown = out.split(', ').filter((part) => part.startsWith('role')).length;
    expect(out.endsWith(`+${50 - shown}`)).toBe(true);
  });

  test('premier élément trop long : seulement le compteur', () => {
    expect(joinWithin(['x'.repeat(50)], ', ', 10, more)).toBe('+1');
  });
});

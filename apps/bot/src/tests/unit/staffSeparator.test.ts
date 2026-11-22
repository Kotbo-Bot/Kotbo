import { describe, expect, test } from 'bun:test';
import { STAFF_SEPARATOR_STYLE_KEYS, isStaffSeparatorStyle, staffSeparatorName } from '@kotbo/shared';

describe('séparateurs de hiérarchie staff', () => {
  test('chaque style produit un nom Discord valide (≤ 100 caractères)', () => {
    for (const key of STAFF_SEPARATOR_STYLE_KEYS) {
      const name = staffSeparatorName(key, 'x'.repeat(200));
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(100);
    }
  });

  test('le nom est en majuscules, sauf pour le style sans titre', () => {
    expect(staffSeparatorName('line', ' Modération ')).toBe('──── MODÉRATION ────');
    expect(staffSeparatorName('rule', 'Modération')).not.toContain('MOD');
  });

  test('refuse un style inconnu ou hérité du prototype', () => {
    expect(isStaffSeparatorStyle('stars')).toBe(true);
    expect(isStaffSeparatorStyle('toString')).toBe(false);
    expect(isStaffSeparatorStyle(null)).toBe(false);
  });
});

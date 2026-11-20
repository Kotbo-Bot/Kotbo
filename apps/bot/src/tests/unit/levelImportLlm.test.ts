/**
 * Tri de ce que rend l'IA avant de le montrer à l'admin : seules passent les
 * lignes qu'un import pourrait vraiment rattacher à un membre.
 */
import { describe, expect, test } from 'bun:test';
import { cleanRows } from '../../services/progression/levelImportLlm.js';

const row = (overrides: Partial<Parameters<typeof cleanRows>[0][number]>) => ({
  user_id: null,
  username: null,
  display_name: null,
  level: null,
  xp: null,
  ...overrides,
});

describe('cleanRows', () => {
  test('garde une ligne nommée avec un niveau, sans le @', () => {
    expect(cleanRows([row({ username: '@klaynight', level: 48 })])).toEqual([{ username: 'klaynight', level: 48 }]);
  });

  test('un identifiant mal formé est retiré, la ligne survit grâce au pseudo', () => {
    expect(cleanRows([row({ user_id: '12345', display_name: 'Klay', xp: 1200 })])).toEqual([{ display_name: 'Klay', xp: 1200 }]);
  });

  test('identifiant seul + XP suffit', () => {
    expect(cleanRows([row({ user_id: '441302111817433088', xp: 900 })])).toEqual([{ user_id: '441302111817433088', xp: 900 }]);
  });

  test('écarte les lignes sans membre ou sans valeur, et les valeurs absurdes', () => {
    expect(cleanRows([
      row({ level: 10 }),
      row({ username: 'x' }),
      row({ username: 'y', level: -3, xp: -1 }),
      row({ username: 'z', level: 99999 }),
    ])).toEqual([]);
  });
});

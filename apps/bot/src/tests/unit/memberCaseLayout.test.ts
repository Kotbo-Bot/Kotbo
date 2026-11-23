import { describe, expect, test } from 'bun:test';
import { pickLayoutRule, sanitizeLayoutRule } from '../../services/staff/memberCaseLayout.js';

// Concaténation : un entier de cette taille perdrait en précision.
const role = (n: number) => `10000000000000000${n}`;

describe('pickLayoutRule', () => {
  const rules = [{ roleIds: [role(1)], name: 'a' }, { roleIds: [role(1), role(2)], name: 'b' }];

  test('prend la première règle qui correspond, dans l\'ordre', () => {
    expect(pickLayoutRule(rules, new Set([role(1), role(2)]))?.name).toBe('a');
    expect(pickLayoutRule(rules, new Set([role(2)]))?.name).toBe('b');
  });

  test('renvoie null sans rôle en commun', () => {
    expect(pickLayoutRule(rules, new Set([role(9)]))).toBeNull();
  });
});

describe('sanitizeLayoutRule', () => {
  test('écarte les onglets inconnus et les doublons', () => {
    const rule = sanitizeLayoutRule({ tabOrder: ['notes', 'notes', 'bidon', 'logs'], roleIds: [role(1), 'abc'], hiddenTabs: [] });
    expect(rule.tabOrder).toEqual(['notes', 'logs']);
    expect(rule.roleIds).toEqual([role(1)]);
  });

  test('ne masque jamais l\'onglet d\'entrée', () => {
    expect(sanitizeLayoutRule({ hiddenTabs: ['resume', 'logs'] }).hiddenTabs).toEqual(['logs']);
  });

  test('tolère des entrées invalides', () => {
    expect(sanitizeLayoutRule({ tabOrder: 'x', hiddenTabs: null })).toEqual({ roleIds: [], tabOrder: [], hiddenTabs: [] });
  });
});

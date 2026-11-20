import { describe, test, expect } from 'bun:test';
import { fillDropTemplate } from './dropPreview';

describe('gabarits de l\'annonce d\'un drop', () => {
  test('chaque trou est rempli, autant de fois qu\'il apparaît', () => {
    expect(fillDropTemplate('**{amount}** **{resource}**, {amount} encore', { amount: '150', resource: 'XP' }))
      .toBe('**150** **XP**, 150 encore');
  });

  test('un trou sans valeur reste tel quel', () => {
    expect(fillDropTemplate('{amount} {inconnu}', { amount: '3' })).toBe('3 {inconnu}');
  });
});

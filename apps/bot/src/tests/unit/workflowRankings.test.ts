import { describe, expect, test } from 'bun:test';
import { formatPodium, monthStartKey } from '../../services/features/workflow/rankings';

describe('classements des automatisations', () => {
  test('podium de trois lignes avec médailles et mentions', () => {
    const text = formatPodium([{ userId: '1', value: 1204 }, { userId: '2', value: 9 }, { userId: '3', value: 3 }, { userId: '4', value: 1 }], 'messages');
    expect(text.split('\n')).toHaveLength(3);
    expect(text.startsWith('🥇 <@1>')).toBe(true);
  });

  test('personne de classé : texte vide', () => {
    expect(formatPodium([{ userId: '1', value: 0 }], 'XP')).toBe('');
  });

  test('début du mois en UTC', () => {
    expect(monthStartKey(new Date('2026-11-23T10:00:00Z'))).toBe('2026-11-01');
  });
});

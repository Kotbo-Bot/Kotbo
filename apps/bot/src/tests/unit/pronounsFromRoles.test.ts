import { describe, expect, test } from 'bun:test';
import { pronounsFromRoles } from '../../api/shared/pronouns.js';

describe('pronounsFromRoles', () => {
  test('reconnaît les rôles de pronoms et ignore le reste', () => {
    const roles = ['Modérateur', 'il/lui', 'they / them', 'IT', 'Elle', 'iel', 'Hélène'].map((name) => ({ name }));
    expect(pronounsFromRoles(roles)).toBe('il/lui, they / them, Elle, iel');
  });
  test('null sans rôle de pronom', () => {
    expect(pronounsFromRoles([{ name: 'Membre' }])).toBeNull();
  });
});

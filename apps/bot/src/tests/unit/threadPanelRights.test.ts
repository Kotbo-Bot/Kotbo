/**
 * Droits sur un fil de panneau de discussion. Le bot agit en son nom : une
 * erreur ici laisse un simple membre bannir, transférer ou réclamer le fil
 * d'un autre.
 */
import { describe, expect, test } from 'bun:test';
import { canRunThreadAction } from '../../services/features/threadPanelService.js';

const member = { isOwner: false, isTrusted: false, isModerator: false };

describe('droits sur un fil', () => {
  test('un membre quelconque ne peut que réclamer', () => {
    expect(canRunThreadAction(member, 'rename')).toBe(false);
    expect(canRunThreadAction(member, 'ban')).toBe(false);
    expect(canRunThreadAction(member, 'claim')).toBe(true);
  });

  test('la confiance ouvre tout sauf ce qui dit qui gère le fil', () => {
    const trusted = { ...member, isTrusted: true };
    expect(canRunThreadAction(trusted, 'ban')).toBe(true);
    expect(canRunThreadAction(trusted, 'close')).toBe(true);
    expect(canRunThreadAction(trusted, 'transfer')).toBe(false);
    expect(canRunThreadAction(trusted, 'trust')).toBe(false);
  });

  test('le propriétaire fait tout sauf réclamer son propre fil', () => {
    const owner = { ...member, isOwner: true };
    expect(canRunThreadAction(owner, 'transfer')).toBe(true);
    expect(canRunThreadAction(owner, 'claim')).toBe(false);
  });

  test('un modérateur fait tout', () => {
    const moderator = { ...member, isModerator: true };
    expect(canRunThreadAction(moderator, 'transfer')).toBe(true);
    expect(canRunThreadAction(moderator, 'untrust')).toBe(true);
  });
});

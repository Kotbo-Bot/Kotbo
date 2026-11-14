import { describe, expect, test } from 'bun:test';
import {
  hasMemberGuards,
  repCooldownBlocks,
  repGuardRefusal,
  type RepGuardSettings,
} from '../../services/community/reputationGuards.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-14T12:00:00Z');

const NO_GUARDS: RepGuardSettings = {
  minAccountAgeDays: 0,
  minMemberDays: 0,
  excludedRoleIds: [],
  excludedChannelIds: [],
};

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

const VETERAN = { accountCreatedAt: daysAgo(400), joinedAt: daysAgo(200), roleIds: ['membre'] };

describe('repGuardRefusal', () => {
  test('sans garde-fou, tout vote passe', () => {
    const fresh = { accountCreatedAt: daysAgo(0), joinedAt: daysAgo(0), roleIds: [] };
    expect(repGuardRefusal({ giver: fresh, receiverRoleIds: [], channelId: 'c' }, NO_GUARDS, NOW)).toBeNull();
  });

  test('un salon exclu refuse le vote', () => {
    const settings = { ...NO_GUARDS, excludedChannelIds: ['c'] };
    expect(repGuardRefusal({ giver: VETERAN, receiverRoleIds: [], channelId: 'c' }, settings, NOW)).toBe('CHANNEL_EXCLUDED');
    expect(repGuardRefusal({ giver: VETERAN, receiverRoleIds: [], channelId: 'autre' }, settings, NOW)).toBeNull();
  });

  test('un vote sans salon (menu sur un membre) ignore les salons exclus', () => {
    const settings = { ...NO_GUARDS, excludedChannelIds: ['c'] };
    expect(repGuardRefusal({ giver: VETERAN, receiverRoleIds: [] }, settings, NOW)).toBeNull();
  });

  test('un rôle exclu empêche de remercier comme d\'être remercié', () => {
    const settings = { ...NO_GUARDS, excludedRoleIds: ['muet'] };
    const giver = { ...VETERAN, roleIds: ['membre', 'muet'] };
    expect(repGuardRefusal({ giver, receiverRoleIds: [] }, settings, NOW)).toBe('GIVER_EXCLUDED');
    expect(repGuardRefusal({ giver: VETERAN, receiverRoleIds: ['muet'] }, settings, NOW)).toBe('RECEIVER_EXCLUDED');
  });

  test('un compte trop récent ne peut pas remercier', () => {
    const settings = { ...NO_GUARDS, minAccountAgeDays: 7 };
    const giver = { ...VETERAN, accountCreatedAt: daysAgo(6) };
    expect(repGuardRefusal({ giver, receiverRoleIds: [] }, settings, NOW)).toBe('ACCOUNT_TOO_NEW');
    expect(repGuardRefusal({ giver: { ...VETERAN, accountCreatedAt: daysAgo(7) }, receiverRoleIds: [] }, settings, NOW)).toBeNull();
  });

  test('un membre arrivé trop récemment ne peut pas remercier', () => {
    const settings = { ...NO_GUARDS, minMemberDays: 3 };
    expect(repGuardRefusal({ giver: { ...VETERAN, joinedAt: daysAgo(2) }, receiverRoleIds: [] }, settings, NOW)).toBe('MEMBER_TOO_NEW');
    expect(repGuardRefusal({ giver: { ...VETERAN, joinedAt: daysAgo(3) }, receiverRoleIds: [] }, settings, NOW)).toBeNull();
  });

  test('une date d\'arrivée inconnue ne bloque pas', () => {
    const settings = { ...NO_GUARDS, minMemberDays: 3 };
    expect(repGuardRefusal({ giver: { ...VETERAN, joinedAt: null }, receiverRoleIds: [] }, settings, NOW)).toBeNull();
  });
});

describe('hasMemberGuards', () => {
  test('vrai dès qu\'un garde-fou lit le profil des membres', () => {
    expect(hasMemberGuards(NO_GUARDS)).toBe(false);
    expect(hasMemberGuards({ ...NO_GUARDS, excludedChannelIds: ['c'] })).toBe(false);
    expect(hasMemberGuards({ ...NO_GUARDS, excludedRoleIds: ['r'] })).toBe(true);
    expect(hasMemberGuards({ ...NO_GUARDS, minAccountAgeDays: 1 })).toBe(true);
    expect(hasMemberGuards({ ...NO_GUARDS, minMemberDays: 1 })).toBe(true);
  });
});

describe('repCooldownBlocks', () => {
  test('un jour d\'attente : le lendemain est libre, la contrainte du jour suffit', () => {
    expect(repCooldownBlocks('2026-11-13', '2026-11-14', 1)).toBe(false);
  });

  test('trois jours d\'attente : bloqué jusqu\'au troisième jour', () => {
    expect(repCooldownBlocks('2026-11-12', '2026-11-14', 3)).toBe(true);
    expect(repCooldownBlocks('2026-11-11', '2026-11-14', 3)).toBe(false);
  });

  test('le passage d\'un mois est compté en jours', () => {
    expect(repCooldownBlocks('2026-10-31', '2026-11-01', 2)).toBe(true);
    expect(repCooldownBlocks('2026-10-30', '2026-11-01', 2)).toBe(false);
  });
});

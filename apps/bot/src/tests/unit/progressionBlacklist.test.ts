import { describe, expect, test } from 'bun:test';
import { isBlacklisted } from '../../services/progression/progressionBlacklist.js';

const list = {
  progressionBlacklistUserIds: ['u-banni'],
  progressionBlacklistRoleIds: ['r-banni'],
  progressionBlacklistChannelIds: ['c-spam', 'cat-bots'],
};
const actor = (over: Partial<{ userId: string; roleIds: string[]; channelIds: Array<string | null> }> = {}) => ({
  userId: 'u1', roleIds: ['r1'], channelIds: ['c-general', 'cat-chat'], ...over,
});

describe('blacklist de progression', () => {
  test('membre, rôle ou salon listé : bloqué', () => {
    expect(isBlacklisted(list, actor({ userId: 'u-banni' }))).toBe(true);
    expect(isBlacklisted(list, actor({ roleIds: ['r1', 'r-banni'] }))).toBe(true);
    expect(isBlacklisted(list, actor({ channelIds: ['c-spam', null] }))).toBe(true);
  });

  test('une catégorie listée couvre ses salons et leurs fils', () => {
    expect(isBlacklisted(list, actor({ channelIds: ['fil-1', 'c-commandes', 'cat-bots'] }))).toBe(true);
  });

  test('rien de listé, ou pas de configuration : libre', () => {
    expect(isBlacklisted(list, actor())).toBe(false);
    expect(isBlacklisted(null, actor({ userId: 'u-banni' }))).toBe(false);
  });
});

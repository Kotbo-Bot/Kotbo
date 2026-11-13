import { describe, test, expect } from 'bun:test';
import { DEFAULT_REPUTATION_CONFIG, toReputationConfig, toReputationData } from './reputationData';

const STATS = { totalVotes: 4, votesLast7Days: 1, activeGivers7Days: 1, lastVoteAt: null };
const LEADERBOARD = { entries: [], totalVoters: 0 };

describe('toReputationData', () => {
  test('une réponse de l\'ancienne API, sans réglages, est refusée au lieu de faire planter la page', () => {
    expect(toReputationData({ leaderboard: LEADERBOARD, recentVotes: [], totalVotes: 4 })).toBeNull();
  });

  test('rien ou autre chose qu\'un objet est refusé', () => {
    expect(toReputationData(null)).toBeNull();
    expect(toReputationData('erreur')).toBeNull();
  });

  test('les réglages absents d\'un bot un peu plus ancien prennent leurs valeurs par défaut', () => {
    const data = toReputationData({ config: { dailyLimit: 5 }, leaderboard: LEADERBOARD, stats: STATS });
    expect(data?.config).toEqual({ ...DEFAULT_REPUTATION_CONFIG, dailyLimit: 5, tiers: [] });
    expect(data?.announcement).toBeNull();
    expect(data?.unmanageableTierRoleIds).toEqual([]);
  });

  test('une réponse complète passe telle quelle', () => {
    const config = { ...DEFAULT_REPUTATION_CONFIG, tiers: [{ threshold: 10, roleId: '1' }] };
    const announcement = { locale: 'fr', title: 'T', body: 'B' };
    const data = toReputationData({ config, leaderboard: LEADERBOARD, stats: STATS, announcement, unmanageableTierRoleIds: ['1'] });
    expect(data).toEqual({ config, leaderboard: LEADERBOARD, stats: STATS, announcement, unmanageableTierRoleIds: ['1'] });
  });
});

describe('toReputationConfig', () => {
  test('des paliers qui ne sont pas une liste deviennent une liste vide', () => {
    expect(toReputationConfig({ tiers: 'x' })?.tiers).toEqual([]);
  });

  test('autre chose qu\'un objet est refusé', () => {
    expect(toReputationConfig(undefined)).toBeNull();
  });
});

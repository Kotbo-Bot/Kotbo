/**
 * Points d'entrée des votes de réputation : ce qui suit un vote accepté ou retiré.
 *
 * Préfixe `zzz-` : ce fichier remplace `reputationService`,
 * `reputationTierService`, `reputationRewards` et `questService` pour tout le
 * process (`mock.module` est global). Il doit charger après leurs propres tests.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const mockDb = {};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const NO_GUARDS = { minAccountAgeDays: 0, minMemberDays: 0, sameMemberCooldownDays: 1, excludedRoleIds: [] as string[], excludedChannelIds: [] as string[] };
const SETTINGS = { dailyLimit: 3, xpPerRep: 20, coinsPerRep: 0, reactionEnabled: false, reactionEmoji: null, announceChannelId: null, tiers: [], ...NO_GUARDS };
let settings: typeof SETTINGS = SETTINGS;

let giveResult: { success: true; newTotal: number; voteId: string } | { success: false; code: string } = { success: true, newTotal: 10, voteId: 'v1' };
let deleted: Record<string, unknown> | null = null;
let adjustResult: Record<string, unknown> = { success: true, before: 4, after: 9 };

const service = {
  giveRep: mock(async (..._args: unknown[]) => giveResult),
  deleteReputationVote: mock(async (..._args: unknown[]) => deleted),
  receivedTotal: mock(async (..._args: unknown[]) => 4),
  getReputationConfig: mock(async (..._args: unknown[]) => settings),
  recordVoteGains: mock(async (..._args: unknown[]) => {}),
  adjustReputation: mock(async (..._args: unknown[]) => adjustResult),
  resetMemberReputation: mock(async (..._args: unknown[]) => 3),
  resetGuildReputation: mock(async (..._args: unknown[]) => ({ count: 5, receiverIds: ['b', 'c'] })),
};
const servicePath = path.resolve(__dirname, '../../services/community/reputationService.ts');
for (const suffix of ['../../services/community/reputationService.ts', '../../services/community/reputationService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(servicePath, service));
}

const tiers = {
  applyReputationGain: mock(async (..._args: unknown[]) => {}),
  applyReputationLoss: mock(async (..._args: unknown[]) => {}),
};
const tiersPath = path.resolve(__dirname, '../../services/community/reputationTierService.ts');
for (const suffix of ['../../services/community/reputationTierService.ts', '../../services/community/reputationTierService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(tiersPath, tiers));
}

const rewards = {
  grantRepRewards: mock(async (..._args: unknown[]) => ({ xp: 20, coins: 0 })),
  reclaimRepRewards: mock(async (..._args: unknown[]) => {}),
};
const rewardsPath = path.resolve(__dirname, '../../services/community/reputationRewards.ts');
for (const suffix of ['../../services/community/reputationRewards.ts', '../../services/community/reputationRewards.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(rewardsPath, rewards));
}

const quests = { incrementQuestProgress: mock(async (..._args: unknown[]) => {}) };
const questsPath = path.resolve(__dirname, '../../services/community/questService.ts');
for (const suffix of ['../../services/community/questService.ts', '../../services/community/questService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(questsPath, quests));
}

const { recordRep, revokeRep, adjustRep, resetMemberRep, resetGuildRep } = await import('../../services/community/reputationActions.js');

const client = {} as Client;
const DAY_MS = 86_400_000;

/** Client dont le serveur connaît ces membres (rôles, dates). */
function clientWithMembers(members: Record<string, { roles?: string[]; accountDays?: number; joinedDays?: number }>): Client {
  const fetch = async (userId: string) => {
    const member = members[userId];
    if (!member) throw new Error('Unknown Member');
    return {
      id: userId,
      joinedAt: new Date(Date.now() - (member.joinedDays ?? 365) * DAY_MS),
      user: { createdAt: new Date(Date.now() - (member.accountDays ?? 365) * DAY_MS) },
      roles: { cache: new Map((member.roles ?? []).map((roleId) => [roleId, {}])) },
    };
  };
  return { guilds: { cache: new Map([['g', { members: { fetch } }]]) } } as unknown as Client;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  giveResult = { success: true, newTotal: 10, voteId: 'v1' };
  deleted = null;
  settings = SETTINGS;
  adjustResult = { success: true, before: 4, after: 9 };
  for (const fn of [...Object.values(service), ...Object.values(tiers), ...Object.values(rewards), quests.incrementQuestProgress]) fn.mockClear();
});

describe('recordRep', () => {
  test('un vote accepté applique les paliers du receveur, de l\'ancien au nouveau total', async () => {
    const result = await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b', reason: 'merci' });
    await flush();
    expect(result).toEqual({ success: true, newTotal: 10, voteId: 'v1' });
    expect(service.giveRep.mock.calls[0]).toEqual(['g', 'a', 'b', 'merci', { receiverIsBot: undefined, channelId: undefined, messageId: undefined }]);
    expect(tiers.applyReputationGain.mock.calls[0]).toEqual([client, 'g', 'b', 9, 10]);
  });

  test('un vote refusé ne déclenche aucune suite', async () => {
    giveResult = { success: false, code: 'SELF' };
    await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'a' });
    await flush();
    expect(tiers.applyReputationGain).not.toHaveBeenCalled();
    expect(rewards.grantRepRewards).not.toHaveBeenCalled();
    expect(quests.incrementQuestProgress).not.toHaveBeenCalled();
  });

  test('verse les gains au receveur avec les réglages du serveur', async () => {
    await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b', channelId: 'c' });
    await flush();
    expect(rewards.grantRepRewards.mock.calls[0]).toEqual([client, 'g', 'b', SETTINGS, 'c']);
  });

  test('garde sur le vote les gains réellement versés', async () => {
    await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b' });
    await flush();
    expect(service.recordVoteGains.mock.calls[0]).toEqual(['v1', { xp: 20, coins: 0 }]);
  });

  test('fait avancer la quête « remercier » de celui qui donne', async () => {
    await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b', channelId: 'c' });
    await flush();
    expect(quests.incrementQuestProgress.mock.calls[0]).toEqual([client, 'g', 'a', 'GIVE_REP', 1, 'c']);
  });

  test('un échec des gains n\'empêche ni les paliers ni la quête', async () => {
    rewards.grantRepRewards.mockImplementationOnce(async () => { throw new Error('economy'); });
    await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b' });
    await flush();
    expect(tiers.applyReputationGain).toHaveBeenCalledTimes(1);
    expect(quests.incrementQuestProgress).toHaveBeenCalledTimes(1);
  });

  test('un échec des paliers ne fait pas échouer le vote', async () => {
    tiers.applyReputationGain.mockImplementationOnce(async () => { throw new Error('Discord'); });
    const result = await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b' });
    await flush();
    expect(result.success).toBe(true);
  });
});

describe('recordRep, garde-fous', () => {
  test('sans garde-fou de membre, les membres ne sont pas récupérés', async () => {
    const result = await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b' });
    expect(result.success).toBe(true);
  });

  test('un salon exclu refuse le vote sans l\'écrire', async () => {
    settings = { ...SETTINGS, excludedChannelIds: ['c'] };
    const result = await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b', channelId: 'c' });
    expect(result).toEqual({ success: false, code: 'CHANNEL_EXCLUDED' });
    expect(service.giveRep).not.toHaveBeenCalled();
  });

  test('un compte trop récent est refusé', async () => {
    settings = { ...SETTINGS, minAccountAgeDays: 7 };
    const result = await recordRep(clientWithMembers({ a: { accountDays: 2 }, b: {} }), { guildId: 'g', giverId: 'a', receiverId: 'b' });
    expect(result).toEqual({ success: false, code: 'ACCOUNT_TOO_NEW' });
    expect(service.giveRep).not.toHaveBeenCalled();
  });

  test('un receveur au rôle exclu est refusé', async () => {
    settings = { ...SETTINGS, excludedRoleIds: ['muet'] };
    const result = await recordRep(clientWithMembers({ a: {}, b: { roles: ['muet'] } }), { guildId: 'g', giverId: 'a', receiverId: 'b' });
    expect(result).toEqual({ success: false, code: 'RECEIVER_EXCLUDED' });
  });

  test('un membre parti du serveur ne bloque pas le vote', async () => {
    settings = { ...SETTINGS, excludedRoleIds: ['muet'] };
    const result = await recordRep(clientWithMembers({ a: {} }), { guildId: 'g', giverId: 'a', receiverId: 'b' });
    expect(result.success).toBe(true);
  });

  test('un vote pour soi-même garde son propre motif, avant les garde-fous', async () => {
    settings = { ...SETTINGS, excludedChannelIds: ['c'] };
    giveResult = { success: false, code: 'SELF' };
    const result = await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'a', channelId: 'c' });
    expect(result).toEqual({ success: false, code: 'SELF' });
  });
});

describe('revokeRep', () => {
  test('retire le vote puis les paliers que le receveur ne remplit plus', async () => {
    deleted = { id: 'v1', guildId: 'g', kind: 'VOTE', giverId: 'a', receiverId: 'b', xpGranted: 0, coinsGranted: 0 };
    expect(await revokeRep(client, 'g', 'v1')).toEqual(deleted);
    expect(service.receivedTotal.mock.calls[0]).toEqual(['g', 'b', mockDb]);
    expect(tiers.applyReputationLoss.mock.calls[0]).toEqual([client, 'g', 'b', 4]);
  });

  test('reprend au receveur les gains versés pour ce vote', async () => {
    deleted = { id: 'v1', guildId: 'g', kind: 'VOTE', giverId: 'a', receiverId: 'b', xpGranted: 20, coinsGranted: 50 };
    await revokeRep(client, 'g', 'v1');
    expect(rewards.reclaimRepRewards.mock.calls[0]).toEqual([client, 'g', 'b', { xp: 20, coins: 50 }]);
  });

  test('annuler un retrait du staff fait remonter le total : les paliers sont rendus', async () => {
    deleted = { id: 'v2', guildId: 'g', kind: 'ADJUSTMENT', value: -3, giverId: 's', receiverId: 'b', xpGranted: 0, coinsGranted: 0 };
    await revokeRep(client, 'g', 'v2');
    expect(tiers.applyReputationGain.mock.calls[0]).toEqual([client, 'g', 'b', 1, 4]);
    expect(tiers.applyReputationLoss).not.toHaveBeenCalled();
  });

  test('un échec de la reprise ne fait pas échouer le retrait', async () => {
    deleted = { id: 'v1', guildId: 'g', kind: 'VOTE', giverId: 'a', receiverId: 'b', xpGranted: 20, coinsGranted: 0 };
    rewards.reclaimRepRewards.mockImplementationOnce(async () => { throw new Error('leveling'); });
    expect(await revokeRep(client, 'g', 'v1')).toEqual(deleted);
    expect(tiers.applyReputationLoss).toHaveBeenCalledTimes(1);
  });

  test('vote introuvable : rien d\'autre', async () => {
    expect(await revokeRep(client, 'g', 'absent')).toBeNull();
    expect(tiers.applyReputationLoss).not.toHaveBeenCalled();
  });
});

describe('adjustRep', () => {
  test('un ajout applique les paliers du membre, de l\'ancien au nouveau total', async () => {
    const result = await adjustRep(client, { guildId: 'g', staffId: 's', userId: 'b', amount: 5, reason: 'aide' });
    expect(result).toEqual(adjustResult);
    expect(service.adjustReputation.mock.calls[0]).toEqual(['g', 's', 'b', 5, 'aide']);
    expect(tiers.applyReputationGain.mock.calls[0]).toEqual([client, 'g', 'b', 4, 9]);
    expect(rewards.grantRepRewards).not.toHaveBeenCalled();
  });

  test('un retrait retire les paliers que le membre ne remplit plus', async () => {
    adjustResult = { success: true, before: 9, after: 4 };
    await adjustRep(client, { guildId: 'g', staffId: 's', userId: 'b', amount: -5, reason: null });
    expect(tiers.applyReputationLoss.mock.calls[0]).toEqual([client, 'g', 'b', 4]);
    expect(tiers.applyReputationGain).not.toHaveBeenCalled();
  });

  test('un retrait refusé ne touche pas aux paliers', async () => {
    adjustResult = { success: false, code: 'BELOW_ZERO', total: 2 };
    expect(await adjustRep(client, { guildId: 'g', staffId: 's', userId: 'b', amount: -5, reason: null })).toEqual(adjustResult);
    expect(tiers.applyReputationLoss).not.toHaveBeenCalled();
  });
});

describe('remises à zéro', () => {
  test('un membre : ses paliers repartent', async () => {
    expect(await resetMemberRep(client, 'g', 'b')).toBe(3);
    expect(tiers.applyReputationLoss.mock.calls[0]).toEqual([client, 'g', 'b', 0]);
  });

  test('le serveur : les paliers de chaque membre qui avait des points repartent', async () => {
    expect(await resetGuildRep(client, 'g')).toEqual({ count: 5, members: 2 });
    await flush();
    expect(tiers.applyReputationLoss.mock.calls.map((call) => call[2])).toEqual(['b', 'c']);
  });
});

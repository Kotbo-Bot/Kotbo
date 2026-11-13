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

const SETTINGS = { dailyLimit: 3, xpPerRep: 20, coinsPerRep: 0, reactionEnabled: false, reactionEmoji: null, announceChannelId: null, tiers: [] };

let giveResult: { success: true; newTotal: number } | { success: false; code: string } = { success: true, newTotal: 10 };
let deleted: Record<string, unknown> | null = null;

const service = {
  giveRep: mock(async (..._args: unknown[]) => giveResult),
  deleteReputationVote: mock(async (..._args: unknown[]) => deleted),
  receivedTotal: mock(async (..._args: unknown[]) => 4),
  getReputationConfig: mock(async (..._args: unknown[]) => SETTINGS),
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

const rewards = { grantRepRewards: mock(async (..._args: unknown[]) => {}) };
const rewardsPath = path.resolve(__dirname, '../../services/community/reputationRewards.ts');
for (const suffix of ['../../services/community/reputationRewards.ts', '../../services/community/reputationRewards.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(rewardsPath, rewards));
}

const quests = { incrementQuestProgress: mock(async (..._args: unknown[]) => {}) };
const questsPath = path.resolve(__dirname, '../../services/community/questService.ts');
for (const suffix of ['../../services/community/questService.ts', '../../services/community/questService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(questsPath, quests));
}

const { recordRep, revokeRep } = await import('../../services/community/reputationActions.js');

const client = {} as Client;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  giveResult = { success: true, newTotal: 10 };
  deleted = null;
  for (const fn of [...Object.values(service), ...Object.values(tiers), rewards.grantRepRewards, quests.incrementQuestProgress]) fn.mockClear();
});

describe('recordRep', () => {
  test('un vote accepté applique les paliers du receveur, de l\'ancien au nouveau total', async () => {
    const result = await recordRep(client, { guildId: 'g', giverId: 'a', receiverId: 'b', reason: 'merci' });
    await flush();
    expect(result).toEqual({ success: true, newTotal: 10 });
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

describe('revokeRep', () => {
  test('retire le vote puis les paliers que le receveur ne remplit plus', async () => {
    deleted = { id: 'v1', guildId: 'g', giverId: 'a', receiverId: 'b' };
    expect(await revokeRep(client, 'g', 'v1')).toEqual(deleted);
    expect(service.receivedTotal.mock.calls[0]).toEqual(['g', 'b', mockDb]);
    expect(tiers.applyReputationLoss.mock.calls[0]).toEqual([client, 'g', 'b', 4]);
  });

  test('vote introuvable : rien d\'autre', async () => {
    expect(await revokeRep(client, 'g', 'absent')).toBeNull();
    expect(tiers.applyReputationLoss).not.toHaveBeenCalled();
  });
});

/**
 * Suites d'un passage à la une pour l'auteur : gains, paliers, message privé,
 * événement des workflows ; et leur reprise au retrait par le staff.
 *
 * Préfixe `zzz-` : ce fichier remplace `memberRewards` et
 * `reputationTierService` pour tout le process (`mock.module` est global).
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD = '999999999999999999';
const AUTHOR = '111111111111111111';
const ROLE = '555555555555555555';

let featuredCount = 3;
const mockDb = {
  starboardEntry: {
    update: mock(async (args: { data: Record<string, unknown> }) => ({ ...ENTRY, ...args.data })),
    count: mock(async (_args?: unknown) => featuredCount),
  },
  guild: { findUnique: mock(async () => null) },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

function mockModule(relative: string, implementation: Record<string, unknown>) {
  const source = path.resolve(__dirname, `${relative}.ts`);
  for (const suffix of ['.ts', '.js']) {
    mock.module(path.resolve(__dirname, `${relative}${suffix}`), () => completeModuleMock(source, implementation));
  }
}

let granted = { xp: 50, coins: 0 };
const rewards = {
  grantMemberGains: mock(async (..._args: unknown[]) => granted),
  reclaimMemberGains: mock(async (..._args: unknown[]) => undefined),
};
mockModule('../../services/progression/memberRewards', rewards);

const tierService = {
  grantReachedTiers: mock(async (..._args: unknown[]) => []),
  revokeLostTiers: mock(async (..._args: unknown[]) => undefined),
};
mockModule('../../services/community/reputationTierService', tierService);

const ENTRY = {
  id: 'clentry00000000000000001',
  guildId: GUILD,
  channelId: '333333333333333333',
  messageId: '444444444444444444',
  authorId: AUTHOR,
  starMessageId: '666666666666666666' as string | null,
  starChannelId: '777777777777777777' as string | null,
  upvotes: 9,
  downvotes: 1,
  score: 8,
  peakScore: 8,
  excerpt: null,
  imageUrl: null,
  postedAt: new Date(),
  blockedAt: null as Date | null,
  blockedById: null as string | null,
  rewardedAt: null as Date | null,
  xpGranted: 0,
  coinsGranted: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const CONFIG = {
  guildId: GUILD,
  rewardXp: 50,
  rewardCoins: 0,
  tiers: [{ threshold: 3, roleId: ROLE }],
  notifyAuthor: false,
};

const sent: unknown[] = [];
const member = { id: AUTHOR, guild: { id: GUILD, name: 'Kotbo', preferredLocale: 'fr' }, send: mock(async (payload: unknown) => { sent.push(payload); }) };
const client = {
  guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'Kotbo', preferredLocale: 'fr', members: { fetch: async () => member } }]]) },
} as unknown as Client;

const { onEntryFeatured, onEntryBlocked } = await import('../../services/features/starboardFeatureEffects.js');

const published: Array<Record<string, unknown>> = [];
kotboEventBus.subscribe('starboard:featured', (payload) => { published.push(payload as unknown as Record<string, unknown>); });

beforeEach(() => {
  featuredCount = 3;
  granted = { xp: 50, coins: 0 };
  sent.length = 0;
  published.length = 0;
  for (const fn of [...Object.values(rewards), ...Object.values(tierService), mockDb.starboardEntry.update, mockDb.starboardEntry.count, member.send]) {
    (fn as { mockClear: () => void }).mockClear();
  }
});

describe('onEntryFeatured', () => {
  test('premier passage : gains versés et gardés, paliers, événement', async () => {
    await onEntryFeatured(client, CONFIG as never, ENTRY as never);
    expect(rewards.grantMemberGains.mock.calls[0]?.[3]).toEqual({ xp: 50, coins: 0 });
    const data = mockDb.starboardEntry.update.mock.calls[0]?.[0].data;
    expect(data?.rewardedAt).toBeInstanceOf(Date);
    expect(data?.xpGranted).toBe(50);
    expect(data?.coinsGranted).toBe(0);
    expect(tierService.grantReachedTiers.mock.calls[0]?.[2]).toBe(3);
    await Promise.resolve();
    expect(published[0]).toMatchObject({ guildId: GUILD, authorId: AUTHOR, entryId: ENTRY.id, featuredCount: 3, score: 8 });
  });

  test('déjà payé : rien ne repart', async () => {
    await onEntryFeatured(client, CONFIG as never, { ...ENTRY, rewardedAt: new Date() } as never);
    expect(rewards.grantMemberGains).not.toHaveBeenCalled();
    expect(mockDb.starboardEntry.update).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  test('sans palier réglé : aucun rôle cherché', async () => {
    await onEntryFeatured(client, { ...CONFIG, tiers: [] } as never, ENTRY as never);
    expect(tierService.grantReachedTiers).not.toHaveBeenCalled();
  });

  test('message privé seulement si le serveur le demande', async () => {
    await onEntryFeatured(client, CONFIG as never, ENTRY as never);
    expect(member.send).not.toHaveBeenCalled();
    await onEntryFeatured(client, { ...CONFIG, notifyAuthor: true } as never, ENTRY as never);
    expect(member.send).toHaveBeenCalledTimes(1);
  });
});

describe('onEntryBlocked', () => {
  test('reprend les gains versés et retire les paliers perdus', async () => {
    featuredCount = 2;
    await onEntryBlocked(client, CONFIG as never, { ...ENTRY, rewardedAt: new Date(), xpGranted: 50, coinsGranted: 10 } as never);
    expect(rewards.reclaimMemberGains.mock.calls[0]?.[3]).toEqual({ xp: 50, coins: 10 });
    expect(mockDb.starboardEntry.update.mock.calls[0]?.[0].data).toEqual({ rewardedAt: null, xpGranted: 0, coinsGranted: 0 });
    expect(tierService.revokeLostTiers.mock.calls[0]?.[2]).toBe(2);
  });

  test('jamais payé : rien à reprendre, paliers tout de même recalculés', async () => {
    await onEntryBlocked(client, CONFIG as never, ENTRY as never);
    expect(rewards.reclaimMemberGains).not.toHaveBeenCalled();
    expect(tierService.revokeLostTiers).toHaveBeenCalled();
  });
});

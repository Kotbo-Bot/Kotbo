import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Collection } from 'discord.js';
import path from 'node:path';

type ProfileRow = { userId: string; guildLeftAt: Date | null };
type UpdateManyArgs = {
  where: { guildId: string; userId: { in: string[] }; guildLeftAt: unknown };
  data: { guildLeftAt: Date | null };
};

let profiles: ProfileRow[] = [];

const mockDb = {
  memberProfile: {
    findMany: mock(async (args: { where: { guildLeftAt: unknown } }) => {
      const wantsLeft = args.where.guildLeftAt !== null;
      return profiles
        .filter((profile) => (profile.guildLeftAt !== null) === wantsLeft)
        .map((profile) => ({ userId: profile.userId }));
    }),
    updateMany: mock(async (args: UpdateManyArgs) => {
      let count = 0;
      for (const profile of profiles) {
        if (!args.where.userId.in.includes(profile.userId)) continue;
        profile.guildLeftAt = args.data.guildLeftAt;
        count++;
      }
      return { count };
    }),
  },
};

for (const suffix of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
    upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert(),
  }));
}

for (const suffix of ['../../utils/logger.ts', '../../utils/logger.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} },
  }));
}

const { reconcileGuildMemberPresence } = await import('../../services/analytics/memberPresenceService');

/** Serveur dont `onServer` sont les membres réels, `cached` ceux déjà en cache. */
function fakeGuild(options: { onServer: string[]; cached: string[]; memberCount?: number; fetchFails?: boolean }) {
  const cache = new Collection<string, { id: string }>(options.cached.map((id) => [id, { id }]));
  const fetch = mock(async ({ user }: { user: string[] }) => {
    if (options.fetchFails) throw new Error('timeout');
    return new Collection(user.filter((id) => options.onServer.includes(id)).map((id) => [id, { id }]));
  });
  return {
    id: 'guild-1',
    memberCount: options.memberCount ?? options.onServer.length,
    members: { cache, fetch },
  };
}

type FakeGuild = ReturnType<typeof fakeGuild>;
const reconcile = (guild: FakeGuild) => reconcileGuildMemberPresence(guild as never);

const LEFT_AT = new Date('2026-09-01T00:00:00.000Z');

beforeEach(() => {
  mockDb.memberProfile.updateMany.mockClear();
});

describe('reconcileGuildMemberPresence', () => {
  test('efface la date de départ des membres revenus, même absents du cache', async () => {
    profiles = [
      { userId: 'revenu', guildLeftAt: LEFT_AT },
      { userId: 'parti', guildLeftAt: LEFT_AT },
    ];
    const guild = fakeGuild({ onServer: ['revenu', 'autre'], cached: [], memberCount: 2 });

    const outcome = await reconcile(guild);

    expect(outcome.returned).toBe(1);
    expect(profiles.find((p) => p.userId === 'revenu')?.guildLeftAt).toBeNull();
    expect(profiles.find((p) => p.userId === 'parti')?.guildLeftAt).toEqual(LEFT_AT);
  });

  test("n'interroge Discord que pour les membres absents du cache", async () => {
    profiles = [
      { userId: 'en-cache', guildLeftAt: LEFT_AT },
      { userId: 'hors-cache', guildLeftAt: LEFT_AT },
    ];
    const guild = fakeGuild({ onServer: ['en-cache', 'hors-cache'], cached: ['en-cache'], memberCount: 2 });

    await reconcile(guild);

    expect(guild.members.fetch).toHaveBeenCalledTimes(1);
    expect(guild.members.fetch.mock.calls[0][0].user).toEqual(['hors-cache']);
  });

  test('ne conclut rien si une recherche Discord échoue', async () => {
    profiles = [{ userId: 'revenu', guildLeftAt: LEFT_AT }];
    const guild = fakeGuild({ onServer: ['revenu', 'x'], cached: [], memberCount: 2, fetchFails: true });

    const outcome = await reconcile(guild);

    expect(outcome.returned).toBe(0);
    expect(profiles[0].guildLeftAt).toEqual(LEFT_AT);
  });

  test('marque parti un membre absent quand le cache est complet', async () => {
    profiles = [
      { userId: 'present', guildLeftAt: null },
      { userId: 'disparu', guildLeftAt: null },
    ];
    const guild = fakeGuild({ onServer: ['present'], cached: ['present'] });

    const outcome = await reconcile(guild);

    expect(outcome.departed).toBe(1);
    expect(profiles.find((p) => p.userId === 'disparu')?.guildLeftAt).toBeInstanceOf(Date);
    expect(profiles.find((p) => p.userId === 'present')?.guildLeftAt).toBeNull();
  });

  test("ne déduit aucun départ d'un cache partiel", async () => {
    profiles = [{ userId: 'pas-en-cache', guildLeftAt: null }];
    const guild = fakeGuild({ onServer: ['present', 'pas-en-cache'], cached: ['present'] });

    const outcome = await reconcile(guild);

    expect(outcome.departed).toBe(0);
    expect(profiles[0].guildLeftAt).toBeNull();
  });
});

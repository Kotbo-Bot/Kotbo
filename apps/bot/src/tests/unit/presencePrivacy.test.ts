import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Refus individuel du suivi de présence (`/opt-out presence`).
 *
 * Deux comportements comptent ici : le refus doit être respecté dès qu'il est
 * enregistré, et une base illisible ne doit jamais se traduire par une reprise
 * silencieuse du suivi.
 */

type ProfileRow = { presenceTrackingOptOut: boolean; presenceOptOutAt?: Date | null } | null;

let profileRow: ProfileRow = null;
let findUniqueFails = false;
let findManyFails = false;
let optedOutIds: string[] = [];

const findUnique = mock((_args?: unknown) => {
  if (findUniqueFails) return Promise.reject(new Error('base indisponible'));
  return Promise.resolve(profileRow);
});
const findMany = mock((_args?: unknown) => {
  if (findManyFails) return Promise.reject(new Error('base indisponible'));
  return Promise.resolve(optedOutIds.map((userId) => ({ userId })));
});
const upsert = mock((_args?: unknown) => Promise.resolve({ id: 'row' }));

const mockDb = {
  memberProfile: { findUnique, findMany, upsert },
  guild: { upsert: mock((_args?: unknown) => Promise.resolve({ id: 'guild-privacy' })) },
};

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
    upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert(),
  }));
}

const {
  hasOptedOutOfPresenceTracking,
  findPresenceOptOuts,
  visiblePresenceStatus,
  setPresenceTrackingOptOut,
} = await import('../../services/core/presencePrivacyService.js');
const { cache } = await import('../../utils/cache.js');

const GUILD = 'guild-privacy';

beforeEach(async () => {
  profileRow = null;
  findUniqueFails = false;
  findManyFails = false;
  optedOutIds = [];
  findUnique.mockClear();
  findMany.mockClear();
  upsert.mockClear();
  // Le service met le choix en cache : sans purge, un test hériterait de la
  // décision du précédent.
  await cache.invalidateGuild(GUILD);
});

describe('hasOptedOutOfPresenceTracking', () => {
  test('suit le suivi par défaut sans profil enregistré', async () => {
    expect(await hasOptedOutOfPresenceTracking(GUILD, 'user-1')).toBe(false);
  });

  test('respecte un refus enregistré', async () => {
    profileRow = { presenceTrackingOptOut: true };
    expect(await hasOptedOutOfPresenceTracking(GUILD, 'user-2')).toBe(true);
  });

  test('refuse le suivi quand la lecture échoue', async () => {
    findUniqueFails = true;
    expect(await hasOptedOutOfPresenceTracking(GUILD, 'user-3')).toBe(true);
  });

  test('ne relit pas la base pour un même membre', async () => {
    profileRow = { presenceTrackingOptOut: true };

    await hasOptedOutOfPresenceTracking(GUILD, 'user-4');
    await hasOptedOutOfPresenceTracking(GUILD, 'user-4');

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  test('ignore les identifiants absents', async () => {
    expect(await hasOptedOutOfPresenceTracking(null, 'user-5')).toBe(false);
    expect(await hasOptedOutOfPresenceTracking(GUILD, null)).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('findPresenceOptOuts', () => {
  test('ne remonte que les membres retirés', async () => {
    optedOutIds = ['user-b'];

    const optOuts = await findPresenceOptOuts(GUILD, ['user-a', 'user-b']);

    expect(optOuts.has('user-b')).toBe(true);
    expect(optOuts.has('user-a')).toBe(false);
  });

  test('n\'interroge pas la base sans membre à tester', async () => {
    expect((await findPresenceOptOuts(GUILD, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  test('retire tout le monde quand la lecture échoue', async () => {
    findManyFails = true;

    const optOuts = await findPresenceOptOuts(GUILD, ['user-a', 'user-b']);

    expect(optOuts.size).toBe(2);
  });
});

describe('visiblePresenceStatus', () => {
  test('laisse passer le statut d\'un membre qui n\'a rien coupé', async () => {
    expect(await visiblePresenceStatus(GUILD, 'user-6', 'online')).toBe('online');
  });

  test('masque le statut d\'un membre retiré', async () => {
    profileRow = { presenceTrackingOptOut: true };
    expect(await visiblePresenceStatus(GUILD, 'user-7', 'dnd')).toBeNull();
  });

  test('ne consulte pas le réglage sans statut à masquer', async () => {
    expect(await visiblePresenceStatus(GUILD, 'user-8', null)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('setPresenceTrackingOptOut', () => {
  test('horodate le retrait et purge le cache', async () => {
    profileRow = { presenceTrackingOptOut: false };
    expect(await hasOptedOutOfPresenceTracking(GUILD, 'user-9')).toBe(false);

    const state = await setPresenceTrackingOptOut(GUILD, 'user-9', true);
    expect(state.optedOut).toBe(true);
    expect(state.since).toBeInstanceOf(Date);

    // La décision suivante doit repartir de la base, pas du cache d'avant.
    profileRow = { presenceTrackingOptOut: true };
    expect(await hasOptedOutOfPresenceTracking(GUILD, 'user-9')).toBe(true);
  });

  test('efface la date au retour en arrière', async () => {
    const state = await setPresenceTrackingOptOut(GUILD, 'user-10', false);

    expect(state.optedOut).toBe(false);
    expect(state.since).toBeNull();
  });
});

import { describe, expect, test, mock, afterEach } from 'bun:test';
import path from 'node:path';
import type { Guild } from 'discord.js';

/**
 * Tirage d'un concours. C'est le seul endroit où se décide qui gagne, et ses
 * deux erreurs sont invisibles depuis le résultat : servir un membre parti du
 * serveur, ou ignorer les chances supplémentaires que l'annonce a promises.
 */

const mockDb = {
  giveawayConfig: { findUnique: mock(() => Promise.resolve(null)) },
  guild: { findUnique: mock(() => Promise.resolve(null)) },
  clan: { findMany: mock(() => Promise.resolve([])) },
};

const mockCache = {
  cache: {
    get: mock(() => Promise.resolve(null)),
    set: mock(() => Promise.resolve()),
  },
  getCachedGuild: mock(() => Promise.resolve(null)),
  getCachedDashboardSettings: mock(() => Promise.resolve(null)),
};

const resolve = (file: string) => path.resolve(import.meta.dir, `../../${file}`);
for (const ext of ['ts', 'js']) {
  mock.module(resolve(`utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
  mock.module(resolve(`utils/cache.${ext}`), () => mockCache);
}

const { drawWinnersWeighted } = await import('../../services/features/giveawayService');

/**
 * Serveur Discord réduit à ce que le tirage lui demande : la récupération des
 * membres, et les rôles qu'elle rapporte. `null` fait échouer la récupération,
 * comme Discord muet.
 */
function fakeGuild(roles: Record<string, string[]> | null): Guild {
  return {
    members: {
      fetch: async () => {
        if (roles === null) throw new Error('Discord muet');
        return new Map(
          Object.entries(roles).map(([userId, roleIds]) => [
            userId,
            { roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) } },
          ]),
        );
      },
    },
  } as unknown as Guild;
}

const noBonus = { entries: [] };
const vipBonus = { entries: [{ roleId: 'vip', weight: 4 }] };

const realRandom = Math.random;
function stubRandom(...values: number[]) {
  let index = 0;
  Math.random = () => values[Math.min(index++, values.length - 1)];
}

afterEach(() => {
  Math.random = realRandom;
});

describe('drawWinnersWeighted', () => {
  test('écarte les participants qui ont quitté le serveur', async () => {
    const guild = fakeGuild({ a: [], c: [] });

    const winners = await drawWinnersWeighted(['a', 'b', 'c'], 3, guild, noBonus);

    expect([...winners].sort()).toEqual(['a', 'c']);
  });

  test('tire quand même quand Discord ne répond pas', async () => {
    stubRandom(0);

    const winners = await drawWinnersWeighted(['a', 'b'], 1, fakeGuild(null), noBonus);

    // Mieux vaut un tirage parmi des candidats non vérifiés qu'un concours sans
    // gagnant parce qu'une requête a échoué.
    expect(winners).toEqual(['a']);
  });

  test('applique les chances supplémentaires aux rôles avantagés', async () => {
    const guild = fakeGuild({ a: ['vip'], b: [] });

    // Poids 4 pour « a », 1 pour « b », soit 5 au total. Un tirage à 0,5 tombe
    // dans la part de « a », un tirage à 0,9 dans celle de « b ».
    stubRandom(0.5);
    expect(await drawWinnersWeighted(['a', 'b'], 1, guild, vipBonus)).toEqual(['a']);

    stubRandom(0.9);
    expect(await drawWinnersWeighted(['a', 'b'], 1, guild, vipBonus)).toEqual(['b']);
  });

  test('retombe en tirage égalitaire quand aucun rôle n\'est lisible', async () => {
    // Les rôles viennent de la récupération des membres. Muette, elle ne dit
    // rien du rôle avantagé, et la part de chacun redevient la même : à 0,9 sur
    // deux candidats, c'est le second.
    stubRandom(0.9);

    const winners = await drawWinnersWeighted(['a', 'b'], 1, fakeGuild(null), vipBonus);

    expect(winners).toEqual(['b']);
  });

  test('ne sert jamais deux fois le même gagnant', async () => {
    const guild = fakeGuild({ a: [], b: [], c: [] });

    const winners = await drawWinnersWeighted(['a', 'b', 'c'], 2, guild, noBonus);

    expect(winners).toHaveLength(2);
    expect(new Set(winners).size).toBe(2);
  });

  test('ne promet pas plus de gagnants qu\'il n\'y a de participants', async () => {
    const guild = fakeGuild({ a: [] });

    expect(await drawWinnersWeighted(['a'], 5, guild, noBonus)).toEqual(['a']);
  });

  test('ne tire rien sans participant ni sans gagnant à désigner', async () => {
    const guild = fakeGuild({ a: [] });

    expect(await drawWinnersWeighted([], 1, guild, noBonus)).toEqual([]);
    expect(await drawWinnersWeighted(['a'], 0, guild, noBonus)).toEqual([]);
  });
});

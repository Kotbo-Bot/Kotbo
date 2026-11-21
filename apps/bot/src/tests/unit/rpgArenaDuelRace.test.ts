import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '987654321098765432';
const DEFENSEUR = 'defenseur';

type RecordRow = { id: string; userId: string; rating: number; bestRating: number; wins: number; losses: number; streak: number };

const records = new Map<string, RecordRow>();
const matches: { ratingChange: number }[] = [];
const ligne = (id: string) => [...records.values()].find((row) => row.id === id)!;

/**
 * Verrous de ligne de PostgreSQL : pris par `SELECT ... FOR UPDATE` ou par une
 * écriture, tenus jusqu'à la fin de la transaction. Les transactions, elles,
 * avancent en parallèle : seul un verrou les fait attendre.
 */
const verrous = new Map<string, { tx: object; libere: Promise<void>; liberer: () => void }>();

async function verrouiller(tx: object, id: string): Promise<void> {
  for (let tenu = verrous.get(id); tenu && tenu.tx !== tx; tenu = verrous.get(id)) await tenu.libere;
  if (verrous.has(id)) return;
  let liberer = () => {};
  const libere = new Promise<void>((resolve) => { liberer = resolve; });
  verrous.set(id, { tx, libere, liberer });
}

const tables = {
  rpgProfile: {
    findUnique: mock(async ({ where }: { where: { guildId_userId: { userId: string } } }) => ({
      id: `profil-${where.guildId_userId.userId}`,
      userId: where.guildId_userId.userId,
      rpgGuildId: null,
      level: 10,
      energy: 100,
      className: null,
    })),
    updateMany: mock(async () => ({ count: 1 })),
    update: mock(async () => ({})),
  },
  rpgArenaRecord: {
    // Une lecture rend l'état au moment où elle part : deux duels lisent avant que l'un n'écrive.
    upsert: mock(async ({ where }: { where: { guildId_userId: { userId: string } } }) => {
      const snapshot = { ...records.get(where.guildId_userId.userId)!, lastMatchAt: null };
      await Bun.sleep(5);
      return snapshot;
    }),
    updateMany: mock(async () => ({ count: 1 })),
    findUnique: mock(async ({ where }: { where: { id: string } }) => {
      const snapshot = { ...ligne(where.id) };
      await Bun.sleep(1);
      return snapshot;
    }),
    update: mock(async ({ where, data }: {
      where: { id: string };
      data: Pick<RecordRow, 'rating' | 'bestRating' | 'streak'> & { wins: { increment: number }; losses: { increment: number } };
    }) => {
      const row = ligne(where.id);
      Object.assign(row, { rating: data.rating, bestRating: data.bestRating, streak: data.streak });
      row.wins += data.wins.increment;
      row.losses += data.losses.increment;
      return { ...row };
    }),
  },
  rpgArenaMatch: { create: mock(async ({ data }: { data: { ratingChange: number } }) => matches.push(data)) },
};

const prismaMock = {
  ...tables,
  $transaction: mock(async (fn: (client: object) => Promise<unknown>) => {
    const tx: Record<string, unknown> = {};
    Object.assign(tx, {
      ...tables,
      rpgArenaRecord: {
        ...tables.rpgArenaRecord,
        update: async (args: Parameters<typeof tables.rpgArenaRecord.update>[0]) => {
          await verrouiller(tx, args.where.id);
          return tables.rpgArenaRecord.update(args);
        },
      },
      // Seul SQL brut attendu : le verrou d'une ligne de classement.
      $queryRaw: async (sql: TemplateStringsArray, id: string) => {
        const texte = sql.join('?');
        if (texte !== 'SELECT 1 FROM "rpg_arena_records" WHERE "id" = ? FOR UPDATE') throw new Error(`requête brute inattendue : ${texte}`);
        await verrouiller(tx, id);
        return [];
      },
      $executeRaw: async (sql: TemplateStringsArray) => {
        throw new Error(`requête brute inattendue : ${sql.join('?')}`);
      },
    });
    try {
      return await fn(tx);
    } finally {
      for (const [id, tenu] of verrous) {
        if (tenu.tx !== tx) continue;
        verrous.delete(id);
        tenu.liberer();
      }
    }
  }),
};

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}

mockerModule('../../utils/db', { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock });
// Le défenseur frappe le premier et terrasse chaque challenger d'un coup.
mockerModule('../../services/features/combatService', {
  loadEffectiveStats: async ({ userId }: { userId: string }) => {
    const fort = userId === DEFENSEUR;
    return {
      attack: fort ? 500 : 1, defense: 0, speed: fort ? 5 : 1, maxHealth: fort ? 1000 : 10,
      critChance: 0, armorPiercing: 0, damageReduction: 0, lifesteal: 0, thorns: 0,
    };
  },
  loadAvailableSkills: async () => [],
});

const { fightArenaDuel } = await import('../../services/features/rpg/rpgArenaService.js');

describe('duels d\'arène simultanés', () => {
  test('deux challengers battus en même temps : la note du défenseur cumule les deux duels', async () => {
    for (const userId of ['challenger-a', 'challenger-b', DEFENSEUR]) {
      records.set(userId, { id: `arene-${userId}`, userId, rating: 1000, bestRating: 1000, wins: 0, losses: 0, streak: 0 });
    }

    await Promise.all([
      fightArenaDuel(GUILD_ID, 'challenger-a', DEFENSEUR),
      fightArenaDuel(GUILD_ID, 'challenger-b', DEFENSEUR),
    ]);

    const defenseur = records.get(DEFENSEUR)!;
    expect(defenseur.wins).toBe(2);
    expect(defenseur.rating).toBe(1000 + matches.reduce((total, match) => total + match.ratingChange, 0));
  });
});

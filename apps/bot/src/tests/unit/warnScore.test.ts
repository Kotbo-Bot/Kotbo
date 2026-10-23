import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const guildId = '987654321098765432';
const userId = '123456789012345678';

const prismaMock = {
  guild: { findUnique: mock(async (): Promise<unknown> => ({ warnWeightingEnabled: false, warnDecayDays: null })) },
  sanction: {
    count: mock(async () => 0),
    aggregate: mock(async (_args?: unknown): Promise<unknown> => ({ _sum: { weight: 0 } })),
    create: mock(async (args: any) => ({ id: 'sanction-1', ...args.data })),
    findFirst: mock(async (): Promise<unknown> => null),
  },
  guildDailyStat: { upsert: mock(async () => ({})) },
  memberProfile: { updateMany: mock(async () => ({ count: 0 })) },
};

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() })],
  ['../../utils/logger', () => ({
    logger: {
      info: mock(() => undefined), warn: mock(() => undefined),
      error: mock(() => undefined), debug: mock(() => undefined), success: mock(() => undefined),
    },
  })],
  ['../../utils/auditLogger', () => ({ queueAuditLog: mock(() => undefined) })],
];

for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { getWarnScore } = await import('../../services/moderation/sanctionService.js');

function setGuild(config: { warnWeightingEnabled: boolean; warnDecayDays: number | null }) {
  prismaMock.guild.findUnique = mock(async () => config);
}

beforeEach(() => {
  prismaMock.sanction.count = mock(async () => 4);
  prismaMock.sanction.aggregate = mock(async () => ({ _sum: { weight: 9 } }));
});

describe('getWarnScore - pondération désactivée', () => {
  test('retombe sur le compte brut de warns (comportement historique)', async () => {
    setGuild({ warnWeightingEnabled: false, warnDecayDays: 30 });

    const score = await getWarnScore(guildId, userId);

    expect(score).toBe(4);
    // Le compte brut est utilisé, pas la somme des poids
    expect(prismaMock.sanction.count).toHaveBeenCalledTimes(1);
    expect(prismaMock.sanction.aggregate).not.toHaveBeenCalled();
  });
});

describe('getWarnScore - pondération activée', () => {
  test('somme les poids au lieu de compter les warns', async () => {
    setGuild({ warnWeightingEnabled: true, warnDecayDays: null });

    const score = await getWarnScore(guildId, userId);

    expect(score).toBe(9);
    expect(prismaMock.sanction.count).not.toHaveBeenCalled();

    // Sans décroissance, aucun filtre de date n'est appliqué
    const where = (prismaMock.sanction.aggregate.mock.calls[0][0] as any).where;
    expect(where.type).toBe('WARN');
    expect(where.createdAt).toBeUndefined();
  });

  test('applique la fenêtre de décroissance quand warnDecayDays est défini', async () => {
    setGuild({ warnWeightingEnabled: true, warnDecayDays: 30 });

    await getWarnScore(guildId, userId);

    const where = (prismaMock.sanction.aggregate.mock.calls[0][0] as any).where;
    expect(where.createdAt?.gte).toBeInstanceOf(Date);

    // La borne doit tomber ~30 jours avant maintenant (tolérance 1 min)
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(where.createdAt.gte.getTime() - expected)).toBeLessThan(60_000);
  });

  test('retourne 0 plutôt que null quand le membre n’a aucun warn vivant', async () => {
    setGuild({ warnWeightingEnabled: true, warnDecayDays: 7 });
    prismaMock.sanction.aggregate = mock(async () => ({ _sum: { weight: null } }));

    expect(await getWarnScore(guildId, userId)).toBe(0);
  });

  test('prend en compte les comptes liés quand des IDs sont fournis', async () => {
    setGuild({ warnWeightingEnabled: true, warnDecayDays: null });

    await getWarnScore(guildId, userId, [userId, '555555555555555555']);

    const where = (prismaMock.sanction.aggregate.mock.calls[0][0] as any).where;
    // buildTargetUserWhere passe en mode "in" pour couvrir les alts
    expect(JSON.stringify(where)).toContain('555555555555555555');
  });

  test('guilde introuvable : retombe sur le compte brut sans planter', async () => {
    prismaMock.guild.findUnique = mock(async () => null);

    expect(await getWarnScore(guildId, userId)).toBe(4);
  });
});

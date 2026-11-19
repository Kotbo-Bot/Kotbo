import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '987654321098765432';
const TARGET = { id: '123456789012345678', tag: 'cible#0' };
const MODERATOR = { id: '223456789012345678', tag: 'modo#0' };

const HOUR_MS = 60 * 60 * 1000;
const T0 = new Date('2026-11-20T12:00:00.000Z').getTime();

type SanctionRow = {
  id: string;
  guildId: string;
  type: string;
  status: string;
  targetUserId: string;
  targetTag: string | null;
  moderatorUserId: string;
  moderatorTag: string | null;
  reason: string;
  durationSeconds: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  nextActionAt: Date | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
};

/** Table des sanctions, en mémoire. */
let sanctions: SanctionRow[] = [];
let nextId = 1;

function compare(field: unknown, op: string, bound: unknown): boolean {
  if (field === null || field === undefined) return false;
  const a = field instanceof Date ? field.getTime() : (field as number);
  const b = bound instanceof Date ? bound.getTime() : (bound as number);
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  return a <= b;
}

/** Sous-ensemble du filtre Prisma dont se servent les sanctions. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Record<string, unknown>[]).some((clause) => matches(row, clause));
    if (key === 'AND') return (condition as Record<string, unknown>[]).every((clause) => matches(row, clause));
    const field = row[key];
    if (condition instanceof Date) return field instanceof Date && field.getTime() === condition.getTime();
    if (condition !== null && typeof condition === 'object') {
      return Object.entries(condition).every(([op, bound]) => {
        if (op === 'not') return field !== bound;
        if (op === 'in') return (bound as unknown[]).includes(field);
        return compare(field, op, bound);
      });
    }
    return field === condition;
  });
}

function seed(row: Partial<SanctionRow> & Pick<SanctionRow, 'type' | 'status' | 'createdAt'>): SanctionRow {
  const full: SanctionRow = {
    id: `sanction-${nextId++}`,
    guildId: GUILD_ID,
    targetUserId: TARGET.id,
    targetTag: TARGET.tag,
    moderatorUserId: MODERATOR.id,
    moderatorTag: MODERATOR.tag,
    reason: 'raison',
    durationSeconds: null,
    expiresAt: null,
    nextActionAt: null,
    resolvedAt: null,
    resolutionNote: null,
    ...row,
  };
  sanctions.push(full);
  return full;
}

const prismaMock = {
  sanction: {
    findFirst: mock(async ({ where }: { where: Record<string, unknown> }) => {
      const found = sanctions.find((row) => matches(row, where));
      return found ? { ...found } : null;
    }),
    findMany: mock(async ({ where }: { where: Record<string, unknown> }) =>
      sanctions.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
    findUnique: mock(async ({ where }: { where: { id: string } }) => sanctions.find((row) => row.id === where.id) ?? null),
    create: mock(async ({ data }: { data: Partial<SanctionRow> }) =>
      ({ ...seed({ ...data, createdAt: new Date() } as SanctionRow) })),
    update: mock(async ({ where, data }: { where: { id: string }; data: Partial<SanctionRow> }) => {
      const row = sanctions.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('sanction introuvable');
      Object.assign(row, data);
      return { ...row };
    }),
    updateMany: mock(async ({ where, data }: { where: Record<string, unknown>; data: Partial<SanctionRow> }) => {
      const hit = sanctions.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    }),
  },
  memberJail: { findMany: mock(async () => []) },
};

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}

const silence = () => undefined;
mockerModule('../../utils/db', { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock });
mockerModule('../../utils/logger', {
  logger: { info: silence, warn: silence, error: silence, debug: silence, success: silence },
});
mockerModule('../../utils/auditLogger', { queueAuditLog: mock(() => undefined) });

const { processScheduledSanctions, registerBanSanction } = await import('../../services/moderation/sanctionService.js');

const unban = mock(async (_userId: string, _reason?: string) => undefined);

function fakeClient(): Client {
  const guild = { id: GUILD_ID, members: { unban } };
  return {
    guilds: {
      cache: new Map([[GUILD_ID, guild]]),
      fetch: mock(async () => guild),
    },
  } as unknown as Client;
}

beforeEach(() => {
  sanctions = [];
  nextId = 1;
  unban.mockClear();
  setSystemTime(new Date(T0));
});

afterEach(() => {
  setSystemTime();
});

describe('levée automatique d\'un tempban couvert par un bannissement plus récent', () => {
  test('un ban définitif prononcé pendant un tempban : l\'échéance du tempban ne débannit plus', async () => {
    const tempBan = seed({
      type: 'TEMP_BAN',
      status: 'ACTIVE',
      createdAt: new Date(T0 - HOUR_MS),
      expiresAt: new Date(T0 + HOUR_MS),
      nextActionAt: new Date(T0 + HOUR_MS),
      durationSeconds: 2 * 60 * 60,
    });

    await registerBanSanction({ guildId: GUILD_ID, target: TARGET, moderator: MODERATOR, reason: 'récidive' });

    // L'ancien tempban ne reste pas actif à côté du ban définitif.
    expect(sanctions.find((row) => row.id === tempBan.id)?.status).not.toBe('ACTIVE');

    // Deux heures plus tard, l'échéance du tempban est passée.
    setSystemTime(new Date(T0 + 2 * HOUR_MS));
    await processScheduledSanctions(fakeClient());

    expect(unban).not.toHaveBeenCalled();
  });

  test('un ban définitif arrivé par un autre chemin, tempban resté actif : pas de débannissement', async () => {
    const tempBan = seed({
      type: 'TEMP_BAN',
      status: 'ACTIVE',
      createdAt: new Date(T0 - 3 * HOUR_MS),
      expiresAt: new Date(T0 - 60_000),
      nextActionAt: new Date(T0 - 60_000),
    });
    seed({ type: 'BAN', status: 'RESOLVED', createdAt: new Date(T0 - HOUR_MS), resolvedAt: new Date(T0 - HOUR_MS) });

    await processScheduledSanctions(fakeClient());

    expect(unban).not.toHaveBeenCalled();
    // Le tempban est clos sans échéance restante : il ne revient pas à la passe suivante.
    const closed = sanctions.find((row) => row.id === tempBan.id);
    expect(closed?.status).toBe('RESOLVED');
    expect(closed?.nextActionAt).toBeNull();
  });

  test('un autre tempban actif qui expire plus tard couvre encore le membre', async () => {
    seed({
      type: 'TEMP_BAN',
      status: 'ACTIVE',
      createdAt: new Date(T0 - 3 * HOUR_MS),
      expiresAt: new Date(T0 - 60_000),
      nextActionAt: new Date(T0 - 60_000),
    });
    seed({
      type: 'TEMP_BAN',
      status: 'ACTIVE',
      createdAt: new Date(T0 - HOUR_MS),
      expiresAt: new Date(T0 + 24 * HOUR_MS),
      nextActionAt: new Date(T0 + 24 * HOUR_MS),
    });

    await processScheduledSanctions(fakeClient());

    expect(unban).not.toHaveBeenCalled();
  });

  test('un ban définitif antérieur au tempban ne bloque pas sa levée', async () => {
    // Banni, débanni, puis banni temporairement : le vieux ban ne couvre plus rien.
    seed({ type: 'BAN', status: 'RESOLVED', createdAt: new Date(T0 - 30 * 24 * HOUR_MS) });
    const tempBan = seed({
      type: 'TEMP_BAN',
      status: 'ACTIVE',
      createdAt: new Date(T0 - 3 * HOUR_MS),
      expiresAt: new Date(T0 - 60_000),
      nextActionAt: new Date(T0 - 60_000),
    });

    await processScheduledSanctions(fakeClient());

    expect(unban).toHaveBeenCalledTimes(1);
    expect(unban.mock.calls[0][0]).toBe(TARGET.id);
    expect(sanctions.find((row) => row.id === tempBan.id)?.status).toBe('RESOLVED');
  });
});

describe('échec de la levée automatique d\'un tempban', () => {
  test('un débannissement refusé par Discord laisse le tempban en échec, pas résolu', async () => {
    const tempBan = seed({
      type: 'TEMP_BAN',
      status: 'ACTIVE',
      createdAt: new Date(T0 - 3 * HOUR_MS),
      expiresAt: new Date(T0 - 60_000),
      nextActionAt: new Date(T0 - 60_000),
    });
    unban.mockImplementationOnce(async () => { throw new Error('Missing Permissions'); });

    await processScheduledSanctions(fakeClient());

    expect(sanctions.find((row) => row.id === tempBan.id)?.status).toBe('FAILED');
  });
});

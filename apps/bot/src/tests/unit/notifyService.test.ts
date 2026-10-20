import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

type Pref = { dashboard: boolean; dm: boolean; digest: boolean } | null;
type QueuedDm = { id: string; userId: string; guildId: string; kind: string; category: string; title: string; message: string; severity: string; link: string | null; digest: boolean; sendAfter: Date; claimedAt: Date | null; createdAt: Date };

const state = {
  isStaff: true,
  pref: null as Pref,
  existingGroup: null as { id: string } | null,
  queue: [] as QueuedDm[],
};

const prismaMock = {
  staffMember: { findUnique: mock(async () => (state.isStaff ? { userId: 'u1' } : null)) },
  notificationPreference: {
    findUnique: mock(async () => state.pref),
    upsert: mock(async () => ({})),
  },
  notification: {
    findFirst: mock(async () => state.existingGroup),
    create: mock(async (args: { data: Record<string, unknown> }) => ({ id: 'n-new', ...args.data })),
    update: mock(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ id: args.where.id, ...args.data })),
  },
  notificationDm: {
    findFirst: mock(async () => state.queue.find((r) => !r.digest && !r.claimedAt) ?? null),
    create: mock(async (args: { data: Omit<QueuedDm, 'id' | 'claimedAt' | 'createdAt'> }) => {
      const row = { id: `q${state.queue.length}`, claimedAt: null, createdAt: new Date(), ...args.data };
      state.queue.push(row);
      return row;
    }),
    updateMany: mock(async () => ({ count: 0 })),
    findMany: mock(async (args: { where: { sendAfter: { lte: Date } } }) => [
      ...new Set(state.queue.filter((r) => !r.claimedAt && r.sendAfter <= args.where.sendAfter.lte).map((r) => r.userId)),
    ].map((userId) => ({ userId }))),
    updateManyAndReturn: mock(async (args: { where: { userId: string; sendAfter: { lte: Date } }; data: { claimedAt: Date } }) => {
      const rows = state.queue.filter((r) => r.userId === args.where.userId && !r.claimedAt && r.sendAfter <= args.where.sendAfter.lte);
      for (const r of rows) r.claimedAt = args.data.claimedAt;
      return rows;
    }),
    deleteMany: mock(async (args: { where: { id?: { in: string[] } } }) => {
      const ids = new Set(args.where.id?.in ?? []);
      state.queue = state.queue.filter((r) => !ids.has(r.id));
      return { count: ids.size };
    }),
  },
};

const userSend = mock(async (_payload: unknown) => undefined);
const clientMock = {
  users: { fetch: mock(async () => ({ send: userSend })) },
  guilds: { cache: new Map([['g1', { name: 'Serveur' }]]), fetch: mock(async () => null) },
};
const broadcast = mock(() => undefined);

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock })],
  ['../../utils/client', () => ({ getClient: () => clientMock })],
  ['../../utils/logger', () => ({ logger: { debug: () => undefined, warn: () => undefined, error: () => undefined, info: () => undefined } })],
  ['../../utils/i18n', () => ({ resolveGuildLocale: async () => 'fr' })],
  ['../../api/shared/sharding', () => ({ broadcastDashboardStateChange: broadcast })],
  ['../../utils/instanceContext', () => ({ getCurrentInstance: () => ({ dashboardUrl: 'https://dash.example' }) })],
];
for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { notify, dashboardLink, flushNotificationDms, MUTE_PREFIX } = await import('../../services/notifications/notifyService.js');

const base = { guildId: 'g1', userId: 'u1', title: 'T', message: 'M', link: '/planning' } as const;
const T0 = new Date('2026-10-20T10:00:00Z');

function sentJson(call = 0): string {
  return JSON.stringify(userSend.mock.calls[call][0]);
}

beforeEach(() => {
  state.isStaff = true;
  state.pref = null;
  state.existingGroup = null;
  state.queue = [];
  for (const fn of [prismaMock.notification.create, prismaMock.notification.update, userSend, broadcast]) fn.mockClear();
});

describe('notify', () => {
  test('sans réglage : boîte avec la famille du catalogue, MP mis en file', async () => {
    const result = await notify({ ...base, kind: 'planning.task_assigned' }, T0);
    expect(prismaMock.notification.create.mock.calls[0][0].data.category).toBe('planning');
    expect(result.dm).toBe('queued');
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].link).toBe('https://dash.example/planning?guild=g1');
    expect(userSend).not.toHaveBeenCalled();
  });

  test('la grille coupe la boîte et le MP d\'une famille', async () => {
    state.pref = { dashboard: false, dm: false, digest: false };
    const result = await notify({ ...base, kind: 'planning.task_assigned' }, T0);
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(result.dm).toBe('off');
    expect(state.queue).toHaveLength(0);
  });

  test('un type obligatoire passe outre la grille et part tout de suite, sans bouton de coupure', async () => {
    state.pref = { dashboard: false, dm: false, digest: false };
    const result = await notify({ ...base, kind: 'planning.absence_decided' }, T0);
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1);
    expect(result.dm).toBe('sent');
    expect(sentJson()).not.toContain(MUTE_PREFIX);
  });

  test('dm: false (réglage du module) ne part pas en MP', async () => {
    const result = await notify({ ...base, kind: 'planning.task_assigned', dm: false }, T0);
    expect(result.dm).toBe('off');
  });

  test('hors staff : pas de boîte ni de lien vers le dashboard, le MP part quand même', async () => {
    state.isStaff = false;
    const result = await notify({ ...base, kind: 'moderation.warning_received' }, T0);
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(result.dm).toBe('sent');
    expect(sentJson()).not.toContain('dash.example');
  });

  test('même groupKey non lue : on incrémente au lieu d\'empiler', async () => {
    state.existingGroup = { id: 'n-old' };
    await notify({ ...base, kind: 'recruitment.application_received', groupKey: 'recruitment.application_received' }, T0);
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(prismaMock.notification.update.mock.calls[0][0].data.count).toEqual({ increment: 1 });
  });

  test('résumé choisi : le MP attend le prochain passage de 8 h UTC', async () => {
    state.pref = { dashboard: true, dm: true, digest: true };
    await notify({ ...base, kind: 'planning.task_assigned' }, T0);
    expect(state.queue[0].digest).toBe(true);
    expect(state.queue[0].sendAfter.toISOString()).toBe('2026-10-21T08:00:00.000Z');
  });
});

describe('flushNotificationDms', () => {
  test('deux MP rapprochés partent en un seul message', async () => {
    await notify({ ...base, kind: 'planning.task_assigned', title: 'Tâche A' }, T0);
    await notify({ ...base, kind: 'planning.meeting_scheduled', title: 'Réunion B' }, new Date(T0.getTime() + 30_000));
    expect(state.queue[1].sendAfter).toEqual(state.queue[0].sendAfter);

    expect(await flushNotificationDms(new Date(T0.getTime() + 30_000))).toBe(0);
    expect(await flushNotificationDms(new Date(T0.getTime() + 61_000))).toBe(1);
    expect(userSend).toHaveBeenCalledTimes(1);
    expect(sentJson()).toContain('Tâche A');
    expect(sentJson()).toContain('Réunion B');
    expect(state.queue).toHaveLength(0);
  });

  test('un MP seul garde le bouton « Ne plus recevoir ce type »', async () => {
    await notify({ ...base, kind: 'planning.task_assigned' }, T0);
    await flushNotificationDms(new Date(T0.getTime() + 61_000));
    expect(sentJson()).toContain(`${MUTE_PREFIX}planning`);
  });
});

describe('dashboardLink', () => {
  test('ajoute ?guild= en gardant la requête existante', () => {
    expect(dashboardLink('/planning?id=42', 'g1')).toBe('https://dash.example/planning?id=42&guild=g1');
  });
});

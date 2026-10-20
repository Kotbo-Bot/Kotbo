import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

type Pref = { dashboard: boolean; dm: boolean; digest: boolean } | null;

const state = {
  isStaff: true,
  pref: null as Pref,
  existingGroup: null as { id: string } | null,
};

const prismaMock = {
  staffMember: { findUnique: mock(async () => (state.isStaff ? { userId: 'u1' } : null)) },
  notificationPreference: { findUnique: mock(async () => state.pref) },
  notification: {
    findFirst: mock(async () => state.existingGroup),
    create: mock(async (args: { data: Record<string, unknown> }) => ({ id: 'n-new', ...args.data })),
    update: mock(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ id: args.where.id, ...args.data })),
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
  ['../../api/shared/sharding', () => ({ broadcastDashboardStateChange: broadcast })],
  ['../../utils/instanceContext', () => ({ getCurrentInstance: () => ({ dashboardUrl: 'https://dash.example' }) })],
];
for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { notify, dashboardLink } = await import('../../services/notifications/notifyService.js');

const base = { guildId: 'g1', userId: 'u1', title: 'T', message: 'M', link: '/planning' } as const;

beforeEach(() => {
  state.isStaff = true;
  state.pref = null;
  state.existingGroup = null;
  for (const fn of [prismaMock.notification.create, prismaMock.notification.update, userSend, broadcast]) fn.mockClear();
});

describe('notify', () => {
  test('sans réglage : boîte + MP, avec la famille copiée du catalogue', async () => {
    await notify({ ...base, kind: 'planning.task_assigned' });
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.notification.create.mock.calls[0][0].data.category).toBe('planning');
    expect(userSend).toHaveBeenCalledTimes(1);
  });

  test('la grille coupe la boîte et le MP d\'une famille', async () => {
    state.pref = { dashboard: false, dm: false, digest: false };
    await notify({ ...base, kind: 'planning.task_assigned' });
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(userSend).not.toHaveBeenCalled();
  });

  test('un type obligatoire passe outre la grille', async () => {
    state.pref = { dashboard: false, dm: false, digest: false };
    await notify({ ...base, kind: 'planning.absence_decided' });
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1);
    expect(userSend).toHaveBeenCalledTimes(1);
  });

  test('dm: false (réglage du module) ne part pas en MP', async () => {
    await notify({ ...base, kind: 'planning.task_assigned', dm: false });
    expect(userSend).not.toHaveBeenCalled();
  });

  test('hors staff : pas de boîte, le MP part quand même', async () => {
    state.isStaff = false;
    await notify({ ...base, kind: 'moderation.warning_received' });
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(userSend).toHaveBeenCalledTimes(1);
  });

  test('même groupKey non lue : on incrémente au lieu d\'empiler', async () => {
    state.existingGroup = { id: 'n-old' };
    await notify({ ...base, kind: 'recruitment.application_received', groupKey: 'recruitment.application_received' });
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(prismaMock.notification.update.mock.calls[0][0].data.count).toEqual({ increment: 1 });
  });
});

describe('dashboardLink', () => {
  test('ajoute ?guild= en gardant la requête existante', () => {
    expect(dashboardLink('/planning?id=42', 'g1')).toBe('https://dash.example/planning?id=42&guild=g1');
  });
});

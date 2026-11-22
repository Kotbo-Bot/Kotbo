/**
 * Chaque purge vise les mêmes arrivées : une expulsion acceptée, une refusée par
 * Discord, un membre déjà parti et, pour la cascade (seule à épargner les gradés),
 * un membre placé plus haut que l'auteur.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { DiscordAPIError, HTTPError, type Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate } from '../helpers/honoDashboard.js';

const GUILD = '100000000000000001';
const ACTOR = '200000000000000001';
const OWNER = '200000000000000099';
const INVITER = '300000000000000001';
const CODE = 'abc123';

const EXPELLED = '400000000000000001';
const REFUSED = '400000000000000002';
const GONE = '400000000000000003';
const PROTECTED = '400000000000000004';
const UNREADABLE = '400000000000000005';

let activeJoins: Array<{ id: string; userId: string }> = [];
const markedLeft = mock(async (_args: { where: { id: { in: string[] } }; data: { leftAt: Date } }) => ({ count: 0 }));
const auditWrites = mock(async (_args: { data: { details: string } }) => ({}));

const mockDb = {
  suspendedInviter: { upsert: mock(async () => ({ id: 'suspension-1', guildId: GUILD, userId: INVITER })) },
  guildInvite: {
    updateMany: mock(async () => ({ count: 1 })),
    findUnique: mock(async () => ({ code: CODE, guildId: GUILD })),
  },
  memberInvite: { findMany: mock(async () => activeJoins), updateMany: markedLeft },
  dashboardAuditLog: { create: auditWrites },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}
mockModule('../../api/routes/dashboard/featureGate', { getCachedFeatureAccess: async () => ({}) });
mockModule('../../utils/cache', { cache: { invalidateGuild: async () => {} } });

// Session et garde serveur simulées : un modérateur, à qui la route ouvre les purges.
mockDashboardGate(
  { level: 'moderator', canViewDashboard: true, canModerateContent: true, canManageSettings: false, canManageTutoring: false },
  { userId: ACTOR, username: 'Modo' },
);
const { createMembersRouter } = await import('../../api/routes/dashboard/members.js');

// ─── Faux serveur Discord ───

const kicks: string[] = [];
function member(id: string, position: number, kick: () => Promise<unknown>) {
  return {
    id,
    roles: { highest: { position } },
    kick: async (_reason?: string) => {
      kicks.push(id);
      return kick();
    },
  };
}
const members: Record<string, ReturnType<typeof member>> = {
  [ACTOR]: member(ACTOR, 5, async () => undefined),
  [EXPELLED]: member(EXPELLED, 1, async () => undefined),
  [REFUSED]: member(REFUSED, 1, async () => { throw new Error('Missing Permissions'); }),
  [PROTECTED]: member(PROTECTED, 10, async () => undefined),
};
const guild = {
  id: GUILD,
  name: 'Serveur test',
  ownerId: OWNER,
  members: {
    // Comme discord.js : un membre parti lève Unknown Member, une panne de Discord autre chose.
    fetch: async (userId: string) => {
      const route = `/guilds/${GUILD}/members/${userId}`;
      if (userId === UNREADABLE) throw new HTTPError(503, 'Service Unavailable', 'GET', route, { body: undefined, files: undefined });
      const found = members[userId];
      if (!found) throw new DiscordAPIError({ code: 10007, message: 'Unknown Member' }, 10007, 404, 'GET', route, { body: undefined, files: undefined });
      return found;
    },
  },
};
const client = { guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => null } } as unknown as Client;

const join = (userId: string) => ({ id: `join-${userId}`, userId });

function post(route: string, body?: unknown) {
  return dashboardCall(createMembersRouter(client), 'POST', `/api/dashboard/guilds/${GUILD}/invitations/${route}`, body);
}

/** Identifiants des arrivées marquées « parties », toutes requêtes confondues. */
const leftJoinIds = () => markedLeft.mock.calls.flatMap(([args]) => args.where.id.in);
const auditDetails = () => auditWrites.mock.calls.map(([args]) => args.data.details);

beforeEach(() => {
  kicks.length = 0;
  markedLeft.mockClear();
  auditWrites.mockClear();
  activeJoins = [join(EXPELLED), join(REFUSED), join(GONE)];
});

describe("purges d'invitations", () => {
  test("la cascade d'un créateur suspendu ne compte ni ne marque partis le membre protégé et l'expulsion refusée", async () => {
    activeJoins = [join(EXPELLED), join(REFUSED), join(GONE), join(PROTECTED)];

    const { status, body } = await post('suspended-inviters', { userId: INVITER, cascade: true });

    expect(status).toBe(201);
    expect(body.cascade).toEqual({ purgedCount: 1, failedCount: 1 });
    // Le gradé n'est pas expulsé : il reste, son suivi d'invitation aussi.
    expect(kicks).toEqual([EXPELLED, REFUSED]);
    expect(leftJoinIds()).toEqual([`join-${EXPELLED}`, `join-${GONE}`]);
  });

  test("la purge par créateur ne compte ni ne marque partie l'expulsion refusée", async () => {
    const { status, body } = await post(`inviters/${INVITER}/purge`);

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, purgedCount: 1, failedCount: 1 });
    expect(leftJoinIds()).toEqual([`join-${EXPELLED}`, `join-${GONE}`]);
    expect(auditDetails()).toEqual([`Membres invités par ${INVITER} purgés : 1 membre(s) exclu(s), 1 échec(s).`]);
  });

  test("la purge d'une invitation ne compte ni ne marque partie l'expulsion refusée", async () => {
    const { status, body } = await post(`${CODE}/purge`);

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, purgedCount: 1, failedCount: 1 });
    expect(leftJoinIds()).toEqual([`join-${EXPELLED}`, `join-${GONE}`]);
    expect(auditDetails()).toEqual([`Purge de l'invitation ${CODE} : 1 membre(s) exclu(s), 1 échec(s).`]);
  });

  test("un membre que Discord n'a pas pu lire (panne, délai dépassé) n'est pas marqué parti", async () => {
    activeJoins = [join(GONE), join(UNREADABLE)];

    const { status, body } = await post(`${CODE}/purge`);

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, purgedCount: 0, failedCount: 1 });
    expect(leftJoinIds()).toEqual([`join-${GONE}`]);
  });
});

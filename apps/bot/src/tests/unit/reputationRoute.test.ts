import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, DASHBOARD_ACCESS_MODERATOR, type AuthClaims, type DashboardAccess } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const mockDb = {
  dashboardAuditLog: { create: mock(async (_args?: unknown) => ({})) },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

let deletedVote: Record<string, unknown> | null = null;
const service = {
  getReputationDashboardData: mock(async (_guildId: string, _period: string) => ({
    config: { dailyLimit: 3 },
    leaderboard: { entries: [{ userId: '111111111111111111', totalRep: 4, rank: 1 }], totalVoters: 2 },
    stats: { totalVotes: 4, votesLast7Days: 1, activeGivers7Days: 1, lastVoteAt: null },
  })),
  listReputationVotes: mock(async (_guildId: string, _filter: unknown) => ({
    votes: [{
      id: 'v1',
      giverId: '222222222222222222',
      receiverId: '111111111111111111',
      reason: null,
      channelId: '333333333333333333',
      messageId: '444444444444444444',
      createdAt: new Date('2026-11-13T10:00:00Z'),
    }],
    nextCursor: null,
  })),
  saveReputationConfig: mock(async (_guildId: string, patch: Record<string, unknown>) => ({ dailyLimit: 3, ...patch })),
  deleteReputationVote: mock(async (_guildId: string, _voteId: string) => deletedVote),
};
const servicePath = path.resolve(__dirname, '../../services/community/reputationService.ts');
for (const suffix of ['../../services/community/reputationService.ts', '../../services/community/reputationService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(servicePath, service));
}

const identitiesPath = path.resolve(__dirname, '../../services/moderation/memberIdentityService.ts');
for (const suffix of ['../../services/moderation/memberIdentityService.ts', '../../services/moderation/memberIdentityService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(identitiesPath, {
    getMemberIdentities: mock(async () => new Map([
      ['111111111111111111', { displayName: 'Alice', avatarUrl: 'a.png' }],
      ['222222222222222222', { displayName: 'Bob', avatarUrl: '' }],
    ])),
  }));
}

const { handleReputationRoutes } = await import('../../api/routes/dashboard/reputation.js');

const GUILD = '999999999999999999';
const client = { guilds: { cache: new Map() } } as unknown as Client;
const user: AuthClaims = { userId: 'user-1', username: 'Admin' } as AuthClaims;

interface MockResponse extends ServerResponse { body: string }

function request(method: string, pathAndQuery: string, body?: unknown): { req: IncomingMessage; url: URL; parts: string[] } {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = pathAndQuery;
  req.headers = { 'content-type': 'application/json' };
  req.push(body === undefined ? '' : JSON.stringify(body));
  req.push(null);
  const url = new URL(pathAndQuery, 'http://localhost');
  return { req, url, parts: url.pathname.split('/').filter(Boolean) };
}

function response(): MockResponse {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as MockResponse;
  let status = 200;
  let body = '';
  Object.defineProperty(res, 'statusCode', { get: () => status, set: (code: number) => { status = code; } });
  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.writeHead = (code: number) => { status = code; return res; };
  res.end = (chunk?: unknown) => { if (chunk) body += String(chunk); res.body = body; return res; };
  return res;
}

async function call(method: string, suffix: string, body?: unknown, access: DashboardAccess = DASHBOARD_ACCESS_ADMIN) {
  const { req, url, parts } = request(method, `/api/dashboard/guilds/${GUILD}/reputation${suffix}`, body);
  const res = response();
  const handled = await handleReputationRoutes(req, res, parts, url, client, user, GUILD, access);
  return { handled, status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
  deletedVote = null;
  for (const fn of Object.values(service)) fn.mockClear();
  mockDb.dashboardAuditLog.create.mockClear();
});

describe('GET /reputation', () => {
  test('rend réglages, statistiques et classement avec les noms', async () => {
    const { status, json } = await call('GET', '?period=week');
    expect(status).toBe(200);
    expect(service.getReputationDashboardData.mock.calls[0][1]).toBe('week');
    expect(json.config).toEqual({ dailyLimit: 3 });
    expect(json.stats.votesLast7Days).toBe(1);
    expect(json.leaderboard.entries[0].displayName).toBe('Alice');
  });

  test('une période inconnue retombe sur « tout »', async () => {
    await call('GET', '?period=decade');
    expect(service.getReputationDashboardData.mock.calls[0][1]).toBe('all');
  });
});

describe('GET /reputation/votes', () => {
  test('rend les votes avec identités et lien vers le message', async () => {
    const { status, json } = await call('GET', '/votes?period=month&cursor=v0');
    expect(status).toBe(200);
    expect(service.listReputationVotes.mock.calls[0][1]).toMatchObject({ period: 'month', cursor: 'v0' });
    const vote = json.votes[0];
    expect(vote.giverName).toBe('Bob');
    expect(vote.giverAvatarUrl).toBeNull();
    expect(vote.receiverName).toBe('Alice');
    expect(vote.messageUrl).toBe(`https://discord.com/channels/${GUILD}/333333333333333333/444444444444444444`);
    expect(json.nextCursor).toBeNull();
  });

  test('refuse un identifiant de membre mal formé', async () => {
    const { status } = await call('GET', '/votes?userId=abc');
    expect(status).toBe(400);
    expect(service.listReputationVotes).not.toHaveBeenCalled();
  });
});

describe('PATCH /reputation/config', () => {
  test('enregistre la limite, journalise et la renvoie', async () => {
    const { status, json } = await call('PATCH', '/config', { dailyLimit: 5 });
    expect(status).toBe(200);
    expect(service.saveReputationConfig.mock.calls[0][1]).toEqual({ dailyLimit: 5 });
    expect(json.config.dailyLimit).toBe(5);
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test('refuse une limite hors bornes ou non entière', async () => {
    for (const dailyLimit of [0, 21, 2.5, '3']) {
      const { status } = await call('PATCH', '/config', { dailyLimit });
      expect(status).toBe(400);
    }
    expect(service.saveReputationConfig).not.toHaveBeenCalled();
  });

  test('refuse un corps sans champ connu', async () => {
    const { status } = await call('PATCH', '/config', { foo: 1 });
    expect(status).toBe(400);
  });

  test('refuse sans le droit de gérer les réglages', async () => {
    const { status } = await call('PATCH', '/config', { dailyLimit: 5 }, DASHBOARD_ACCESS_MODERATOR);
    expect(status).toBe(403);
    expect(service.saveReputationConfig).not.toHaveBeenCalled();
  });
});

describe('DELETE /reputation/votes/:id', () => {
  test('retire le vote et journalise', async () => {
    deletedVote = { id: 'v1', guildId: GUILD, giverId: '222222222222222222', receiverId: '111111111111111111' };
    const { status } = await call('DELETE', '/votes/v1');
    expect(status).toBe(200);
    expect(service.deleteReputationVote.mock.calls[0]).toEqual([GUILD, 'v1']);
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test('404 pour un vote inconnu', async () => {
    const { status } = await call('DELETE', '/votes/absent');
    expect(status).toBe(404);
  });

  test('refuse sans le droit de gérer les réglages', async () => {
    const { status } = await call('DELETE', '/votes/v1', undefined, DASHBOARD_ACCESS_MODERATOR);
    expect(status).toBe(403);
    expect(service.deleteReputationVote).not.toHaveBeenCalled();
  });
});

test('ignore les autres segments', async () => {
  const { req, url, parts } = request('GET', `/api/dashboard/guilds/${GUILD}/drops`);
  expect(await handleReputationRoutes(req, response(), parts, url, client, user, GUILD, DASHBOARD_ACCESS_ADMIN)).toBe(false);
});

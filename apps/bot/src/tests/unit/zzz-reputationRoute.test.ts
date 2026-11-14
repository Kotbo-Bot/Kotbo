/**
 * Routes dashboard du module Réputation.
 *
 * Préfixe `zzz-` : ce fichier remplace `reputationService`, `reputationActions`,
 * `reputationTierService` et `memberIdentityService` pour tout le process
 * (`mock.module` est global). Il doit charger après les tests de ces services.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, DASHBOARD_ACCESS_MODERATOR, type AuthClaims, type DashboardAccess } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const mockDb = {
  dashboardAuditLog: { create: mock(async (_args?: unknown) => ({})) },
  guild: { findUnique: mock(async (_args?: unknown) => null) },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

let deletedVote: Record<string, unknown> | null = null;
const SETTINGS = {
  dailyLimit: 3,
  reactionEnabled: false,
  reactionEmoji: null as string | null,
  xpPerRep: 0,
  coinsPerRep: 0,
  announceChannelId: null,
  minAccountAgeDays: 0,
  minMemberDays: 0,
  sameMemberCooldownDays: 1,
  excludedRoleIds: [] as string[],
  excludedChannelIds: [] as string[],
  tiers: [{ threshold: 10, roleId: '555555555555555555' }],
};
let currentSettings = { ...SETTINGS };
const service = {
  getReputationDashboardData: mock(async (_guildId: string, _period: string) => ({
    config: SETTINGS,
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
  saveReputationConfig: mock(async (_guildId: string, patch: Record<string, unknown>) => ({ ...SETTINGS, ...patch })),
  getReputationConfig: mock(async (_guildId: string) => currentSettings),
  getMemberReputationSummary: mock(async (_guildId: string, _userId: string) => ({
    totalRep: 6,
    rank: 2,
    receivedVotes: 5,
    givenVotes: 3,
    receivedLast7Days: 1,
    recent: [{ id: 'v1', kind: 'VOTE', value: 1, giverId: '222222222222222222', reason: null, createdAt: new Date('2026-11-13T10:00:00Z') }],
  })),
};
const servicePath = path.resolve(__dirname, '../../services/community/reputationService.ts');
for (const suffix of ['../../services/community/reputationService.ts', '../../services/community/reputationService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(servicePath, service));
}

let adjustResult: Record<string, unknown> = { success: true, before: 4, after: 9 };
const actions = {
  revokeRep: mock(async (_client: unknown, _guildId: string, _voteId: string) => deletedVote),
  adjustRep: mock(async (_client: unknown, _input: unknown) => adjustResult),
  resetMemberRep: mock(async (_client: unknown, _guildId: string, _userId: string) => 3),
  resetGuildRep: mock(async (_client: unknown, _guildId: string) => ({ count: 12, members: 4 })),
};
const actionsPath = path.resolve(__dirname, '../../services/community/reputationActions.ts');
for (const suffix of ['../../services/community/reputationActions.ts', '../../services/community/reputationActions.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(actionsPath, actions));
}

let manageable = true;
const tierService = {
  tierAnnouncementLabels: mock((locale: string) => ({ locale, title: 'T', body: '{user} {role} {threshold}' })),
  manageableRole: mock((_guild: unknown, roleId: string) => (manageable ? { id: roleId } : null)),
};
const tierPath = path.resolve(__dirname, '../../services/community/reputationTierService.ts');
for (const suffix of ['../../services/community/reputationTierService.ts', '../../services/community/reputationTierService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(tierPath, tierService));
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
const ROLE = '555555555555555555';
const guilds = new Map<string, unknown>();
const client = { guilds: { cache: guilds } } as unknown as Client;
/** Serveur présent dans le cache du shard, avec ses rôles. */
function cacheGuild(roleIds: string[]) {
  guilds.set(GUILD, { preferredLocale: 'fr', roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } });
}
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
  adjustResult = { success: true, before: 4, after: 9 };
  manageable = true;
  currentSettings = { ...SETTINGS };
  guilds.clear();
  for (const fn of [...Object.values(service), ...Object.values(actions)]) (fn as { mockClear: () => void }).mockClear();
  mockDb.dashboardAuditLog.create.mockClear();
});

describe('GET /reputation', () => {
  test('rend réglages, statistiques et classement avec les noms', async () => {
    const { status, json } = await call('GET', '?period=week');
    expect(status).toBe(200);
    expect(service.getReputationDashboardData.mock.calls[0][1]).toBe('week');
    expect(json.config).toEqual(SETTINGS);
    expect(json.announcement.body).toContain('{user}');
    expect(json.stats.votesLast7Days).toBe(1);
    expect(json.leaderboard.entries[0].displayName).toBe('Alice');
  });

  test('signale les rôles de palier que le bot ne peut pas donner', async () => {
    cacheGuild([ROLE]);
    manageable = false;
    const { json } = await call('GET', '');
    expect(json.unmanageableTierRoleIds).toEqual([ROLE]);
  });

  test('une période inconnue retombe sur « tout »', async () => {
    await call('GET', '?period=decade');
    expect(service.getReputationDashboardData.mock.calls[0][1]).toBe('all');
  });
});

describe('GET /reputation/votes', () => {
  test('rend les votes avec identités et lien vers le message', async () => {
    const { status, json } = await call('GET', '/votes?period=month&cursor=1763028000000_clx1abc');
    expect(status).toBe(200);
    expect(service.listReputationVotes.mock.calls[0][1]).toMatchObject({ period: 'month', cursor: '1763028000000_clx1abc' });
    const vote = json.votes[0];
    expect(vote.giverName).toBe('Bob');
    expect(vote.giverAvatarUrl).toBeNull();
    expect(vote.receiverName).toBe('Alice');
    expect(vote.messageUrl).toBe(`https://discord.com/channels/${GUILD}/333333333333333333/444444444444444444`);
    expect(json.nextCursor).toBeNull();
  });

  test('refuse un curseur mal formé', async () => {
    const { status } = await call('GET', '/votes?cursor=v0');
    expect(status).toBe(400);
    expect(service.listReputationVotes).not.toHaveBeenCalled();
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

  test('enregistre paliers et salon d\'annonce', async () => {
    cacheGuild([ROLE]);
    const tiers = [{ threshold: 10, roleId: ROLE }];
    const { status } = await call('PATCH', '/config', { tiers, announceChannelId: '333333333333333333' });
    expect(status).toBe(200);
    expect(service.saveReputationConfig.mock.calls[0][1]).toEqual({ tiers, announceChannelId: '333333333333333333' });
  });

  test('refuse des paliers mal formés', async () => {
    const { status } = await call('PATCH', '/config', { tiers: [{ threshold: 5, roleId: ROLE }, { threshold: 5, roleId: '666666666666666666' }] });
    expect(status).toBe(400);
  });

  test('refuse un rôle absent du serveur', async () => {
    cacheGuild([]);
    const { status } = await call('PATCH', '/config', { tiers: [{ threshold: 5, roleId: ROLE }] });
    expect(status).toBe(400);
  });

  test('refuse @everyone comme rôle de palier', async () => {
    const { status } = await call('PATCH', '/config', { tiers: [{ threshold: 5, roleId: GUILD }] });
    expect(status).toBe(400);
  });

  test('refuse un salon d\'annonce mal formé, accepte null', async () => {
    expect((await call('PATCH', '/config', { announceChannelId: 'abc' })).status).toBe(400);
    expect((await call('PATCH', '/config', { announceChannelId: null })).status).toBe(200);
  });

  test('enregistre les gains par remerciement', async () => {
    const { status } = await call('PATCH', '/config', { xpPerRep: 25, coinsPerRep: 100 });
    expect(status).toBe(200);
    expect(service.saveReputationConfig.mock.calls[0][1]).toEqual({ xpPerRep: 25, coinsPerRep: 100 });
  });

  test('refuse des gains négatifs ou au-delà des bornes', async () => {
    for (const body of [{ xpPerRep: -1 }, { xpPerRep: 501 }, { coinsPerRep: 10_001 }, { coinsPerRep: 1.5 }]) {
      expect((await call('PATCH', '/config', body)).status).toBe(400);
    }
    expect(service.saveReputationConfig).not.toHaveBeenCalled();
  });

  test('réduit un emoji custom à son id', async () => {
    const { status } = await call('PATCH', '/config', { reactionEnabled: true, reactionEmoji: '<:merci:123456789012345678>' });
    expect(status).toBe(200);
    expect(service.saveReputationConfig.mock.calls[0][1]).toEqual({ reactionEnabled: true, reactionEmoji: '123456789012345678' });
  });

  test('refuse d\'allumer la réaction sans emoji', async () => {
    const { status } = await call('PATCH', '/config', { reactionEnabled: true });
    expect(status).toBe(400);
    expect(service.saveReputationConfig).not.toHaveBeenCalled();
  });

  test('accepte d\'allumer la réaction quand un emoji est déjà réglé', async () => {
    currentSettings = { ...SETTINGS, reactionEmoji: '🙏' };
    expect((await call('PATCH', '/config', { reactionEnabled: true })).status).toBe(200);
  });

  test('refuse un texte à la place d\'un emoji', async () => {
    expect((await call('PATCH', '/config', { reactionEmoji: 'merci beaucoup' })).status).toBe(400);
  });

  test('enregistre les garde-fous', async () => {
    const body = {
      minAccountAgeDays: 7,
      minMemberDays: 2,
      sameMemberCooldownDays: 3,
      excludedRoleIds: ['666666666666666666', '666666666666666666'],
      excludedChannelIds: ['333333333333333333'],
    };
    const { status } = await call('PATCH', '/config', body);
    expect(status).toBe(200);
    expect(service.saveReputationConfig.mock.calls[0][1]).toEqual({ ...body, excludedRoleIds: ['666666666666666666'] });
  });

  test('refuse des garde-fous hors bornes', async () => {
    for (const body of [
      { minAccountAgeDays: -1 },
      { minAccountAgeDays: 366 },
      { minMemberDays: 1.5 },
      { sameMemberCooldownDays: 0 },
      { sameMemberCooldownDays: 31 },
      { excludedRoleIds: ['abc'] },
      { excludedChannelIds: 'c' },
      { excludedRoleIds: Array.from({ length: 26 }, (_, i) => `1000000000000000${String(i).padStart(2, '0')}`) },
    ]) {
      expect((await call('PATCH', '/config', body)).status).toBe(400);
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
    expect(actions.revokeRep.mock.calls[0]).toEqual([client, GUILD, 'v1']);
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test('le journal nomme donneur et receveur, identifiant entre parenthèses', async () => {
    deletedVote = { id: 'v1', guildId: GUILD, giverId: '222222222222222222', receiverId: '111111111111111111' };
    await call('DELETE', '/votes/v1');
    const entry = (mockDb.dashboardAuditLog.create.mock.calls[0][0] as { data: { details: string } }).data;
    expect(entry.details).toBe('Vote de Bob (222222222222222222) pour Alice (111111111111111111) retiré.');
  });

  test('un membre parti reste désigné par son identifiant', async () => {
    deletedVote = { id: 'v1', guildId: GUILD, giverId: '777777777777777777', receiverId: '111111111111111111' };
    await call('DELETE', '/votes/v1');
    const entry = (mockDb.dashboardAuditLog.create.mock.calls[0][0] as { data: { details: string } }).data;
    expect(entry.details).toBe('Vote de 777777777777777777 pour Alice (111111111111111111) retiré.');
  });

  test('le retrait d\'un ajustement est journalisé comme tel', async () => {
    deletedVote = { id: 'v2', guildId: GUILD, kind: 'ADJUSTMENT', value: -5, giverId: '222222222222222222', receiverId: '111111111111111111' };
    await call('DELETE', '/votes/v2');
    const entry = (mockDb.dashboardAuditLog.create.mock.calls[0][0] as { data: { details: string } }).data;
    expect(entry.details).toBe('Ajustement de -5 point(s) pour Alice (111111111111111111) retiré.');
  });

  test('404 pour un vote inconnu', async () => {
    const { status } = await call('DELETE', '/votes/absent');
    expect(status).toBe(404);
  });

  test('refuse sans le droit de gérer les réglages', async () => {
    const { status } = await call('DELETE', '/votes/v1', undefined, DASHBOARD_ACCESS_MODERATOR);
    expect(status).toBe(403);
    expect(actions.revokeRep).not.toHaveBeenCalled();
  });
});

describe('GET /reputation/members/:userId', () => {
  test('rend la réputation du membre, avec les noms de qui l\'a remercié', async () => {
    const { status, json } = await call('GET', '/members/111111111111111111');
    expect(status).toBe(200);
    expect(service.getMemberReputationSummary.mock.calls[0]).toEqual([GUILD, '111111111111111111']);
    expect(json.totalRep).toBe(6);
    expect(json.rank).toBe(2);
    expect(json.recent[0].giverName).toBe('Bob');
  });

  test('refuse un identifiant mal formé', async () => {
    expect((await call('GET', '/members/abc')).status).toBe(400);
    expect(service.getMemberReputationSummary).not.toHaveBeenCalled();
  });
});

describe('POST /reputation/adjustments', () => {
  const MEMBER = '111111111111111111';

  test('ajuste, journalise et rend l\'ancien et le nouveau total', async () => {
    const { status, json } = await call('POST', '/adjustments', { userId: MEMBER, amount: 5, reason: '  Aide à l\'événement  ' });
    expect(status).toBe(200);
    expect(actions.adjustRep.mock.calls[0]).toEqual([client, { guildId: GUILD, staffId: 'user-1', userId: MEMBER, amount: 5, reason: 'Aide à l\'événement' }]);
    expect(json).toEqual({ before: 4, after: 9 });
    const entry = (mockDb.dashboardAuditLog.create.mock.calls[0][0] as { data: { details: string } }).data;
    expect(entry.details).toContain('Alice (111111111111111111)');
    expect(entry.details).toContain('+5');
  });

  test('un motif vide est enregistré comme absent', async () => {
    await call('POST', '/adjustments', { userId: MEMBER, amount: -2, reason: '   ' });
    expect((actions.adjustRep.mock.calls[0][1] as { reason: unknown }).reason).toBeNull();
  });

  test('refuse un montant nul, non entier ou hors bornes', async () => {
    for (const amount of [0, 1.5, 1001, -1001, '3']) {
      expect((await call('POST', '/adjustments', { userId: MEMBER, amount })).status).toBe(400);
    }
    expect(actions.adjustRep).not.toHaveBeenCalled();
  });

  test('refuse un membre mal formé ou un motif trop long', async () => {
    expect((await call('POST', '/adjustments', { userId: 'abc', amount: 1 })).status).toBe(400);
    expect((await call('POST', '/adjustments', { userId: MEMBER, amount: 1, reason: 'x'.repeat(201) })).status).toBe(400);
    expect(actions.adjustRep).not.toHaveBeenCalled();
  });

  test('un retrait sous zéro est refusé avec le total actuel', async () => {
    adjustResult = { success: false, code: 'BELOW_ZERO', total: 2 };
    const { status, json } = await call('POST', '/adjustments', { userId: MEMBER, amount: -5 });
    expect(status).toBe(409);
    expect(json.total).toBe(2);
    expect(mockDb.dashboardAuditLog.create).not.toHaveBeenCalled();
  });

  test('refuse sans le droit de gérer les réglages', async () => {
    expect((await call('POST', '/adjustments', { userId: MEMBER, amount: 1 }, DASHBOARD_ACCESS_MODERATOR)).status).toBe(403);
    expect(actions.adjustRep).not.toHaveBeenCalled();
  });
});

describe('POST /reputation/reset', () => {
  test('remet un membre à zéro et journalise', async () => {
    const { status, json } = await call('POST', '/reset', { scope: 'member', userId: '111111111111111111' });
    expect(status).toBe(200);
    expect(actions.resetMemberRep.mock.calls[0]).toEqual([client, GUILD, '111111111111111111']);
    expect(json).toEqual({ removed: 3 });
    const entry = (mockDb.dashboardAuditLog.create.mock.calls[0][0] as { data: { details: string } }).data;
    expect(entry.details).toContain('Alice (111111111111111111)');
  });

  test('remet tout le serveur à zéro et journalise', async () => {
    const { status, json } = await call('POST', '/reset', { scope: 'guild' });
    expect(status).toBe(200);
    expect(actions.resetGuildRep.mock.calls[0]).toEqual([client, GUILD]);
    expect(json).toEqual({ removed: 12, members: 4 });
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test('refuse une portée inconnue ou un membre mal formé', async () => {
    expect((await call('POST', '/reset', {})).status).toBe(400);
    expect((await call('POST', '/reset', { scope: 'member', userId: 'abc' })).status).toBe(400);
    expect(actions.resetMemberRep).not.toHaveBeenCalled();
    expect(actions.resetGuildRep).not.toHaveBeenCalled();
  });

  test('refuse sans le droit de gérer les réglages', async () => {
    expect((await call('POST', '/reset', { scope: 'guild' }, DASHBOARD_ACCESS_MODERATOR)).status).toBe(403);
    expect(actions.resetGuildRep).not.toHaveBeenCalled();
  });
});

test('ignore les autres segments', async () => {
  const { req, url, parts } = request('GET', `/api/dashboard/guilds/${GUILD}/drops`);
  expect(await handleReputationRoutes(req, response(), parts, url, client, user, GUILD, DASHBOARD_ACCESS_ADMIN)).toBe(false);
});

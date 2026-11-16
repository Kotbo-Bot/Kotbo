/**
 * Routes dashboard du module Suggestions.
 *
 * Préfixe `zzz-` : ce fichier remplace les services de suggestions,
 * `memberIdentityService` et `featureGate` pour tout le process (`mock.module`
 * est global). Il doit charger après les tests de ces modules.
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

function mockModule(relative: string, implementation: Record<string, unknown>) {
  const source = path.resolve(__dirname, `${relative}.ts`);
  for (const suffix of ['.ts', '.js']) {
    mock.module(path.resolve(__dirname, `${relative}${suffix}`), () => completeModuleMock(source, implementation));
  }
}

const GUILD = '999999999999999999';
const ALICE = '111111111111111111';
const BOB = '222222222222222222';
const ROLE = '555555555555555555';
const SUGGESTION_ID = 'clsuggestion0000000000001';

const ROW = {
  id: SUGGESTION_ID,
  guildId: GUILD,
  userId: ALICE,
  username: 'alice_old',
  content: 'Un salon memes',
  status: 'PENDING',
  channelId: '333333333333333333',
  messageId: '444444444444444444',
  responseText: null as string | null,
  respondedById: null as string | null,
  respondedAt: null as Date | null,
  upvoters: [BOB, '666666666666666666'],
  downvoters: [ALICE],
  createdAt: new Date('2026-11-10T10:00:00Z'),
  updatedAt: new Date('2026-11-10T10:00:00Z'),
};

const SETTINGS = { channelId: null as string | null, requireComment: true, voteWhileApproved: false, allowedRoleIds: [] as string[] };
let currentSettings = { ...SETTINGS };

const dashboard = {
  getSuggestionsOverview: mock(async (_guildId: string) => ({
    config: currentSettings,
    stats: { pending: 1, stalePending: 0, createdRecent: 3, resolvedRecent: 2, acceptanceRate: 0.5, avgResponseHours: 4, lastCreatedAt: ROW.createdAt },
    queue: [ROW],
    queueTruncated: false,
  })),
  listSuggestions: mock(async (_guildId: string, _filter: unknown) => ({ suggestions: [ROW], nextCursor: null })),
};
mockModule('../../services/features/suggestionDashboard', dashboard);

const settings = {
  getSuggestionSettings: mock(async (_guildId: string) => currentSettings),
  saveSuggestionSettings: mock(async (_guildId: string, patch: Record<string, unknown>) => ({ ...currentSettings, ...patch })),
};
mockModule('../../services/features/suggestionSettings', settings);

let resolveResult: unknown = null;
const service = {
  resolveSuggestion: mock(async (..._args: unknown[]) => resolveResult),
};
mockModule('../../services/features/suggestionService', service);

mockModule('../../services/features/suggestionMessageLabels', {
  suggestionMessageLabels: mock((locale: string) => ({ locale, title: 'T' })),
});

mockModule('../../services/moderation/memberIdentityService', {
  getMemberIdentities: mock(async () => new Map([
    [ALICE, { displayName: 'Alice', avatarUrl: 'a.png' }],
    [BOB, { displayName: 'Bob', avatarUrl: '' }],
  ])),
});

let featureRights: Record<string, unknown> = {};
mockModule('../../api/routes/dashboard/featureGate', {
  getCachedFeatureAccess: mock(async () => featureRights),
});

const { handleSuggestionRoutes, parseSuggestionConfigPatch } = await import('../../api/routes/dashboard/suggestions.js');

const guilds = new Map<string, unknown>();
const client = { guilds: { cache: guilds } } as unknown as Client;
function cacheGuild(roleIds: string[]) {
  guilds.set(GUILD, { preferredLocale: 'fr', roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } });
}
const user: AuthClaims = { userId: BOB, username: 'Bob' } as AuthClaims;

interface MockResponse extends ServerResponse { body: string }

function request(method: string, pathAndQuery: string, body?: unknown) {
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
  const { req, url, parts } = request(method, `/api/dashboard/guilds/${GUILD}/suggestions${suffix}`, body);
  const res = response();
  const handled = await handleSuggestionRoutes(req, res, parts, url, client, user, GUILD, access);
  return { handled, status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
  currentSettings = { ...SETTINGS };
  resolveResult = null;
  featureRights = {};
  guilds.clear();
  for (const fn of [...Object.values(dashboard), ...Object.values(settings), ...Object.values(service)]) {
    (fn as { mockClear: () => void }).mockClear();
  }
  mockDb.dashboardAuditLog.create.mockClear();
});

describe('GET /suggestions', () => {
  test('rend réglages, statistiques, file et gabarits du message', async () => {
    const { status, json } = await call('GET', '');
    expect(status).toBe(200);
    expect(json.config).toEqual(SETTINGS);
    expect(json.stats.pending).toBe(1);
    expect(json.queueTruncated).toBe(false);
    expect(json.messageLabels.title).toBe('T');
  });

  test('compteurs à la place des votants, identité actuelle et lien du message', async () => {
    const { json } = await call('GET', '');
    const [item] = json.queue;
    expect(item.upvotes).toBe(2);
    expect(item.downvotes).toBe(1);
    expect(item.upvoters).toBeUndefined();
    expect(item.username).toBe('Alice');
    expect(item.avatarUrl).toBe('a.png');
    expect(item.messageUrl).toBe(`https://discord.com/channels/${GUILD}/${ROW.channelId}/${ROW.messageId}`);
  });
});

describe('GET /suggestions/list', () => {
  test('transmet statut, membre et curseur', async () => {
    const { status } = await call('GET', `/list?status=APPROVED&userId=${ALICE}&cursor=1700000000000_abc`);
    expect(status).toBe(200);
    expect(dashboard.listSuggestions).toHaveBeenCalledWith(GUILD, { status: 'APPROVED', userId: ALICE, cursor: '1700000000000_abc' });
  });

  test('refuse un statut inconnu', async () => {
    expect((await call('GET', '/list?status=CLOSED')).status).toBe(400);
  });

  test('refuse un membre ou un curseur mal formé', async () => {
    expect((await call('GET', '/list?userId=abc')).status).toBe(400);
    expect((await call('GET', '/list?cursor=nope')).status).toBe(400);
    expect(dashboard.listSuggestions).not.toHaveBeenCalled();
  });
});

describe('PATCH /suggestions/config', () => {
  test('enregistre et journalise', async () => {
    cacheGuild([ROLE]);
    const { status, json } = await call('PATCH', '/config', { requireComment: false, allowedRoleIds: [ROLE, ROLE] });
    expect(status).toBe(200);
    expect(settings.saveSuggestionSettings).toHaveBeenCalledWith(GUILD, { requireComment: false, allowedRoleIds: [ROLE] });
    expect(json.config.requireComment).toBe(false);
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test('réservé à qui configure', async () => {
    const { status } = await call('PATCH', '/config', { requireComment: false }, DASHBOARD_ACCESS_MODERATOR);
    expect(status).toBe(403);
    expect(settings.saveSuggestionSettings).not.toHaveBeenCalled();
  });

  test('refuse un corps vide', async () => {
    expect((await call('PATCH', '/config', {})).status).toBe(400);
  });
});

describe('validation des réglages', () => {
  const roles = new Set([ROLE]);

  test('salon : identifiant ou null', () => {
    expect(parseSuggestionConfigPatch({ channelId: null }, GUILD, roles)).toEqual({ patch: { channelId: null } });
    expect(parseSuggestionConfigPatch({ channelId: ' 333333333333333333 ' }, GUILD, roles)).toEqual({ patch: { channelId: '333333333333333333' } });
    expect('error' in parseSuggestionConfigPatch({ channelId: 'general' }, GUILD, roles)).toBe(true);
  });

  test('options : booléens seulement', () => {
    expect('error' in parseSuggestionConfigPatch({ voteWhileApproved: 'yes' }, GUILD, roles)).toBe(true);
  });

  test('rôles : ni @everyone, ni rôle absent', () => {
    expect('error' in parseSuggestionConfigPatch({ allowedRoleIds: [GUILD] }, GUILD, roles)).toBe(true);
    expect('error' in parseSuggestionConfigPatch({ allowedRoleIds: ['777777777777777777'] }, GUILD, roles)).toBe(true);
  });

  test('rôles : non vérifiables hors du cache, acceptés', () => {
    expect(parseSuggestionConfigPatch({ allowedRoleIds: ['777777777777777777'] }, GUILD, null)).toEqual({ patch: { allowedRoleIds: ['777777777777777777'] } });
  });
});

describe('POST /suggestions/:id/resolve', () => {
  const decided = { ...ROW, status: 'APPROVED', responseText: 'Bonne idée', respondedById: BOB, respondedAt: new Date('2026-11-11T10:00:00Z') };

  test('tranche, journalise et rend la suggestion présentée', async () => {
    resolveResult = { suggestion: decided, previousStatus: 'PENDING' };
    const { status, json } = await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'APPROVED', responseText: '  Bonne idée  ' });
    expect(status).toBe(200);
    expect(service.resolveSuggestion).toHaveBeenCalledWith(GUILD, SUGGESTION_ID, 'APPROVED', 'Bonne idée', BOB, client);
    expect(json.suggestion.status).toBe('APPROVED');
    expect(json.suggestion.respondedByName).toBe('Bob');
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test('commentaire exigé par le serveur', async () => {
    const { status } = await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'REJECTED', responseText: '   ' });
    expect(status).toBe(400);
    expect(service.resolveSuggestion).not.toHaveBeenCalled();
  });

  test('commentaire facultatif quand le serveur le permet', async () => {
    currentSettings = { ...SETTINGS, requireComment: false };
    resolveResult = { suggestion: { ...decided, status: 'REJECTED', responseText: null }, previousStatus: 'PENDING' };
    const { status } = await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'REJECTED' });
    expect(status).toBe(200);
    expect(service.resolveSuggestion).toHaveBeenCalledWith(GUILD, SUGGESTION_ID, 'REJECTED', null, BOB, client);
  });

  test('rouvrir ne demande pas de commentaire', async () => {
    resolveResult = { suggestion: ROW, previousStatus: 'APPROVED' };
    expect((await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'PENDING' })).status).toBe(200);
  });

  test('refuse un statut inconnu ou un commentaire trop long', async () => {
    expect((await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'DONE', responseText: 'x' })).status).toBe(400);
    expect((await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'APPROVED', responseText: 'x'.repeat(1001) })).status).toBe(400);
  });

  test('404 pour une suggestion d\'un autre serveur', async () => {
    expect((await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'APPROVED', responseText: 'ok' })).status).toBe(404);
  });

  test('un modérateur de contenu tranche sans droit de configuration', async () => {
    resolveResult = { suggestion: decided, previousStatus: 'PENDING' };
    const access = { ...DASHBOARD_ACCESS_MODERATOR, canModerateContent: true };
    expect((await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'APPROVED', responseText: 'ok' }, access)).status).toBe(200);
  });

  test('pas quand le centre de gestion lui a retiré « Modérer »', async () => {
    featureRights = { suggestions: { canView: true, canModerate: false } };
    const access = { ...DASHBOARD_ACCESS_MODERATOR, canModerateContent: true };
    expect((await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'APPROVED', responseText: 'ok' }, access)).status).toBe(403);
    expect(service.resolveSuggestion).not.toHaveBeenCalled();
  });

  test('un rôle sans modération passe par le droit explicite', async () => {
    featureRights = { suggestions: { canView: true, canModerate: true } };
    resolveResult = { suggestion: decided, previousStatus: 'PENDING' };
    const access = { ...DASHBOARD_ACCESS_MODERATOR, canModerateContent: false };
    expect((await call('POST', `/${SUGGESTION_ID}/resolve`, { status: 'APPROVED', responseText: 'ok' }, access)).status).toBe(200);
  });
});

test('laisse passer les autres segments', async () => {
  const { req, url, parts } = request('GET', `/api/dashboard/guilds/${GUILD}/reputation`);
  expect(await handleSuggestionRoutes(req, response(), parts, url, client, user, GUILD, DASHBOARD_ACCESS_ADMIN)).toBe(false);
});

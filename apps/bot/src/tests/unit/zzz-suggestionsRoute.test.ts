/**
 * Routes dashboard du module Suggestions.
 *
 * Préfixe `zzz-` : ce fichier remplace les services de suggestions,
 * `memberIdentityService` et `featureGate` pour tout le process (`mock.module`
 * est global). Il doit charger après les tests de ces modules.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, DASHBOARD_ACCESS_MODERATOR, type AuthClaims, type DashboardAccess } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';

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
  title: 'Salon memes' as string | null,
  threadId: '777777777777777777' as string | null,
  thresholdReachedAt: null as Date | null,
  category: 'Salons' as string | null,
  xpGranted: 0,
  coinsGranted: 0,
  responseText: null as string | null,
  respondedById: null as string | null,
  respondedAt: null as Date | null,
  upvoters: [BOB, '666666666666666666'],
  downvoters: [ALICE],
  createdAt: new Date('2026-11-10T10:00:00Z'),
  updatedAt: new Date('2026-11-10T10:00:00Z'),
};

let voterRow: { upvoters: string[]; downvoters: string[] } | null = null;
const SETTINGS = {
  channelId: null as string | null,
  requireComment: true,
  voteWhileApproved: false,
  allowedRoleIds: [] as string[],
  cooldownMinutes: 0,
  minAccountAgeDays: 0,
  minMemberDays: 0,
  notifyAuthor: true,
  createThread: false,
  voteThreshold: null as number | null,
  pinAtThreshold: false,
  rewardXp: 0,
  rewardCoins: 0,
  categories: [] as string[],
  showVoters: false,
};
let currentSettings = { ...SETTINGS };

const dashboard = {
  getSuggestionsOverview: mock(async (_guildId: string) => ({
    config: currentSettings,
    stats: { pending: 1, stalePending: 0, createdRecent: 3, resolvedRecent: 2, acceptanceRate: 0.5, avgResponseHours: 4, lastCreatedAt: ROW.createdAt },
    queue: [ROW],
    queueTruncated: false,
    categoryStats: [{ category: 'Salons', total: 1, pending: 1, accepted: 0 }],
  })),
  listSuggestions: mock(async (_guildId: string, _filter: unknown) => ({ suggestions: [ROW], nextCursor: null })),
  getSuggestionVoters: mock(async (_guildId: string, _id: string) => voterRow),
};
mockModule('../../services/features/suggestionDashboard', dashboard);

const settings = {
  getSuggestionSettings: mock(async (_guildId: string) => currentSettings),
  saveSuggestionSettings: mock(async (_guildId: string, patch: Record<string, unknown>) => ({ ...currentSettings, ...patch })),
};
mockModule('../../services/features/suggestionSettings', settings);

let resolveResult: unknown = null;
let deleteResult: unknown = null;
const service = {
  resolveSuggestion: mock(async (..._args: unknown[]) => resolveResult),
  deleteSuggestion: mock(async (..._args: unknown[]) => deleteResult),
  refreshPublishedSuggestionMessages: mock(async (..._args: unknown[]) => 3),
  countPublishedSuggestionMessages: mock(async (..._args: unknown[]) => 3),
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

mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: BOB, username: 'Bob' } as AuthClaims);
const { createSuggestionsRouter, parseSuggestionConfigPatch } = await import('../../api/routes/dashboard/suggestions.js');

const guilds = new Map<string, unknown>();
const client = { guilds: { cache: guilds } } as unknown as Client;
function cacheGuild(roleIds: string[]) {
  guilds.set(GUILD, { preferredLocale: 'fr', roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } });
}
const user: AuthClaims = { userId: BOB, username: 'Bob' } as AuthClaims;

async function call(method: string, suffix: string, body?: unknown, access: DashboardAccess = DASHBOARD_ACCESS_ADMIN) {
  setDashboardAccess(access, user);
  const { status, body: json } = await dashboardCall(createSuggestionsRouter(client), method, `/api/dashboard/guilds/${GUILD}/suggestions${suffix}`, body);
  return { status, json };
}

beforeEach(() => {
  currentSettings = { ...SETTINGS };
  resolveResult = null;
  deleteResult = null;
  voterRow = null;
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

  test('catégorie, récompense versée et bilan par catégorie', async () => {
    const { json } = await call('GET', '');
    expect(json.queue[0].category).toBe('Salons');
    expect(json.queue[0].rewarded).toEqual({ xp: 0, coins: 0 });
    expect(json.categoryStats).toEqual([{ category: 'Salons', total: 1, pending: 1, accepted: 0 }]);
  });

  test('titre, lien du fil et seuil atteint', async () => {
    const { json } = await call('GET', '');
    const [item] = json.queue;
    expect(item.title).toBe('Salon memes');
    expect(item.threadUrl).toBe(`https://discord.com/channels/${GUILD}/${ROW.threadId}`);
    expect(item.thresholdReachedAt).toBeNull();
  });
});

describe('GET /suggestions/list', () => {
  test('transmet statut, membre et curseur', async () => {
    const { status } = await call('GET', `/list?status=APPROVED&userId=${ALICE}&cursor=1700000000000_abc`);
    expect(status).toBe(200);
    expect(dashboard.listSuggestions).toHaveBeenCalledWith(GUILD, { status: 'APPROVED', userId: ALICE, cursor: '1700000000000_abc', category: undefined });
  });

  test('filtre par catégorie, « none » pour celles qui n\'en ont pas', async () => {
    await call('GET', '/list?category=Salons');
    expect(dashboard.listSuggestions).toHaveBeenLastCalledWith(GUILD, { status: undefined, userId: undefined, cursor: undefined, category: 'Salons' });
    await call('GET', '/list?category=none');
    expect(dashboard.listSuggestions).toHaveBeenLastCalledWith(GUILD, { status: undefined, userId: undefined, cursor: undefined, category: null });
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

  test('changer l\'ouverture des votes redessine les suggestions approuvées', async () => {
    await call('PATCH', '/config', { voteWhileApproved: true });
    expect(service.refreshPublishedSuggestionMessages).toHaveBeenCalledWith(client, GUILD, { status: 'APPROVED' });
  });

  test('sans changement de cette option, aucun message n\'est redessiné', async () => {
    await call('PATCH', '/config', { voteWhileApproved: false });
    await call('PATCH', '/config', { requireComment: false });
    expect(service.refreshPublishedSuggestionMessages).not.toHaveBeenCalled();
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

  test('options de la communauté : booléens', () => {
    expect(parseSuggestionConfigPatch({ notifyAuthor: false, createThread: true, pinAtThreshold: true }, GUILD, roles))
      .toEqual({ patch: { notifyAuthor: false, createThread: true, pinAtThreshold: true } });
    expect('error' in parseSuggestionConfigPatch({ createThread: 1 }, GUILD, roles)).toBe(true);
  });

  test('seuil : entier dans les bornes, ou null pour l\'enlever', () => {
    expect(parseSuggestionConfigPatch({ voteThreshold: 10 }, GUILD, roles)).toEqual({ patch: { voteThreshold: 10 } });
    expect(parseSuggestionConfigPatch({ voteThreshold: null }, GUILD, roles)).toEqual({ patch: { voteThreshold: null } });
    expect('error' in parseSuggestionConfigPatch({ voteThreshold: 1 }, GUILD, roles)).toBe(true);
    expect('error' in parseSuggestionConfigPatch({ voteThreshold: 2.5 }, GUILD, roles)).toBe(true);
  });

  test('garde-fous : entiers dans les bornes', () => {
    expect(parseSuggestionConfigPatch({ cooldownMinutes: 60, minAccountAgeDays: 7, minMemberDays: 0 }, GUILD, roles))
      .toEqual({ patch: { cooldownMinutes: 60, minAccountAgeDays: 7, minMemberDays: 0 } });
    expect('error' in parseSuggestionConfigPatch({ cooldownMinutes: -1 }, GUILD, roles)).toBe(true);
    expect('error' in parseSuggestionConfigPatch({ minMemberDays: 400 }, GUILD, roles)).toBe(true);
  });

  test('récompense : entiers dans les bornes', () => {
    expect(parseSuggestionConfigPatch({ rewardXp: 100, rewardCoins: 500 }, GUILD, roles)).toEqual({ patch: { rewardXp: 100, rewardCoins: 500 } });
    expect('error' in parseSuggestionConfigPatch({ rewardXp: 999_999 }, GUILD, roles)).toBe(true);
  });

  test('catégories : nettoyées, refusées au-delà des limites', () => {
    expect(parseSuggestionConfigPatch({ categories: [' Bot ', 'bot', 'Salons'] }, GUILD, roles)).toEqual({ patch: { categories: ['Bot', 'Salons'] } });
    expect('error' in parseSuggestionConfigPatch({ categories: ['x'.repeat(40)] }, GUILD, roles)).toBe(true);
  });

  test('votants visibles : booléen', () => {
    expect(parseSuggestionConfigPatch({ showVoters: true }, GUILD, roles)).toEqual({ patch: { showVoters: true } });
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

describe('DELETE /suggestions/:id', () => {
  test('supprime et journalise', async () => {
    deleteResult = ROW;
    const { status, json } = await call('DELETE', `/${SUGGESTION_ID}`);
    expect(status).toBe(200);
    expect(json).toEqual({ deleted: true });
    expect(service.deleteSuggestion).toHaveBeenCalledWith(client, GUILD, SUGGESTION_ID);
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalledTimes(1);
  });

  test('404 pour une suggestion d\'un autre serveur', async () => {
    expect((await call('DELETE', `/${SUGGESTION_ID}`)).status).toBe(404);
  });

  test('réservé à qui peut supprimer', async () => {
    expect((await call('DELETE', `/${SUGGESTION_ID}`, undefined, DASHBOARD_ACCESS_MODERATOR)).status).toBe(403);
    expect(service.deleteSuggestion).not.toHaveBeenCalled();
  });
});

describe('GET /suggestions/:id/voters', () => {
  test('fermé tant que le serveur ne montre pas les votants', async () => {
    expect((await call('GET', `/${SUGGESTION_ID}/voters`)).status).toBe(403);
  });

  test('pour et contre, avec pseudo et photo', async () => {
    currentSettings = { ...SETTINGS, showVoters: true };
    voterRow = ROW;
    const { status, json } = await call('GET', `/${SUGGESTION_ID}/voters`);
    expect(status).toBe(200);
    expect(json.up.map((v: { userId: string }) => v.userId)).toEqual([BOB, '666666666666666666']);
    expect(json.up[0]).toEqual({ userId: BOB, name: 'Bob', avatarUrl: null });
    expect(json.down).toEqual([{ userId: ALICE, name: 'Alice', avatarUrl: 'a.png' }]);
  });

  test('404 pour une suggestion d\'un autre serveur', async () => {
    currentSettings = { ...SETTINGS, showVoters: true };
    expect((await call('GET', `/${SUGGESTION_ID}/voters`)).status).toBe(404);
  });

  test('réservé à qui peut trancher', async () => {
    currentSettings = { ...SETTINGS, showVoters: true };
    featureRights = { suggestions: { canView: true, canModerate: false } };
    expect((await call('GET', `/${SUGGESTION_ID}/voters`, undefined, DASHBOARD_ACCESS_MODERATOR)).status).toBe(403);
  });
});

describe('POST /suggestions/refresh', () => {
  test('lance la mise à jour des messages et dit combien seront repris', async () => {
    const { status, json } = await call('POST', '/refresh');
    expect(status).toBe(202);
    expect(json).toEqual({ total: 3 });
    expect(service.refreshPublishedSuggestionMessages).toHaveBeenCalledWith(client, GUILD);
  });

  test('réservé à qui configure', async () => {
    expect((await call('POST', '/refresh', undefined, DASHBOARD_ACCESS_MODERATOR)).status).toBe(403);
  });
});

test('laisse passer les autres segments', async () => {
  expect((await dashboardCall(createSuggestionsRouter(client), 'GET', `/api/dashboard/guilds/${GUILD}/reputation`)).status).toBe(404);
});

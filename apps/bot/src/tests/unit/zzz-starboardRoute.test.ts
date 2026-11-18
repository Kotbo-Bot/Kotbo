/**
 * Routes dashboard de Starlight (messages à la une).
 *
 * Préfixe `zzz-` : ce fichier remplace les services de Starlight,
 * `memberIdentityService` et `featureGate` pour tout le process (`mock.module` est global). Il
 * doit charger après les tests de ces modules.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DEFAULT_STARBOARD_CONFIG } from '@kotbo/shared';
import { DASHBOARD_ACCESS_ADMIN, DASHBOARD_ACCESS_MODERATOR, type AuthClaims, type DashboardAccess } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { normalizeEmojiKey } from '../../services/features/starboardTally.js';

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
const CHANNEL = '333333333333333333';
const STAR_CHANNEL = '444444444444444444';

const ENTRY = {
  id: 'clentry00000000000000001',
  guildId: GUILD,
  channelId: CHANNEL,
  messageId: '555555555555555555',
  authorId: ALICE,
  starMessageId: '666666666666666666' as string | null,
  starChannelId: STAR_CHANNEL as string | null,
  upvotes: 9,
  downvotes: 2,
  score: 7,
  peakScore: 11,
  excerpt: 'Un très bon message' as string | null,
  imageUrl: null as string | null,
  postedAt: new Date('2026-11-10T10:05:00Z') as Date | null,
  blockedAt: null as Date | null,
  blockedById: null as string | null,
  createdAt: new Date('2026-11-10T10:00:00Z'),
  updatedAt: new Date('2026-11-10T10:05:00Z'),
};

const SETTINGS = { ...structuredClone({ ...DEFAULT_STARBOARD_CONFIG }), channelId: STAR_CHANNEL };
let currentSettings = structuredClone(SETTINGS);

const dashboard = {
  getStarboardOverview: mock(async (_guildId: string) => ({
    stats: { postedRecent: 3, avgPeakRecent: 8.5, bestPeakRecent: 11, onBoard: 2, lastPostedAt: ENTRY.createdAt },
    topEntries: [ENTRY],
    channelStats: [{ channelId: CHANNEL, count: 3 }],
    topAuthors: [{ authorId: ALICE, count: 3, bestScore: 11 }],
  })),
  listStarboardEntries: mock(async (_guildId: string, _filter: unknown) => ({ entries: [ENTRY], nextCursor: null })),
};
mockModule('../../services/features/starboardDashboard', dashboard);

const settings = {
  getStarboardSettings: mock(async (_guildId: string) => currentSettings),
  saveStarboardSettings: mock(async (_guildId: string, patch: Record<string, unknown>) => ({ ...currentSettings, ...patch })),
};
mockModule('../../services/features/starboardSettings', settings);

let health = { channelFound: true as boolean | null, missingPermissions: [] as string[] };
mockModule('../../services/features/starboardHealth', {
  starboardChannelHealth: mock(() => health),
});

mockModule('../../services/features/starboardMessageLabels', {
  starboardMessageLabels: mock((locale: string) => ({ locale, jumpButton: 'Aller au message' })),
});

let serviceEntry: typeof ENTRY | null = ENTRY;
const service = {
  blockStarboardEntry: mock(async (..._args: unknown[]) => serviceEntry),
  unblockStarboardEntry: mock(async (..._args: unknown[]) => serviceEntry),
  removeHighlightsOfAuthors: mock(async (..._args: unknown[]) => 0),
  // Réexporté par le service : le module doublé le remplacerait sinon par un piège.
  normalizeEmojiKey: mock(normalizeEmojiKey),
};
mockModule('../../services/features/starboardService', service);

let featureRights: Record<string, unknown> = {};
mockModule('../../api/routes/dashboard/featureGate', {
  getCachedFeatureAccess: mock(async () => featureRights),
});

mockModule('../../services/community/reputationTierService', {
  manageableRole: mock((_guild: unknown, roleId: string) => (roleId === '555555555555555555' ? { id: roleId } : null)),
});

mockModule('../../services/moderation/memberIdentityService', {
  getMemberIdentities: mock(async () => new Map([[ALICE, { displayName: 'Alice', avatarUrl: 'a.png' }]])),
});

const { handleStarboardRoutes, parseStarboardConfigPatch } = await import('../../api/routes/dashboard/modules/starboard.js');

const client = { guilds: { cache: new Map([[GUILD, { preferredLocale: 'fr' }]]) } } as unknown as Client;
const user: AuthClaims = { userId: ALICE, username: 'Alice' } as AuthClaims;

interface MockResponse extends ServerResponse { body: string }

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
  const pathAndQuery = `/api/dashboard/guilds/${GUILD}/starboard${suffix}`;
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = pathAndQuery;
  req.headers = { 'content-type': 'application/json' };
  req.push(body === undefined ? '' : JSON.stringify(body));
  req.push(null);
  const url = new URL(pathAndQuery, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const res = response();
  const handled = await handleStarboardRoutes({
    req, res, parts, url, client, user, guildId: GUILD, access, method, auditUser: 'Alice (1)', moduleKey: 'starboard',
  });
  return { handled, status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
  currentSettings = structuredClone(SETTINGS);
  health = { channelFound: true, missingPermissions: [] };
  serviceEntry = ENTRY;
  featureRights = {};
  for (const fn of [...Object.values(dashboard), ...Object.values(settings), ...Object.values(service)]) {
    (fn as { mockClear: () => void }).mockClear();
  }
  mockDb.dashboardAuditLog.create.mockClear();
});

describe('GET /starboard', () => {
  test('rend réglages, statistiques, état du salon et gabarits du message', async () => {
    const { status, json } = await call('GET', '');
    expect(status).toBe(200);
    expect(json.config).toEqual(SETTINGS);
    expect(json.stats.postedRecent).toBe(3);
    expect(json.channelStats).toEqual([{ channelId: CHANNEL, count: 3 }]);
    expect(json.health).toEqual({ channelFound: true, missingPermissions: [] });
    expect(json.messageLabels.jumpButton).toBe('Aller au message');
  });

  test('messages présentés avec l’identité actuelle et les deux liens', async () => {
    const { json } = await call('GET', '');
    const [entry] = json.topEntries;
    expect(entry.authorName).toBe('Alice');
    expect(entry.avatarUrl).toBe('a.png');
    expect(entry.onBoard).toBe(true);
    expect(entry.messageUrl).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/${ENTRY.messageId}`);
    expect(entry.starUrl).toBe(`https://discord.com/channels/${GUILD}/${STAR_CHANNEL}/${ENTRY.starMessageId}`);
    expect(entry.guildId).toBeUndefined();
    expect(entry.blocked).toBe(false);
  });

  test('rôles de palier que le bot ne peut pas donner signalés', async () => {
    currentSettings = { ...currentSettings, tiers: [{ threshold: 5, roleId: '555555555555555555' }, { threshold: 10, roleId: '888888888888888888' }] };
    const { json } = await call('GET', '');
    expect(json.unmanageableTierRoleIds).toEqual(['888888888888888888']);
  });

  test('auteurs du classement présentés avec leur identité', async () => {
    const { json } = await call('GET', '');
    expect(json.topAuthors).toEqual([{ authorId: ALICE, name: 'Alice', avatarUrl: 'a.png', count: 3, bestScore: 11 }]);
  });

  test('membres exclus présentés avec leur identité', async () => {
    currentSettings = { ...currentSettings, blockedUserIds: [ALICE] };
    const { json } = await call('GET', '');
    expect(json.blockedMembers).toEqual([{ userId: ALICE, name: 'Alice', avatarUrl: 'a.png' }]);
  });

  test('message retiré de la une : pas de lien vers le salon des messages à la une', async () => {
    dashboard.listStarboardEntries.mockImplementationOnce(async () => ({
      entries: [{ ...ENTRY, starMessageId: null, starChannelId: null, postedAt: null }],
      nextCursor: null,
    }));
    const { json } = await call('GET', '/entries');
    expect(json.entries[0].onBoard).toBe(false);
    expect(json.entries[0].starUrl).toBeNull();
  });
});

describe('GET /starboard/entries', () => {
  test('transmet les filtres validés', async () => {
    const { status } = await call('GET', `/entries?period=week&sort=score&channelId=${CHANNEL}&authorId=${ALICE}&cursor=11_abc`);
    expect(status).toBe(200);
    expect(dashboard.listStarboardEntries.mock.calls[0]?.[1]).toEqual({
      period: 'week', sort: 'score', channelId: CHANNEL, authorId: ALICE, cursor: '11_abc',
    });
  });

  test('par défaut : tout, du plus récent au plus ancien', async () => {
    await call('GET', '/entries');
    expect(dashboard.listStarboardEntries.mock.calls[0]?.[1]).toEqual({
      period: 'all', sort: 'recent', channelId: undefined, authorId: undefined, cursor: undefined,
    });
  });

  test.each([
    ['?period=year', 'période'],
    ['?sort=oldest', 'tri'],
    ['?channelId=abc', 'salon'],
    ['?authorId=abc', 'membre'],
    ['?sort=score&cursor=1700000000000_abc', 'curseur de date pour le tri au score'],
    ['?cursor=abc', 'curseur illisible'],
  ])('refuse un paramètre invalide (%s, %s)', async (query) => {
    const { status } = await call('GET', `/entries${query}`);
    expect(status).toBe(400);
    expect(dashboard.listStarboardEntries).not.toHaveBeenCalled();
  });
});

describe('PATCH /starboard', () => {
  test('enregistre, journalise et rend la configuration', async () => {
    const { status, json } = await call('PATCH', '', { threshold: 8 });
    expect(status).toBe(200);
    expect(settings.saveStarboardSettings.mock.calls[0]?.[1]).toEqual({ threshold: 8 });
    expect(json.config.threshold).toBe(8);
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalled();
  });

  test('réservé à qui gère les réglages', async () => {
    const { status } = await call('PATCH', '', { threshold: 8 }, DASHBOARD_ACCESS_MODERATOR);
    expect(status).toBe(403);
    expect(settings.saveStarboardSettings).not.toHaveBeenCalled();
  });

  test('refuse un corps invalide sans rien écrire', async () => {
    const { status } = await call('PATCH', '', { threshold: 0 });
    expect(status).toBe(400);
    expect(settings.saveStarboardSettings).not.toHaveBeenCalled();
  });
});

describe('parseStarboardConfigPatch', () => {
  test('salon nettoyé, couleur en majuscules, emoji custom réduit à son id', () => {
    const parsed = parseStarboardConfigPatch({
      channelId: ` ${CHANNEL} `,
      embedColor: '#abcdef',
      upvoteEmojis: ['<:star:123456789012345678>', '⭐', '⭐'],
    });
    expect(parsed).toEqual({ patch: { channelId: CHANNEL, embedColor: '#ABCDEF', upvoteEmojis: ['123456789012345678', '⭐'] } });
  });

  test.each([
    [{}, 'aucun champ'],
    [{ threshold: 1001 }, 'seuil hors bornes'],
    [{ threshold: 2.5 }, 'seuil non entier'],
    [{ allowBots: 'oui' }, 'booléen attendu'],
    [{ embedColor: 'rouge' }, 'couleur'],
    [{ upvoteEmojis: [] }, 'aucun emoji positif'],
    [{ upvoteEmojis: ['ceci n’est pas un emoji'] }, 'texte au lieu d’un emoji'],
    [{ watchedChannels: ['abc'] }, 'salon invalide'],
    [{ channelId: 42 }, 'salon de publication'],
  ])('refuse %j (%s)', (body) => {
    expect('error' in parseStarboardConfigPatch(body)).toBe(true);
  });

  test('vider le salon de publication est permis', () => {
    expect(parseStarboardConfigPatch({ channelId: null })).toEqual({ patch: { channelId: null } });
  });
});

describe('POST /starboard/entries/:id/block et /unblock', () => {
  test.each(['block', 'unblock'])('%s : rend le message à jour, journalisé', async (action) => {
    const { status, json } = await call('POST', `/entries/${ENTRY.id}/${action}`);
    expect(status).toBe(200);
    expect(json.entry.id).toBe(ENTRY.id);
    expect(mockDb.dashboardAuditLog.create).toHaveBeenCalled();
  });

  test('retirer : passe qui agit au service', async () => {
    await call('POST', `/entries/${ENTRY.id}/block`);
    expect(service.blockStarboardEntry.mock.calls[0]?.slice(1)).toEqual([GUILD, ENTRY.id, ALICE]);
  });

  test('message d’un autre serveur : 404', async () => {
    serviceEntry = null;
    const { status } = await call('POST', `/entries/${ENTRY.id}/block`);
    expect(status).toBe(404);
  });

  test('identifiant mal formé : 400 sans appel', async () => {
    const { status } = await call('POST', '/entries/abc;drop/block');
    expect(status).toBe(400);
    expect(service.blockStarboardEntry).not.toHaveBeenCalled();
  });

  test('modérateur sans droit retiré : permis ; droit « Modérer » retiré : refusé', async () => {
    expect((await call('POST', `/entries/${ENTRY.id}/block`, undefined, DASHBOARD_ACCESS_MODERATOR)).status).toBe(200);
    featureRights = { starboard: { canModerate: false } };
    expect((await call('POST', `/entries/${ENTRY.id}/block`, undefined, DASHBOARD_ACCESS_MODERATOR)).status).toBe(403);
  });
});

describe('PATCH /starboard : membres exclus', () => {
  test('seuls les membres nouvellement exclus perdent leurs messages à la une', async () => {
    currentSettings = { ...currentSettings, blockedUserIds: ['222222222222222222'] };
    await call('PATCH', '', { blockedUserIds: ['222222222222222222', ALICE] });
    expect(service.removeHighlightsOfAuthors.mock.calls[0]?.[2]).toEqual([ALICE]);
    // L'exclusion est une décision de modération : le journal nomme qui est exclu.
    expect(JSON.stringify(mockDb.dashboardAuditLog.create.mock.calls[0]?.[0])).toContain(ALICE);
  });

  test('aucun nouvel exclu : rien à retirer', async () => {
    await call('PATCH', '', { threshold: 6 });
    expect(service.removeHighlightsOfAuthors).not.toHaveBeenCalled();
  });
});

describe('parseStarboardConfigPatch : garde-fous', () => {
  test('âge maximum, seuils par salon et membres exclus valides', () => {
    expect(parseStarboardConfigPatch({
      maxMessageAgeDays: 14,
      channelThresholds: { [CHANNEL]: 9 },
      blockedUserIds: [ALICE, ALICE],
    })).toEqual({ patch: { maxMessageAgeDays: 14, channelThresholds: { [CHANNEL]: 9 }, blockedUserIds: [ALICE] } });
  });

  test.each([
    [{ maxMessageAgeDays: -1 }, 'âge négatif'],
    [{ maxMessageAgeDays: 366 }, 'âge hors bornes'],
    [{ channelThresholds: { abc: 3 } }, 'salon invalide'],
    [{ channelThresholds: { [CHANNEL]: 0 } }, 'seuil de salon hors bornes'],
    [{ blockedUserIds: ['abc'] }, 'membre invalide'],
    [{ blockedUserIds: 'abc' }, 'pas une liste'],
  ])('refuse %j (%s)', (body) => {
    expect('error' in parseStarboardConfigPatch(body)).toBe(true);
  });
});

describe('parseStarboardConfigPatch : récompenses et paliers', () => {
  const ROLE_A = '555555555555555555';
  const ROLE_B = '666666666666666666';

  test('gains, message privé et paliers triés par seuil', () => {
    expect(parseStarboardConfigPatch({
      rewardXp: 100,
      rewardCoins: 0,
      notifyAuthor: true,
      tiers: [{ threshold: 25, roleId: ROLE_B }, { threshold: 5, roleId: ROLE_A }],
    })).toEqual({ patch: {
      rewardXp: 100,
      rewardCoins: 0,
      notifyAuthor: true,
      tiers: [{ threshold: 5, roleId: ROLE_A }, { threshold: 25, roleId: ROLE_B }],
    } });
  });

  test.each([
    [{ rewardXp: -1 }, 'XP négative'],
    [{ rewardXp: 5001 }, 'XP hors bornes'],
    [{ rewardCoins: 1.5 }, 'pièces non entières'],
    [{ notifyAuthor: 'oui' }, 'booléen attendu'],
    [{ tiers: 'abc' }, 'paliers hors liste'],
    [{ tiers: [{ threshold: 0, roleId: '555555555555555555' }] }, 'seuil de palier nul'],
    [{ tiers: [{ threshold: 5, roleId: 'abc' }] }, 'rôle invalide'],
    [{ tiers: [{ threshold: 5, roleId: '555555555555555555' }, { threshold: 5, roleId: '666666666666666666' }] }, 'seuil en double'],
  ])('refuse %j (%s)', (body) => {
    expect('error' in parseStarboardConfigPatch(body)).toBe(true);
  });
});

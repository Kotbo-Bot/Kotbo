import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { DEFAULT_LEVEL_CURVE } from '@kotbo/shared';
import { completeModuleMock } from '../helpers/moduleMock.js';

const userId = '123456789012345678';
const guildId = '987654321098765432';

const mockDb = {
  memberProfile: {
    findFirst: mock(() => Promise.resolve({
      username: 'kotbo-user',
      messageCount: 42,
      voiceTimeSeconds: 600,
    })),
  },
  memberLevel: {
    findFirst: mock(() => Promise.resolve({ xp: 100 })),
  },
  staffActivity: {
    findMany: mock((_args?: unknown): Promise<unknown[]> => Promise.resolve([])),
  },
};

const guild = {
  memberCount: 100,
  name: 'Kotbo Test',
  vanityURLCode: 'kotbo-test',
  iconURL: () => 'https://cdn.example/icon.png',
  splashURL: () => null,
  bannerURL: () => null,
  members: {
    cache: new Map([[userId, { user: { username: 'discord-user' } }]]),
  },
  invites: {
    fetch: mock(() => Promise.resolve(new Map())),
  },
};

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb })],
  // Toutes les methodes du logger, meme celles dont ce test ne se sert pas :
  // `mock.module` est global au process, et un logger amputé de `debug` faisait
  // tomber les suites chargees ensuite (services/integrations, qui l'appellent)
  // avec un « logger.debug is not a function » sans rapport avec leur sujet.
  ['../../utils/logger', () => ({
    logger: {
      info: mock(() => undefined),
      success: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
      debug: mock(() => undefined),
    },
  })],
  ['../../utils/client', () => ({
    getClient: () => ({ guilds: { cache: new Map([[guildId, guild]]) } }),
  })],
  // Mocks COMPLETS : `mock.module` est global au process. Un mock partiel
  // supprimerait les autres exports (verifyAPIKey, getXpForLevel...) pour tous
  // les fichiers de test charges ensuite.
  ['../../services/staff/staffManagementService', () => completeModuleMock(
    path.resolve(import.meta.dir, '../../services/staff/staffManagementService.ts'),
    {
      getStaffMember: mock(() => Promise.resolve({
        id: 'staff-id',
        grade: 'ADMIN',
        joinedStaffAt: new Date('2026-01-01T00:00:00Z'),
      })),
    },
  )],
  ['../../services/progression/levelingService', () => completeModuleMock(
    path.resolve(import.meta.dir, '../../services/progression/levelingService.ts'),
    // `getWidgetStats` resout la courbe de niveaux du serveur avant de convertir
    // l'XP : sans cet override, le mock strict rejette l'appel. La courbe par
    // defaut suffit, le test ne verifie pas le calcul de niveau (`getLevelFromXp`
    // est deja fige a 3).
    { getLevelFromXp: () => 3, getGuildLevelCurve: () => Promise.resolve(DEFAULT_LEVEL_CURVE) },
  )],
];

for (const [relativePath, factory] of moduleMocks) {
  const tsPath = path.resolve(import.meta.dir, `${relativePath}.ts`);
  const jsPath = path.resolve(import.meta.dir, `${relativePath}.js`);
  mock.module(tsPath, factory);
  mock.module(jsPath, factory);
}

// `globalThis.fetch` est partage par tout le process de test. Sans restauration,
// les fichiers executes ensuite (dashboardApi.test.ts notamment, qui interroge
// un vrai serveur HTTP) recevaient la reponse 204 bouchonnee de ce fichier.
const realFetch = globalThis.fetch;
const fetchMock = mock(async (_input?: unknown, _init?: RequestInit): Promise<Response> => new Response(null, { status: 204 }));
globalThis.fetch = fetchMock as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

const { pushWidgetForUser, clearWidgetForUser } = await import('../../services/integrations/widgetService.js');

/** Réponse réelle de Discord quand l'identité envoyée n'est pas celle enregistrée. */
function identityMismatchResponse(sentId: string) {
  return new Response(
    JSON.stringify({
      message: 'Invalid Form Body',
      code: 50035,
      errors: {
        provider_issued_user_id: {
          _errors: [{
            code: 'APPLICATION_IDENTITY_PROVIDER_USER_ID_MISMATCH',
            message: `Provider user ID ${sentId} does not match existing identity record`,
          }],
        },
      },
    }),
    { status: 400 },
  );
}

/** Réponse réelle de Discord quand le membre n'a pas (ou plus) autorisé l'app. */
function missingScopeResponse() {
  return new Response(
    JSON.stringify({ message: 'Missing required OAuth2 scope', code: 50026 }),
    { status: 403 },
  );
}

describe('widgetService identities', () => {
  beforeEach(() => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.DISCORD_CLIENT_ID = 'test-app';
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
  });

  test('uses a unique identity and includes the external username', async () => {
    const result = await pushWidgetForUser(guildId, userId);

    expect(result).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toEndWith(`/users/${userId}/identities/${userId}/profile`);

    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(options.body));
    expect(payload.username).toBe('discord-user');
  });

  test('falls back to identity 0 only for the legacy user', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response(
        JSON.stringify({ code: 40113, message: 'Multi identity disabled' }),
        { status: 400 },
      ))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }));

    const result = await pushWidgetForUser(guildId, userId);

    expect(result).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/identities/${userId}/profile`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/identities/0/profile');
  });

  test('reports identity collisions instead of blaming OAuth authorization', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(
      JSON.stringify({ code: 40106, message: 'Identity already belongs to another user' }),
      { status: 400 },
    ));

    const result = await pushWidgetForUser(guildId, userId);

    expect(result.ok).toBeFalse();
    expect(result.error).toContain('déjà liée à un autre compte Discord');
    expect(result.error).not.toContain('autoriser');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('bascule sur l’identité legacy 0 quand Discord signale un mismatch d’identité', async () => {
    fetchMock
      .mockImplementationOnce(async () => identityMismatchResponse(userId))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }));

    const result = await pushWidgetForUser(guildId, userId);

    expect(result).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/identities/${userId}/profile`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/identities/0/profile');
  });

  test("demande de réautoriser au lieu de renvoyer le 403 brut quand la portée manque", async () => {
    fetchMock.mockImplementation(async () => missingScopeResponse());

    const result = await pushWidgetForUser(guildId, userId);

    expect(result.ok).toBeFalse();
    // Aucune identité alternative ne rattrape une autorisation absente.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('Réautorise Kotbo');
    expect(result.error).not.toContain('Missing required OAuth2 scope');
  });

  test('explique le mismatch au lieu de renvoyer le JSON brut quand aucune identité ne marche', async () => {
    fetchMock.mockImplementation(async () => identityMismatchResponse(userId));

    const result = await pushWidgetForUser(guildId, userId);

    expect(result.ok).toBeFalse();
    // Les deux candidats sont tentés avant d'abandonner.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.error).toContain('Désactive puis réactive');
    expect(result.error).not.toContain('APPLICATION_IDENTITY_PROVIDER_USER_ID_MISMATCH');
  });
});

describe('clearWidgetForUser identities', () => {
  beforeEach(() => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.DISCORD_CLIENT_ID = 'test-app';
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
  });

  test('bascule sur l’identité legacy 0 sur mismatch', async () => {
    fetchMock
      .mockImplementationOnce(async () => identityMismatchResponse(userId))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }));

    const result = await clearWidgetForUser(userId);

    expect(result).toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/identities/0/profile');
  });

  test("traite une autorisation absente comme « rien à vider »", async () => {
    fetchMock.mockImplementation(async () => missingScopeResponse());

    const result = await clearWidgetForUser(userId);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('traite un mismatch persistant comme « rien à vider »', async () => {
    fetchMock.mockImplementation(async () => identityMismatchResponse(userId));

    const result = await clearWidgetForUser(userId);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

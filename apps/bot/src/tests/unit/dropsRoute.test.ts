import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims, type DashboardAccess } from '../../api/shared.js';
import { PlanLockedError } from '../../services/core/moduleActivationService.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

let inOnboardingResult = false;
const mockSetStatus = mock(async () => ({
  moduleKey: 'drops',
  enabled: true,
  enabledRequirements: [],
  disabledDependents: [],
  preparedOnly: inOnboardingResult,
}));

let guildRow: Record<string, unknown> | null = null;
const mockDb = {
  guild: {
    findUnique: mock(async () => guildRow),
    update: mock(async () => guildRow),
  },
  dashboardAuditLog: {
    create: mock(async () => ({})),
  },
  dropConfig: {
    findMany: mock(async () => ['XP', 'RPG_XP', 'CLAN_POINTS', 'COINS', 'RPG_ITEM'].map((type) => ({ id: `config-${type}`, type }))),
    createMany: mock(async () => ({ count: 0 })),
  },
  drop: {
    findMany: mock(async () => recentDropRows),
    // Premier appel : drops terminés ; second : ceux sans gagnant.
    groupBy: mock(async (args: { where: { claimCount?: number } }) => (args.where.claimCount === 0
      ? [{ type: 'XP', _count: { _all: 6 } }]
      : [{ type: 'XP', _count: { _all: 10 } }, { type: 'COINS', _count: { _all: 3 } }])),
  },
  rpgItem: {
    findMany: mock(async () => [{ id: 'epee', name: 'Lame du Crépuscule', emoji: 'E' }]),
  },
};

let recentDropRows: Array<Record<string, unknown>> = [];

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const moduleActivationPath = path.resolve(__dirname, '../../services/core/moduleActivationService.ts');
for (const suffix of [
  '../../services/core/moduleActivationService.ts',
  '../../services/core/moduleActivationService.js',
]) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(moduleActivationPath, {
    PlanLockedError,
    setDashboardModuleStatus: mockSetStatus,
  }));
}

const onboardingPath = path.resolve(__dirname, '../../services/core/onboardingGate.ts');
for (const suffix of [
  '../../services/core/onboardingGate.ts',
  '../../services/core/onboardingGate.js',
]) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(onboardingPath, {
    isGuildInOnboarding: mock(async () => inOnboardingResult),
  }));
}

// Import après les mocks
const { handleDropsRoutes } = await import('../../api/routes/dashboard/drops.js');

function createMockRequest(body: Record<string, unknown>, method = 'PUT'): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = '/api/dashboard/guilds/guild-123/drops';
  req.headers = { 'content-type': 'application/json' };
  const raw = JSON.stringify(body);
  req.push(raw);
  req.push(null);
  return req;
}

interface MockResponse extends ServerResponse {
  body: string;
}

function createMockResponse(): MockResponse {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket)) as MockResponse;

  let _statusCode = 200;
  let _body = '';

  Object.defineProperty(res, 'statusCode', {
    get: () => _statusCode,
    set: (code: number) => {
      _statusCode = code;
    },
  });

  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.writeHead = (statusCode: number) => {
    _statusCode = statusCode;
    return res;
  };

  res.end = (chunk?: unknown) => {
    if (chunk) _body += String(chunk);
    res.body = _body;
    return res;
  };

  return res;
}

const mockClient = {
  guilds: {
    cache: new Map(),
  },
} as unknown as Client;

const mockUser: AuthClaims = {
  userId: 'user-1',
  username: 'Admin',
};

const mockAccess: DashboardAccess = DASHBOARD_ACCESS_ADMIN;

describe('handleDropsRoutes - onboarding et offres', () => {
  beforeEach(() => {
    mockSetStatus.mockClear();
    mockDb.guild.findUnique.mockClear();
    mockDb.guild.update.mockClear();
    inOnboardingResult = false;
    guildRow = {
      id: 'guild-123',
      dropsEnabled: false,
      dropChannelId: null,
      dropMentionRoleId: null,
      dropLifetimeMinutes: 60,
      dropDeleteAfterMinutes: 0,
    };
  });

  test('passe recordIntentWhenLocked: true lors de l onboarding', async () => {
    inOnboardingResult = true;

    const req = createMockRequest({
      dropsEnabled: true,
      dropChannelId: 'channel-1',
      dropLifetimeMinutes: 60,
    });
    const res = createMockResponse();
    const parts = ['api', 'dashboard', 'guilds', 'guild-123', 'drops'];

    const handled = await handleDropsRoutes(
      req,
      res,
      parts,
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    expect(handled).toBeTrue();
    expect(res.statusCode).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledWith(
      'guild-123',
      'drops',
      true,
      'Dashboard',
      { recordIntentWhenLocked: true },
    );
  });

  test('intercepte PlanLockedError hors onboarding et renvoie 402 plan_locked au lieu de 500', async () => {
    inOnboardingResult = false;
    mockSetStatus.mockImplementationOnce(async () => {
      throw new PlanLockedError('drops', 'FREE', 'PRO');
    });

    const req = createMockRequest({
      dropsEnabled: true,
      dropChannelId: 'channel-1',
    });
    const res = createMockResponse();
    const parts = ['api', 'dashboard', 'guilds', 'guild-123', 'drops'];

    const handled = await handleDropsRoutes(
      req,
      res,
      parts,
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    expect(handled).toBeTrue();
    expect(res.statusCode).toBe(402);
    const data = JSON.parse(res.body);
    expect(data.code).toBe('plan_locked');
    expect(data.moduleKey).toBe('drops');
    expect(data.requiredPlan).toBe('PRO');
  });
});

describe('handleDropsRoutes - historique', () => {
  beforeEach(() => {
    guildRow = {
      id: 'guild-123',
      dropsEnabled: true,
      dropChannelId: null,
      dropMentionRoleId: null,
      dropLifetimeMinutes: 60,
      dropDeleteAfterMinutes: 0,
    };
    const base = { mode: 'FIRST', channelId: 'salon-1', maxClaims: 1, claimCount: 1, createdAt: new Date(), expiresAt: new Date(), closedAt: null };
    recentDropRows = [
      { ...base, id: 'drop-objet', type: 'RPG_ITEM', itemId: 'epee', amount: 2 },
      { ...base, id: 'drop-xp', type: 'XP', itemId: null, amount: 120 },
    ];
  });

  test('un drop d\'objet nomme la pièce tombée, les autres non', async () => {
    const res = createMockResponse();
    await handleDropsRoutes(
      createMockRequest({}, 'GET'),
      res,
      ['api', 'dashboard', 'guilds', 'guild-123', 'drops'],
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    expect(res.statusCode).toBe(200);
    const { recentDrops } = JSON.parse(res.body);
    expect(recentDrops[0].item).toEqual({ name: 'Lame du Crépuscule', emoji: 'E' });
  });

  test('les gabarits de l\'annonce arrivent avec leurs trous, pour l\'aperçu', async () => {
    const res = createMockResponse();
    await handleDropsRoutes(
      createMockRequest({}, 'GET'),
      res,
      ['api', 'dashboard', 'guilds', 'guild-123', 'drops'],
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    const { announcement } = JSON.parse(res.body);
    expect(announcement.first).toContain('{amount}');
    expect(announcement.first).toContain('{resource}');
    expect(announcement.race).toContain('{winners}');
    expect(announcement.window).toContain('{closes}');
    expect(Object.keys(announcement.resources).sort()).toEqual(['CLAN_POINTS', 'COINS', 'RPG_ITEM', 'RPG_XP', 'XP']);
    expect(recentDrops[1].item).toBeNull();
  });
});

describe('handleDropsRoutes - jackpot', () => {
  beforeEach(() => {
    mockDb.guild.update.mockClear();
    guildRow = {
      id: 'guild-123',
      dropsEnabled: true,
      dropChannelId: null,
      dropMentionRoleId: null,
      dropLifetimeMinutes: 60,
      dropDeleteAfterMinutes: 0,
      dropJackpotEnabled: false,
      dropJackpotChance: 20,
      dropJackpotMultiplier: 5,
    };
  });

  test('les réglages sont enregistrés, une valeur hors des choix retombe sur le défaut', async () => {
    const res = createMockResponse();
    await handleDropsRoutes(
      createMockRequest({ dropJackpotEnabled: true, dropJackpotChance: 50, dropJackpotMultiplier: 7 }),
      res,
      ['api', 'dashboard', 'guilds', 'guild-123', 'drops'],
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    expect(res.statusCode).toBe(200);
    expect(mockDb.guild.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dropJackpotEnabled: true, dropJackpotChance: 50, dropJackpotMultiplier: 5 }),
    }));
  });
});

describe('handleDropsRoutes - bilan de la semaine', () => {
  beforeEach(() => {
    guildRow = {
      id: 'guild-123',
      dropsEnabled: true,
      dropChannelId: null,
      dropMentionRoleId: null,
      dropLifetimeMinutes: 60,
      dropDeleteAfterMinutes: 0,
    };
    recentDropRows = [];
  });

  test('chaque type a son nombre de drops terminés et de drops sans gagnant', async () => {
    const res = createMockResponse();
    await handleDropsRoutes(
      createMockRequest({}, 'GET'),
      res,
      ['api', 'dashboard', 'guilds', 'guild-123', 'drops'],
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    expect(res.statusCode).toBe(200);
    const { weeklyOutcomes } = JSON.parse(res.body);
    expect(weeklyOutcomes.XP).toEqual({ closed: 10, unclaimed: 6 });
    expect(weeklyOutcomes.COINS).toEqual({ closed: 3, unclaimed: 0 });
    expect(weeklyOutcomes.RPG_ITEM).toEqual({ closed: 0, unclaimed: 0 });
  });
});

describe('handleDropsRoutes - mention réservée aux jackpots', () => {
  beforeEach(() => {
    mockDb.guild.update.mockClear();
    guildRow = {
      id: 'guild-123',
      dropsEnabled: true,
      dropChannelId: null,
      dropMentionRoleId: 'role-drops',
      dropMentionJackpotOnly: false,
      dropLifetimeMinutes: 60,
      dropDeleteAfterMinutes: 0,
    };
  });

  test('l\'option est enregistrée', async () => {
    const res = createMockResponse();
    await handleDropsRoutes(
      createMockRequest({ dropMentionJackpotOnly: true }),
      res,
      ['api', 'dashboard', 'guilds', 'guild-123', 'drops'],
      mockClient,
      mockUser,
      'guild-123',
      mockAccess,
    );

    expect(res.statusCode).toBe(200);
    expect(mockDb.guild.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dropMentionRoleId: 'role-drops', dropMentionJackpotOnly: true }),
    }));
  });
});

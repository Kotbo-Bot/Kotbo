import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

/**
 * Un lien de vérification transmis à un tiers ne doit jamais produire un lien
 * de double compte automatique : la discordance de compte va au staff.
 */

const pending = {
  id: 'verif-1',
  token: 'tok',
  guildId: 'guild-1',
  userId: 'sender-1',
  level: 'LOW',
  status: 'PENDING',
  appealId: null,
  expiresAt: new Date(Date.now() + 60_000),
};

const mockDb = {
  securityVerification: {
    findUnique: mock(async () => pending),
    update: mock(async () => ({})),
    findMany: mock(async () => []),
    findFirst: mock(async () => null),
    updateMany: mock(async () => ({ count: 0 })),
  },
  guild: {
    findUnique: mock(async () => ({
      verificationAction: 'AUTO_LINK',
      verificationLogChannelId: null,
      logChannelId: null,
      verificationRoleId: null,
      verificationSaveIp: true,
      verificationSaveDevice: true,
    })),
  },
};

const linkAccounts = mock(async () => ({}));

for (const suffix of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
    upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert(),
  }));
}
for (const suffix of ['../../utils/logger.ts', '../../utils/logger.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} },
  }));
}
for (const suffix of ['../../services/moderation/altAccountService.ts', '../../services/moderation/altAccountService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({ linkAccounts }));
}

const { completeVerification } = await import('../../services/moderation/securityVerificationService');

describe('completeVerification : compte différent de celui attendu', () => {
  test('ne lie jamais les comptes, même avec AUTO_LINK, et signale au staff', async () => {
    const client = { guilds: { fetch: async () => { throw new Error('hors ligne'); } } };

    const result = await completeVerification({
      token: 'tok',
      verifiedDiscordId: 'victim-2',
      ipAddress: '203.0.113.9',
      dashboardUrl: 'https://dash.example',
      client: client as never,
    });

    expect(result.success).toBeTrue();
    expect(result.duplicateDetected).toBeTrue();
    expect(linkAccounts).not.toHaveBeenCalled();
    expect(mockDb.securityVerification.update).toHaveBeenCalled();
  });
});

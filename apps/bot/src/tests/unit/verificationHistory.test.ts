import { describe, expect, mock, test, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Historique des vérifications et garde-fou anti-spam (issue #216).
 *
 * Chaque demande met le membre en timeout 28 jours et lui envoie un MP : le
 * bouton du dashboard et le refus côté API doivent lire la même règle, sinon
 * deux modérateurs peuvent le harceler à quelques secondes d'intervalle.
 */

type VerificationRow = {
  id: string;
  status: 'PENDING' | 'VERIFIED' | 'FLAGGED' | 'EXPIRED';
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  createdAt: Date;
  verifiedAt: Date | null;
  expiresAt: Date | null;
};

let rows: VerificationRow[] = [];

const mockDb = {
  securityVerification: {
    findMany: mock(async () => rows),
    count: mock(async () => rows.length),
    updateMany: mock(async () => ({ count: 0 })),
    create: mock(async () => ({})),
    findUnique: mock(async () => null),
    update: mock(async () => ({})),
  },
};

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
};

for (const suffix of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
    upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert(),
  }));
}

for (const suffix of ['../../utils/logger.ts', '../../utils/logger.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({ logger: silentLogger }));
}

const { getVerificationHistory, VERIFICATION_REQUEST_COOLDOWN_MS } = await import(
  '../../services/moderation/securityVerificationService'
);

function row(overrides: Partial<VerificationRow> = {}): VerificationRow {
  return {
    id: 'verif-1',
    status: 'EXPIRED',
    level: 'HIGH',
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    verifiedAt: null,
    expiresAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

describe('getVerificationHistory', () => {
  beforeEach(() => {
    rows = [];
  });

  test('rend un historique vide et sans blocage pour un membre jamais vérifié', async () => {
    const history = await getVerificationHistory('guild-1', 'user-1');

    expect(history.entries).toHaveLength(0);
    expect(history.total).toBe(0);
    expect(history.lastRequestedAt).toBeNull();
    expect(history.hasPending).toBe(false);
    expect(history.cooldownUntil).toBeNull();
  });

  test('signale une demande encore ouverte', async () => {
    rows = [row({ status: 'PENDING', expiresAt: new Date(Date.now() + 60 * 60 * 1000) })];

    const history = await getVerificationHistory('guild-1', 'user-1');

    expect(history.hasPending).toBe(true);
  });

  test('ne considère pas une demande expirée comme ouverte', async () => {
    rows = [row({ status: 'PENDING', expiresAt: new Date(Date.now() - 1000) })];

    const history = await getVerificationHistory('guild-1', 'user-1');

    expect(history.hasPending).toBe(false);
  });

  test('bloque une relance immédiate après une demande récente', async () => {
    const justNow = new Date(Date.now() - 60 * 1000);
    rows = [row({ status: 'EXPIRED', createdAt: justNow, expiresAt: new Date(Date.now() - 30 * 1000) })];

    const history = await getVerificationHistory('guild-1', 'user-1');

    expect(history.cooldownUntil).not.toBeNull();
    expect(history.cooldownUntil!.getTime()).toBe(justNow.getTime() + VERIFICATION_REQUEST_COOLDOWN_MS);
  });

  test('laisse repasser une demande une fois le délai écoulé', async () => {
    rows = [row({ createdAt: new Date(Date.now() - VERIFICATION_REQUEST_COOLDOWN_MS - 1000) })];

    const history = await getVerificationHistory('guild-1', 'user-1');

    expect(history.cooldownUntil).toBeNull();
  });

  test('remonte la dernière vérification réussie', async () => {
    const verifiedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    rows = [
      row({ id: 'verif-2', createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }),
      row({ id: 'verif-1', status: 'VERIFIED', verifiedAt }),
    ];

    const history = await getVerificationHistory('guild-1', 'user-1');

    expect(history.lastVerifiedAt?.getTime()).toBe(verifiedAt.getTime());
    expect(history.entries).toHaveLength(2);
  });
});

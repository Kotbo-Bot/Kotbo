import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

// Mock the database dependency
const mockDb = {
  activationCode: {
    update: mock(() => Promise.resolve({} as unknown)),
    updateMany: mock(() => Promise.resolve({ count: 0 } as unknown)),
    findFirst: mock(() => Promise.resolve(null as unknown)),
    findUnique: mock(() => Promise.resolve(null as unknown)),
    delete: mock(() => Promise.resolve({} as unknown)),
  },
  guild: {
    findMany: mock(() => Promise.resolve([] as unknown[])),
    findUnique: mock(() => Promise.resolve(null as unknown)),
    update: mock(() => Promise.resolve({} as unknown)),
    upsert: mock((_args?: unknown) => Promise.resolve({} as unknown)),
  },
  staffServerLink: {
    findMany: mock(() => Promise.resolve([] as unknown[])),
  },
  $transaction: mock(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)) as unknown,
};

const dbPath = path.resolve(__dirname, '../../utils/db.ts');
const dbJsPath = path.resolve(__dirname, '../../utils/db.js');

mock.module(dbPath, () => ({
  default: mockDb,
  prisma: mockDb,
  prismaRead: mockDb,
}));

mock.module(dbJsPath, () => ({
  default: mockDb,
  prisma: mockDb,
  prismaRead: mockDb,
}));

import {
  activatedGuilds,
  loadActivatedGuilds,
  isGuildActivated,
  activateGuild,
  deactivateGuild
} from '../../utils/activation';

describe('activation service', () => {
  beforeEach(() => {
    mockDb.activationCode.update.mockClear();
    mockDb.activationCode.updateMany.mockClear();
    mockDb.activationCode.updateMany.mockResolvedValue({ count: 1 });
    mockDb.activationCode.findFirst.mockClear();
    mockDb.activationCode.findUnique.mockClear();
    mockDb.activationCode.delete.mockClear();
    mockDb.guild.findMany.mockClear();
    mockDb.guild.findUnique.mockClear();
    mockDb.guild.update.mockClear();
    mockDb.guild.upsert.mockClear();
    (mockDb.staffServerLink.findMany as ReturnType<typeof mock>).mockClear();
    (mockDb.$transaction as ReturnType<typeof mock>).mockClear();
    (mockDb.$transaction as ReturnType<typeof mock>).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb));
    activatedGuilds.clear();
  });

  test('loadActivatedGuilds should populate the activatedGuilds Set from DB', async () => {
    mockDb.guild.findMany.mockResolvedValue([
      { id: 'guild-1' },
      { id: 'guild-2' }
    ]);

    await loadActivatedGuilds();

    expect(activatedGuilds.size).toBe(2);
    expect(isGuildActivated('guild-1')).toBeTrue();
    expect(isGuildActivated('guild-2')).toBeTrue();
    expect(isGuildActivated('guild-3')).toBeFalse();
    expect(mockDb.guild.findMany).toHaveBeenCalled();
  });

  test('activateGuild should update DB activation code, upsert guild, and add to cache', async () => {
    mockDb.activationCode.findUnique.mockResolvedValue({ code: 'KB-TEST-CODE', isActive: true, usedAt: null, accessType: 'PERMANENT', durationMinutes: null });
    mockDb.activationCode.update.mockResolvedValue({});
    mockDb.guild.upsert.mockResolvedValue({});

    const result = await activateGuild('guild-123', 'KB-TEST-CODE');

    expect(mockDb.activationCode.update).toHaveBeenCalledWith({
      where: { code: 'KB-TEST-CODE' },
      data: {
        usedAt: expect.any(Date),
        usedByGuildId: 'guild-123',
        isActive: false,
      }
    });

    // Un code sans durée accorde un accès permanent : aucune date de fin posée.
    const permanentAccess = {
      accessType: 'PERMANENT',
      accessExpiresAt: null,
      accessExpiredAt: null,
      accessDurationMinutes: null,
      accessRemindersSent: [],
    };

    expect(mockDb.guild.upsert).toHaveBeenCalledWith({
      where: { id: 'guild-123' },
      update: {
        activated: true,
        activatedAt: expect.any(Date),
        activationCode: expect.any(String),
        activatedViaStaffLink: false,
        ...permanentAccess,
      },
      create: {
        id: 'guild-123',
        activated: true,
        activatedAt: expect.any(Date),
        activationCode: expect.any(String),
        activatedViaStaffLink: false,
        ...permanentAccess,
      }
    });

    expect(result).toEqual({ accessType: 'PERMANENT', durationMinutes: null, expiresAt: null });
    expect(isGuildActivated('guild-123')).toBeTrue();
  });

  test('activateGuild should open a trial period when the code carries a duration', async () => {
    mockDb.activationCode.findUnique.mockResolvedValue({ code: 'KB-TRIAL-CODE', isActive: true, usedAt: null, accessType: 'TRIAL', durationMinutes: 15 * 1440 });
    mockDb.activationCode.update.mockResolvedValue({});
    mockDb.guild.upsert.mockResolvedValue({});

    const before = Date.now();
    const result = await activateGuild('guild-trial', 'KB-TRIAL-CODE');

    expect(result.accessType).toBe('TRIAL');
    expect(result.durationMinutes).toBe(15 * 1440);
    expect(result.expiresAt).toBeInstanceOf(Date);
    // La date de fin tombe bien 15 jours après l'activation.
    const expected = before + 15 * 86_400_000;
    expect(Math.abs(result.expiresAt!.getTime() - expected)).toBeLessThan(5_000);

    const upsertArgs = mockDb.guild.upsert.mock.calls[0]![0] as {
      create: { accessType: string; accessExpiresAt: Date | null };
    };
    expect(upsertArgs.create.accessType).toBe('TRIAL');
    expect(upsertArgs.create.accessExpiresAt).toEqual(result.expiresAt);

    expect(isGuildActivated('guild-trial')).toBeTrue();
  });

  test('deactivateGuild can keep the code consumed (trial reaching its term)', async () => {
    mockDb.guild.findUnique.mockResolvedValue({ activationCode: 'KB-TEST-CODE' });
    mockDb.guild.update.mockResolvedValue({});
    activatedGuilds.add('guild-123');

    await deactivateGuild('guild-123', { recycleCode: false });

    // Un essai arrivé à terme ne doit jamais remettre son code en circulation.
    expect(mockDb.activationCode.updateMany).not.toHaveBeenCalled();
    expect(isGuildActivated('guild-123')).toBeFalse();
  });

  test('deactivateGuild never recycles a time-limited code', async () => {
    mockDb.guild.findUnique.mockResolvedValue({ activationCode: 'KB-TRIAL-CODE' });
    mockDb.guild.update.mockResolvedValue({});
    // Aucun code permanent ne correspond : le code d'essai reste consommé.
    mockDb.activationCode.updateMany.mockResolvedValue({ count: 0 });
    activatedGuilds.add('guild-trial');

    await deactivateGuild('guild-trial');

    // Le filtre sur accessType empêche un code d'essai de rejouer une période.
    expect(mockDb.activationCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { usedByGuildId: 'guild-trial', accessType: 'PERMANENT' },
      })
    );
    expect(isGuildActivated('guild-trial')).toBeFalse();
  });

  test('deactivateGuild should set active to false in DB and delete from cache', async () => {
    mockDb.guild.findUnique.mockResolvedValue({ activationCode: 'KB-TEST-CODE' });
    mockDb.guild.update.mockResolvedValue({});

    activatedGuilds.add('guild-123');

    await deactivateGuild('guild-123');

    // Le code est retrouvé par le serveur qui l'a consommé : `guild.activationCode`
    // ne contient qu'une empreinte SHA-256, inutilisable comme critère de recherche.
    // Seuls les codes permanents repartent en circulation.
    expect(mockDb.activationCode.updateMany).toHaveBeenCalledWith({
      where: { usedByGuildId: 'guild-123', accessType: 'PERMANENT' },
      data: {
        usedAt: null,
        usedByGuildId: null,
        isActive: true
      }
    });

    expect(mockDb.guild.update).toHaveBeenCalledWith({
      where: { id: 'guild-123' },
      data: {
        activated: false,
        activatedAt: null,
        activationCode: null,
        activatedViaStaffLink: false,
      }
    });

    expect(isGuildActivated('guild-123')).toBeFalse();
  });
});

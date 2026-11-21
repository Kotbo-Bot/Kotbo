import { describe, expect, test, mock, jest } from 'bun:test';
import path from 'node:path';

const BANNI = '500000000000000001';
let maintenance = 'false';
let blacklist: string[] = [];

const mockDb = {
  botGlobalConfig: { findUnique: mock(async () => ({ key: 'MAINTENANCE_MODE', value: maintenance })) },
  globalBlacklist: { findMany: mock(async () => blacklist.map((userId) => ({ userId }))) },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { startGlobalFlagsSync } = await import('../../utils/globalFlags');

/** Laisse aboutir la relecture lancée par le minuteur. */
const relectureTerminee = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('maintenance et blacklist globales', () => {
  test('un processus voit en moins d’une minute ce que l’API d’un autre processus a écrit en base', async () => {
    jest.useFakeTimers();
    try {
      await startGlobalFlagsSync();
      expect(globalThis.KOTBO_MAINTENANCE_MODE).toBe(false);
      expect(globalThis.KOTBO_BLACKLIST.has(BANNI)).toBe(false);

      // Écrit en base depuis le shard 0 : rien d'autre ne prévient ce processus.
      maintenance = 'true';
      blacklist = [BANNI];
      jest.advanceTimersByTime(60_000);
      await relectureTerminee();

      expect(globalThis.KOTBO_MAINTENANCE_MODE).toBe(true);
      expect(globalThis.KOTBO_BLACKLIST.has(BANNI)).toBe(true);

      // Et la levée se propage de même.
      maintenance = 'false';
      blacklist = [];
      jest.advanceTimersByTime(60_000);
      await relectureTerminee();

      expect(globalThis.KOTBO_MAINTENANCE_MODE).toBe(false);
      expect(globalThis.KOTBO_BLACKLIST.has(BANNI)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

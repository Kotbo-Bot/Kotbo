import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

// Le module charge la base au démarrage : ce test n'en a pas besoin.
for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: {}, prisma: {}, prismaRead: {}, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { generateActivationCode } = await import('../../utils/activation.js');

describe('code d\'activation', () => {
  test('a toujours la forme KB-XXXX-XXXX-XXXX', () => {
    // L'ancien tirage donnait parfois un bloc de moins de quatre caractères.
    for (let i = 0; i < 2_000; i += 1) {
      expect(generateActivationCode()).toMatch(/^KB-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
  });

  test('ne se répète pas d\'un tirage à l\'autre', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateActivationCode()));
    expect(codes.size).toBe(500);
  });
});

import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const codes = new Map<string, string>([['KOTBO-AB23CD', 'parrain']]);
const mockDb = {
  referralCode: {
    findUnique: async ({ where }: { where: { code: string } }) =>
      codes.has(where.code) ? { discordUserId: codes.get(where.code) } : null,
  },
};
for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { normalizeReferralCode, resolveReferralCode } = await import('../../services/billing/referralService.js');

describe('Parrainage', () => {
  test('accepte un code saisi sans préfixe, en minuscules ou avec espaces', () => {
    expect(normalizeReferralCode(' kotbo-ab23cd ')).toBe('KOTBO-AB23CD');
    expect(normalizeReferralCode('ab23 cd')).toBe('KOTBO-AB23CD');
  });

  test('résout le code d’un autre utilisateur', async () => {
    expect(await resolveReferralCode('ab23cd', 'filleul')).toEqual({ ok: true, code: 'KOTBO-AB23CD' });
  });

  test('refuse son propre code et un code inconnu', async () => {
    expect(await resolveReferralCode('KOTBO-AB23CD', 'parrain')).toEqual({ ok: false, reason: 'own_code' });
    expect(await resolveReferralCode('ZZZZZZ', 'filleul')).toEqual({ ok: false, reason: 'unknown_code' });
  });
});

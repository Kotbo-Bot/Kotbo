import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const codes = new Map<string, string>([['KOTBO-AB23CD', 'parrain']]);

type Trial = { referralCode: string | null; subscriptionId: string | null };
type Invoice = { subscriptionId: string | null; status: string; amountPaidCents: number };
let trials: Trial[] = [];
let invoices: Invoice[] = [];

const mockDb = {
  referralCode: {
    findUnique: async ({ where }: { where: { code?: string; discordUserId?: string } }) => {
      if (where.code) return codes.has(where.code) ? { code: where.code, discordUserId: codes.get(where.code) } : null;
      const entry = [...codes.entries()].find(([, owner]) => owner === where.discordUserId);
      return entry ? { code: entry[0], discordUserId: entry[1] } : null;
    },
  },
  billingTrial: {
    findMany: async ({ where }: { where: { referralCode: string } }) =>
      trials.filter((trial) => trial.referralCode === where.referralCode && trial.subscriptionId !== null),
  },
  billingInvoice: {
    findMany: async ({ where }: { where: { subscriptionId: { in: string[] }; status: string; amountPaidCents: { gt: number } } }) => {
      const matching = invoices.filter((invoice) => invoice.subscriptionId !== null
        && where.subscriptionId.in.includes(invoice.subscriptionId)
        && invoice.status === where.status
        && invoice.amountPaidCents > where.amountPaidCents.gt);
      return [...new Set(matching.map((invoice) => invoice.subscriptionId))].map((subscriptionId) => ({ subscriptionId }));
    },
  },
};
for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { countPaidReferrals, normalizeReferralCode, resolveReferralCode } = await import('../../services/billing/referralService.js');

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

describe('Filleuls payants', () => {
  beforeEach(() => {
    trials = [];
    invoices = [];
  });

  test('sans code de parrainage, aucun filleul', async () => {
    expect(await countPaidReferrals('inconnu')).toBe(0);
  });

  test('un essai résilié avant sa première facture ne compte pas', async () => {
    trials = [{ referralCode: 'KOTBO-AB23CD', subscriptionId: 'sub_essai' }];
    // La facture à 0 € de l'essai n'est pas un paiement.
    invoices = [{ subscriptionId: 'sub_essai', status: 'paid', amountPaidCents: 0 }];
    expect(await countPaidReferrals('parrain')).toBe(0);
  });

  test('une réservation sans abonnement ni une facture impayée ne comptent pas', async () => {
    trials = [
      { referralCode: 'KOTBO-AB23CD', subscriptionId: null },
      { referralCode: 'KOTBO-AB23CD', subscriptionId: 'sub_impaye' },
    ];
    invoices = [{ subscriptionId: 'sub_impaye', status: 'open', amountPaidCents: 0 }];
    expect(await countPaidReferrals('parrain')).toBe(0);
  });

  test('chaque serveur filleul qui a payé compte une fois, quel que soit son nombre de factures', async () => {
    trials = [
      { referralCode: 'KOTBO-AB23CD', subscriptionId: 'sub_a' },
      { referralCode: 'KOTBO-AB23CD', subscriptionId: 'sub_b' },
      { referralCode: 'KOTBO-AUTRE1', subscriptionId: 'sub_c' },
    ];
    invoices = [
      { subscriptionId: 'sub_a', status: 'paid', amountPaidCents: 450 },
      { subscriptionId: 'sub_a', status: 'paid', amountPaidCents: 500 },
      { subscriptionId: 'sub_b', status: 'paid', amountPaidCents: 450 },
      { subscriptionId: 'sub_c', status: 'paid', amountPaidCents: 450 },
    ];
    expect(await countPaidReferrals('parrain')).toBe(2);
  });
});

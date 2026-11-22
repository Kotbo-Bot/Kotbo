/**
 * Activation d'un code cadeau : seul un abonnement encore vivant chez Stripe la
 * bloque, même impayé ou incomplet, pas l'identifiant que Stripe laisse après
 * une résiliation.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '100000000000000001';
const ADMIN_ID = '200000000000000001';
const CODE = 'KOTBO-CADEAU-1';

type Row = Record<string, unknown>;

const gift = {
  id: 'gift-1',
  code: CODE,
  plan: 'PLUS',
  months: 3,
  source: 'PURCHASE_CODE',
  amountCents: 2700,
  purchasedById: '300000000000000001',
  targetGuildId: null,
  paidAt: new Date('2026-11-01T10:00:00Z'),
  redeemedByGuildId: null,
  redeemedAt: null,
  expiresAt: null,
  note: null,
  createdAt: new Date('2026-11-01T09:00:00Z'),
};
/** Ligne `Guild` complète : la route n'en reçoit que les colonnes qu'elle demande. */
let guildRow: Row = {};

const claims = mock(async (_args: { where: Row; data: Row }) => ({ count: 1 }));
const fakePrisma = {
  billingGift: {
    findUnique: mock(async ({ where }: { where: { code?: string; id?: string } }) =>
      (where.code === CODE || where.id === gift.id ? gift : null)),
    updateMany: claims,
    update: mock(async () => gift),
  },
  guild: {
    findUnique: mock(async ({ select }: { select?: Record<string, boolean> }) =>
      (select ? Object.fromEntries(Object.keys(select).map((key) => [key, guildRow[key] ?? null])) : guildRow)),
  },
};

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}
const setGuildPlan = mock(async (_guildId: string, _plan: string, _reason: string) => {});
const extendAccess = mock(async () => ({ accessExpiresAt: new Date('2027-02-20T10:00:00Z') }));
mockModule('../../utils/db', { default: fakePrisma, prisma: fakePrisma, prismaRead: fakePrisma });
mockModule('../../services/system/planService', { getGuildPlan: async () => 'FREE', setGuildPlan });
mockModule('../../services/system/accessService', { getAccessStatus: async () => null, extendAccess });
mockModule('../../utils/activation', { isGuildActivated: () => true });
mockModule('../../services/analytics/acquisitionService', { trackAcquisitionStep: () => {} });
mockModule('../../services/billing/stripeService', {});
mockModule('../../services/billing/trialService', {});
// Socle de l'API, chargé pour la seule adresse du dashboard (paiement en ligne).
mockModule('../../api/shared/core', { getDashboardOrigin: () => 'https://dashboard.test' });

const { redeemGiftCode } = await import('../../services/billing/giftService.js');

beforeEach(() => {
  claims.mockClear();
  setGuildPlan.mockClear();
  extendAccess.mockClear();
});

describe("activation d'un code cadeau", () => {
  test("un serveur dont l'abonnement est résilié ou expiré peut activer un code", async () => {
    for (const status of ['canceled', 'incomplete_expired']) {
      // L'identifiant de l'ancien abonnement reste sur le serveur après sa fin.
      guildRow = { id: GUILD_ID, stripeSubscriptionId: 'sub_ancien', stripeSubscriptionStatus: status };

      const result = await redeemGiftCode(CODE.toLowerCase(), GUILD_ID, ADMIN_ID, 40);

      expect({ status, ok: result.ok }).toEqual({ status, ok: true });
    }
    // Le code est réclamé pour ce serveur, et l'offre lui est appliquée.
    expect(claims.mock.calls[0][0].data).toMatchObject({ redeemedByGuildId: GUILD_ID, redeemedById: ADMIN_ID });
    expect(setGuildPlan.mock.calls[0].slice(0, 2)).toEqual([GUILD_ID, 'PLUS']);
    expect(extendAccess).toHaveBeenCalledTimes(2);
  });

  test("un abonnement encore vivant, même impayé, bloque toujours l'activation", async () => {
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']) {
      guildRow = { id: GUILD_ID, stripeSubscriptionId: 'sub_courant', stripeSubscriptionStatus: status };

      const result = await redeemGiftCode(CODE, GUILD_ID, ADMIN_ID, 40);

      expect({ status, result }).toEqual({ status, result: { ok: false, reason: 'guild_has_subscription' } });
    }
    // Le code reste intact : rien n'est réclamé ni appliqué.
    expect(claims).not.toHaveBeenCalled();
    expect(setGuildPlan).not.toHaveBeenCalled();
  });
});

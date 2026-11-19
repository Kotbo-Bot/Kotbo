// `hasSubscription` suit le statut, pas `stripeSubscriptionId` que Stripe garde
// après une résiliation. Seuls la session, l'accès au serveur et les services
// voisins sont simulés.
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '100000000000000001';
const ADMIN_ID = '200000000000000001';

type Row = Record<string, unknown>;
/** Ligne `Guild` complète : la route n'en reçoit que les colonnes qu'elle demande. */
let guildRow: Row = {};

const fakePrisma = {
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
mockModule('../../utils/db', { default: fakePrisma, prisma: fakePrisma, prismaRead: fakePrisma });
// Session : un administrateur du serveur, connecté.
mockModule('../../api/hono/middleware/auth', {
  requireAuth: createMiddleware(async (c, next) => {
    c.set('auth', { userId: ADMIN_ID, username: 'Admin' });
    await next();
  }),
});
mockModule('../../api/hono/middleware/guildAccess', {
  requireGuildAccess: () => createMiddleware(async (c, next) => {
    c.set('guildAccess', { level: 'admin', guildId: c.req.param('guildId') ?? '' });
    await next();
  }),
});
mockModule('../../services/billing/stripeService', {
  isBillingEnabled: () => true,
  sellablePlans: () => ['PLUS'],
});
mockModule('../../services/billing/trialService', {
  TRIAL_DAYS: 15,
  checkTrialEligibility: async () => ({ eligible: false, days: 15, reason: 'already_used_by_guild' }),
});
mockModule('../../services/billing/giftService', {
  GIFT_METADATA_KIND: 'gift',
  listGiftsPurchasedBy: async () => [],
  listGiftsForGuild: async () => [],
});
mockModule('../../services/billing/referralService', {
  getOrCreateReferralCode: async () => 'PARRAIN-1',
  countReferrals: async () => 0,
});
mockModule('../../services/billing/consentService', {});
mockModule('../../services/billing/billingAnalytics', {});
mockModule('../../services/analytics/acquisitionService', {});
mockModule('../../services/system/planService', {});
mockModule('../../services/system/accessService', {});

const { createBillingRouter } = await import('../../api/hono/routes/billing.js');

const client = { guilds: { cache: new Map([[GUILD_ID, { memberCount: 40 }]]) } } as unknown as Client;
const router = createBillingRouter(client);

async function billingStatus(subscriptionStatus: string | null) {
  guildRow = {
    id: GUILD_ID,
    plan: 'FREE',
    // L'identifiant d'un abonnement reste sur le serveur, vivant ou non.
    stripeSubscriptionId: subscriptionStatus ? 'sub_1' : null,
    stripeSubscriptionStatus: subscriptionStatus,
    stripeCancelAtPeriodEnd: false,
  };
  const res = await router.request(`/api/dashboard/guilds/${GUILD_ID}/billing`);
  expect(res.status).toBe(200);
  const { hasSubscription, hasLiveSubscription } = (await res.json()) as { hasSubscription: boolean; hasLiveSubscription: boolean };
  return { status: subscriptionStatus, hasSubscription, hasLiveSubscription };
}

describe('état de facturation renvoyé au dashboard', () => {
  test('un abonnement résilié ou expiré garde le portail et ses factures, sans compter comme vivant', async () => {
    for (const status of ['canceled', 'incomplete_expired']) {
      expect(await billingStatus(status)).toEqual({ status, hasSubscription: true, hasLiveSubscription: false });
    }
    expect(await billingStatus(null)).toEqual({ status: null, hasSubscription: false, hasLiveSubscription: false });
  });

  test('un abonnement vivant chez Stripe, même impayé, compte comme tel et garde le portail pour se régulariser', async () => {
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']) {
      expect(await billingStatus(status)).toEqual({ status, hasSubscription: true, hasLiveSubscription: true });
    }
  });
});

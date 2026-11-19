// `hasSubscription` suit le statut, pas `stripeSubscriptionId` que Stripe garde
// après une résiliation. Le webhook ne traite en doublon qu'une clé en double :
// une panne de base doit faire rejouer Stripe. Seuls la session, l'accès au
// serveur, la signature Stripe et les services voisins sont simulés.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { createMiddleware } from 'hono/factory';
import { Prisma } from '@prisma/client';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '100000000000000001';
const ADMIN_ID = '200000000000000001';

type Row = Record<string, unknown>;
/** Ligne `Guild` complète : la route n'en reçoit que les colonnes qu'elle demande. */
let guildRow: Row = {};

/** Erreur levée par l'insertion d'idempotence du webhook, `null` si elle réussit. */
let insertError: unknown = null;
const recordedEvents: string[] = [];

const fakePrisma = {
  guild: {
    findUnique: mock(async ({ select }: { select?: Record<string, boolean> }) =>
      (select ? Object.fromEntries(Object.keys(select).map((key) => [key, guildRow[key] ?? null])) : guildRow)),
  },
  billingEvent: {
    create: mock(async ({ data }: { data: { id: string } }) => {
      if (insertError) throw insertError;
      recordedEvents.push(data.id);
      return data;
    }),
    update: mock(async () => ({})),
    delete: mock(async () => ({})),
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
  // Signature acceptée : l'événement est le corps reçu.
  getStripe: () => ({ webhooks: { constructEventAsync: async (rawBody: string) => JSON.parse(rawBody) } }),
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
const { logger } = await import('../../utils/logger.js');

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

describe('webhook Stripe : idempotence', () => {
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalError = logger.error;
  let loggedErrors: string[] = [];

  beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  });
  beforeEach(() => {
    insertError = null;
    recordedEvents.length = 0;
    loggedErrors = [];
    logger.error = (tag: string, ...args: unknown[]) => {
      loggedErrors.push(`${tag} ${args.map((arg) => String(arg)).join(' ')}`);
    };
  });
  afterEach(() => {
    logger.error = originalError;
  });

  async function deliver(eventId: string) {
    const res = await router.request('/api/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=signature', 'content-type': 'application/json' },
      body: JSON.stringify({ id: eventId, type: 'customer.created', data: { object: {} } }),
    });
    return { status: res.status, body: await res.json() };
  }

  test("une panne de la base n'est pas prise pour un doublon : 500, pour que Stripe rejoue l'événement", async () => {
    for (const err of [
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
        code: 'P2024',
        clientVersion: 'test',
      }),
      new Error("Can't reach database server at 127.0.0.1:5432"),
    ]) {
      insertError = err;
      const { status, body } = await deliver('evt_panne');
      expect(status).toBe(500);
      expect(body).not.toHaveProperty('duplicate');
    }
    // La panne est journalisée, et non passée sous silence comme un doublon.
    expect(loggedErrors).toHaveLength(2);
    expect(loggedErrors.every((line) => line.includes('evt_panne'))).toBe(true);
  });

  test('un événement déjà reçu (clé primaire en double) est acquitté comme doublon', async () => {
    insertError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(await deliver('evt_rejoue')).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(loggedErrors).toEqual([]);
  });

  test('un événement neuf est enregistré puis acquitté', async () => {
    expect(await deliver('evt_neuf')).toEqual({ status: 200, body: { received: true } });
    expect(recordedEvents).toEqual(['evt_neuf']);
  });
});

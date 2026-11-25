// Le payeur garde la main sur sa facture même quand le serveur n'est plus
// ouvrable dans le dashboard (bot retiré, membre parti) : le portail Stripe
// s'ouvre depuis la liste de ses serveurs payants, sans passer par la garde du
// serveur. Personne d'autre que le payeur ne peut l'ouvrir.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '100000000000000001';
const PAYER_ID = '200000000000000001';
const OTHER_ID = '200000000000000002';

let guildRow: Record<string, unknown> | null = null;
let sessionUserId = PAYER_ID;
const portalCalls: Array<{ guildId: string; customerId: string }> = [];

const fakePrisma = {
  guild: {
    findUnique: mock(async ({ select }: { select?: Record<string, boolean> }) =>
      (guildRow && select ? Object.fromEntries(Object.keys(select).map((key) => [key, guildRow![key] ?? null])) : guildRow)),
  },
};

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}
mockModule('../../utils/db', { default: fakePrisma, prisma: fakePrisma, prismaRead: fakePrisma });
mockModule('../../api/hono/middleware/auth', {
  requireAuth: createMiddleware(async (c, next) => {
    c.set('auth', { userId: sessionUserId, username: 'Payeur' });
    await next();
  }),
});
mockModule('../../api/hono/middleware/guildAccess', {
  requireGuildAccess: () => createMiddleware(async () => {
    throw new Error("La garde du serveur ne doit pas s'appliquer ici.");
  }),
});
mockModule('../../services/billing/stripeService', {
  isBillingEnabled: () => true,
  sellablePlans: () => ['PLUS'],
  createPortalSession: async (guildId: string, customerId: string) => {
    portalCalls.push({ guildId, customerId });
    return 'https://billing.stripe.test/session';
  },
});
mockModule('../../services/billing/trialService', { TRIAL_DAYS: 15 });
mockModule('../../services/billing/giftService', { GIFT_METADATA_KIND: 'gift' });
mockModule('../../services/billing/referralService', {});
mockModule('../../services/billing/consentService', {});
mockModule('../../services/billing/billingAnalytics', {});
mockModule('../../services/analytics/acquisitionService', { trackAcquisitionStep: () => {} });
mockModule('../../services/system/planService', {});
mockModule('../../services/system/accessService', {});

const { createBillingRouter } = await import('../../api/hono/routes/billing.js');

// Le bot n'est plus sur le serveur : il n'est pas dans le cache.
const client = { guilds: { cache: new Map() } } as unknown as Client;
const router = createBillingRouter(client);

async function openPortal() {
  const res = await router.request(`/api/dashboard/billing/owned/${GUILD_ID}/portal`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '127.0.0.1' },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('portail Stripe depuis la liste des serveurs payants', () => {
  beforeEach(() => {
    sessionUserId = PAYER_ID;
    portalCalls.length = 0;
    guildRow = { id: GUILD_ID, billingOwnerId: PAYER_ID, stripeCustomerId: 'cus_1' };
  });

  test('le payeur ouvre le portail même sans le bot sur le serveur', async () => {
    expect(await openPortal()).toEqual({ status: 200, body: { url: 'https://billing.stripe.test/session' } });
    expect(portalCalls).toEqual([{ guildId: GUILD_ID, customerId: 'cus_1' }]);
  });

  test("un autre compte reçoit 404, sans apprendre que le serveur a un payeur", async () => {
    sessionUserId = OTHER_ID;
    expect((await openPortal()).status).toBe(404);
    expect(portalCalls).toEqual([]);
  });

  test('un serveur inconnu ou sans client Stripe reçoit 404', async () => {
    guildRow = { id: GUILD_ID, billingOwnerId: PAYER_ID, stripeCustomerId: null };
    expect((await openPortal()).status).toBe(404);
    guildRow = null;
    expect((await openPortal()).status).toBe(404);
    expect(portalCalls).toEqual([]);
  });
});

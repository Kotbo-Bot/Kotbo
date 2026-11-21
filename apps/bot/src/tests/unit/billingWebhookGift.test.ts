import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const prismaMock = { billingEvent: { create: async () => ({}), update: async () => ({}) } };
const applyGiftPayment = mock(async () => 'guild-1');
const releaseGiftSession = mock(async (_sessionId: string) => undefined);

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}
mockModule('../../utils/db', { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock });
// Signature acceptée : l'événement est le corps reçu.
mockModule('../../services/billing/stripeService', {
  getStripe: () => ({ webhooks: { constructEventAsync: async (rawBody: string) => JSON.parse(rawBody) } }),
});
mockModule('../../services/billing/giftService', { GIFT_METADATA_KIND: 'gift', applyGiftPayment, releaseGiftSession });
mockModule('../../services/billing/consentService', { recordBillingConsent: async () => undefined });

const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
afterAll(() => {
  if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
});

const { createBillingRouter } = await import('../../api/hono/routes/billing.js');
const router = createBillingRouter({} as Client);

let eventCounter = 0;

/** Envoie un événement Stripe sur une session de paiement d'un cadeau. */
function webhook(type: string, paymentStatus: 'paid' | 'unpaid') {
  return router.request('/api/billing/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=signature' },
    body: JSON.stringify({
      id: `evt_${++eventCounter}`,
      type,
      data: { object: { id: 'cs_cadeau', payment_status: paymentStatus, metadata: { kind: 'gift' } } },
    }),
  });
}

beforeEach(() => {
  applyGiftPayment.mockClear();
  releaseGiftSession.mockClear();
});

describe('webhook Stripe : cadeau à paiement différé', () => {
  test("n'applique pas un cadeau tant que le prélèvement n'est pas réglé", async () => {
    // Carte : la session se termine payée, le cadeau part tout de suite.
    expect((await webhook('checkout.session.completed', 'paid')).status).toBe(200);
    expect(applyGiftPayment).toHaveBeenCalledTimes(1);

    // Prélèvement SEPA : la session se termine avant que l'argent arrive.
    expect((await webhook('checkout.session.completed', 'unpaid')).status).toBe(200);
    expect(applyGiftPayment).toHaveBeenCalledTimes(1);
  });

  test('applique le cadeau quand Stripe confirme le paiement différé', async () => {
    expect((await webhook('checkout.session.async_payment_succeeded', 'paid')).status).toBe(200);
    expect(applyGiftPayment).toHaveBeenCalledTimes(1);
  });

  test("efface le cadeau en attente quand le prélèvement différé échoue", async () => {
    expect((await webhook('checkout.session.async_payment_failed', 'unpaid')).status).toBe(200);
    expect(applyGiftPayment).not.toHaveBeenCalled();
    expect(releaseGiftSession.mock.calls).toEqual([['cs_cadeau']]);
  });
});

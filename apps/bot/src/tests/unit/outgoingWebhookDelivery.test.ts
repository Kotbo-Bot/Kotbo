import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { verifyWebhookSignature } from '../../services/integrations/outgoingWebhookSecurity.js';

type Row = Record<string, unknown>;
let delivery: Row;
let webhook: Row;
const deliveryUpdates: Row[] = [];
const webhookUpdates: Row[] = [];

const mockDb = {
  outgoingWebhookDelivery: {
    findUnique: async () => (delivery ? { ...delivery, webhook } : null),
    update: async ({ data }: { data: Row }) => { deliveryUpdates.push(data); return { ...delivery, ...data }; },
  },
  outgoingWebhook: {
    update: async ({ data }: { data: Row }) => { webhookUpdates.push(data); return { ...webhook, ...data }; },
  },
};
for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}
const cacheMock = { cache: { wrap: async (_k: string, _t: number, loader: () => Promise<unknown>) => loader(), invalidateGuild: async () => {} } };
for (const file of ['cache.ts', 'cache.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => cacheMock);
}

const { attemptDelivery, nextAttemptDelay, MAX_ATTEMPTS, AUTO_DISABLE_AFTER_FAILURES } = await import('../../services/integrations/outgoingWebhookService.js');

const SECRET = 'whsec_test';
const ENVELOPE = { id: 'evt_1', type: 'member.joined', apiVersion: '2026-10-01', createdAt: '2026-10-04T00:00:00.000Z', guildId: 'g1', data: { userId: 'u1' } };

beforeEach(() => {
  deliveryUpdates.length = 0;
  webhookUpdates.length = 0;
  webhook = { id: 'wh1', guildId: 'g1', url: 'https://93.184.216.34/hook', secret: SECRET, enabled: true, consecutiveFailures: 0 };
  delivery = { id: 'del1', webhookId: 'wh1', guildId: 'g1', event: 'member.joined', payload: ENVELOPE, status: 'PENDING', attempts: 0 };
});

function fakeFetch(status: number, onCall?: (init: RequestInit) => void) {
  return (async (_url: unknown, init: RequestInit = {}) => {
    onCall?.(init);
    return new Response('ok', { status });
  }) as never;
}

describe('relances', () => {
  test('délais croissants puis abandon', () => {
    expect(nextAttemptDelay(1)).toBe(60_000);
    expect(nextAttemptDelay(MAX_ATTEMPTS - 1)).toBe(24 * 3_600_000);
    expect(nextAttemptDelay(MAX_ATTEMPTS)).toBeNull();
  });
});

describe('tentative d’envoi', () => {
  test('envoie le corps signé et les en-têtes Kotbo, puis note le succès', async () => {
    let headers: Record<string, string> = {};
    let body = '';
    const result = await attemptDelivery('del1', fakeFetch(200, (init) => {
      headers = init.headers as Record<string, string>;
      body = init.body as string;
      expect(init.redirect).toBe('manual');
    }));

    expect(result?.status).toBe('SUCCESS');
    expect(JSON.parse(body)).toEqual(ENVELOPE);
    expect(headers['Kotbo-Event']).toBe('member.joined');
    expect(headers['Kotbo-Event-Id']).toBe('evt_1');
    expect(verifyWebhookSignature(SECRET, body, headers['Kotbo-Signature'])).toBe(true);
    expect(deliveryUpdates[0]).toMatchObject({ attempts: 1, status: 'SUCCESS', responseStatus: 200, nextAttemptAt: null });
    expect(webhookUpdates[0]).toMatchObject({ consecutiveFailures: 0, lastStatusCode: 200 });
  });

  test('une erreur serveur planifie une relance', async () => {
    const result = await attemptDelivery('del1', fakeFetch(503));
    expect(result?.status).toBe('PENDING');
    expect(deliveryUpdates[0].nextAttemptAt).toBeInstanceOf(Date);
    expect(webhookUpdates[0].consecutiveFailures).toBe(1);
  });

  test('la dernière tentative échoue pour de bon', async () => {
    delivery.attempts = MAX_ATTEMPTS - 1;
    const result = await attemptDelivery('del1', fakeFetch(500));
    expect(result?.status).toBe('FAILED');
    expect(deliveryUpdates[0].nextAttemptAt).toBeNull();
  });

  test('coupe le webhook après trop d’échecs d’affilée', async () => {
    webhook.consecutiveFailures = AUTO_DISABLE_AFTER_FAILURES - 1;
    await attemptDelivery('del1', fakeFetch(500));
    expect(webhookUpdates[0]).toMatchObject({ enabled: false });
    expect(webhookUpdates[0].disabledReason).toContain(String(AUTO_DISABLE_AFTER_FAILURES));
  });

  test('une URL devenue interne échoue sans relance ni appel', async () => {
    webhook.url = 'https://10.0.0.5/hook';
    let called = false;
    const result = await attemptDelivery('del1', fakeFetch(200, () => { called = true; }));
    expect(called).toBe(false);
    expect(result?.status).toBe('FAILED');
  });

  test('un envoi déjà traité n’est pas renvoyé', async () => {
    delivery.status = 'SUCCESS';
    expect(await attemptDelivery('del1', fakeFetch(200))).toBeNull();
  });
});

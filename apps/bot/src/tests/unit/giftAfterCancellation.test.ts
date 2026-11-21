/**
 * Un cadeau activé après une résiliation survit à l'abonnement clos, dont
 * l'identifiant reste sur le serveur : ni sa resynchronisation (rattrapage
 * admin, webhook) ni un transfert ne le remettent en FREE. Seuls la base,
 * Stripe et les services voisins (offre, accès, bot perso, essai) sont simulés.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Stripe } from '../../services/billing/stripeService.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '100000000000000001';
const TARGET_ID = '100000000000000002';

type Row = Record<string, unknown>;
/** Lignes `Guild` par serveur. */
let rows: Record<string, Row> = {};

/** Comme Prisma : une valeur `undefined` laisse la colonne intacte. */
function write(id: string, data: Row): Row {
  rows[id] = { ...rows[id], ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
  return rows[id];
}

const fakePrisma = {
  guild: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = rows[where.id];
      if (!row || !select) return row ?? null;
      return Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null]));
    },
    upsert: async ({ where, update, create }: { where: { id: string }; update: Row; create: Row }) =>
      write(where.id, rows[where.id] ? update : create),
    update: async ({ where, data }: { where: { id: string }; data: Row }) => write(where.id, data),
  },
  $transaction: (writes: Promise<unknown>[]) => Promise.all(writes),
};

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}

function abonnementClos(guildId: string): Stripe.Subscription {
  return {
    id: 'sub_1',
    status: 'canceled',
    customer: 'cus_1',
    metadata: { guildId },
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_plus' }, current_period_end: Math.floor(Date.now() / 1000) }] },
  } as unknown as Stripe.Subscription;
}

mockModule('../../utils/db', { default: fakePrisma, prisma: fakePrisma, prismaRead: fakePrisma });
mockModule('../../services/system/planService', {
  invalidatePlan: async () => {},
  setGuildPlan: async (guildId: string, plan: string) => {
    write(guildId, { plan });
  },
});
mockModule('../../services/system/accessService', { markAccessExpired: async () => false });
mockModule('../../services/system/customBotRetire', { retireCustomBotIfIneligible: async () => {} });
mockModule('../../services/billing/trialService', {});
// Stripe accepte tout : seul transferSubscription peut refuser le transfert.
mockModule('../../services/billing/stripeService', {
  getStripe: () => ({
    customers: { update: async () => ({}) },
    subscriptions: { update: async () => ({}), retrieve: async () => abonnementClos(TARGET_ID) },
  }),
});

const { syncSubscription, transferSubscription } = await import('../../services/billing/subscriptionSync.js');

beforeEach(() => {
  // Abonnement résilié, puis code cadeau PRO activé.
  rows = {
    [GUILD_ID]: { id: GUILD_ID, plan: 'PRO', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeSubscriptionStatus: 'canceled' },
  };
});

describe('cadeau activé après une résiliation', () => {
  test("la resynchronisation de l'abonnement clos garde l'offre du cadeau", async () => {
    await syncSubscription(abonnementClos(GUILD_ID));

    expect(rows[GUILD_ID].plan).toBe('PRO');
  });

  test("la fin d'un abonnement qui couvrait le serveur le remet bien en FREE", async () => {
    rows[GUILD_ID] = { ...rows[GUILD_ID], plan: 'PLUS', stripeSubscriptionStatus: 'active' };

    await syncSubscription(abonnementClos(GUILD_ID));

    expect(rows[GUILD_ID].plan).toBe('FREE');
  });

  test("l'abonnement clos ne se transfère pas : rien ne bouge et le cadeau reste", async () => {
    const before = structuredClone(rows);

    await expect(transferSubscription(GUILD_ID, TARGET_ID, null)).rejects.toThrow("Ce serveur n'a pas d'abonnement à transférer.");

    expect(rows).toEqual(before);
  });
});

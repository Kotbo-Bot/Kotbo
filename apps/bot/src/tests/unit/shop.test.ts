/**
 * Boutique : offres relues, remises, et règles d'accès d'une offre.
 */
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { discountedShopPrice, normalizeShopCode, normalizeShopOffer } from '@kotbo/shared';
import { completeModuleMock } from '../helpers/moduleMock.js';

const counts = { orders: 0, debits: 0, subscription: null as null | { status: string; endedAt?: Date } };
type OrderRow = { status: string; source: string; createdAt: Date; decidedAt?: Date | null };
let orderRows: OrderRow[] = [];
type OrderWhere = { status?: string | { in: string[] }; source?: { not: string }; createdAt?: { gt: Date }; decidedAt?: { gt: Date }; OR?: OrderWhere[] };
const matches = (o: OrderRow, w: OrderWhere = {}): boolean =>
  (w.status === undefined || (typeof w.status === 'string' ? o.status === w.status : w.status.in.includes(o.status)))
  && (w.source === undefined || o.source !== w.source.not)
  && (w.createdAt === undefined || o.createdAt > w.createdAt.gt)
  && (w.decidedAt === undefined || (!!o.decidedAt && o.decidedAt > w.decidedAt.gt))
  && (w.OR === undefined || w.OR.some((branch) => matches(o, branch)));
let offerRow: unknown = null;
mock.module('../../utils/db.js', () => {
  const db = {
    shopOrder: {
      count: async ({ where }: { where?: OrderWhere } = {}) => counts.orders + orderRows.filter((o) => matches(o, where)).length,
      create: async ({ data }: { data: OrderRow }) => { orderRows.push({ ...data, createdAt: new Date() }); return data; },
    },
    shopSubscription: {
      findUnique: async () => counts.subscription,
      update: async () => ({}),
      upsert: async () => ({}),
      create: async () => ({}),
    },
    memberLevel: { findUnique: async () => null },
    shopSettings: { findUnique: async () => null },
    shopOffer: { findFirst: async () => offerRow },
    rpgProfile: { updateMany: async () => { counts.debits += 1; return { count: 1 }; } },
    $executeRaw: async () => 0,
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { default: db, prisma: db, prismaRead: db };
});
for (const [module, overrides] of [
  ['features/economyService', { getOrCreateRpgProfile: async () => ({ id: 'profil' }) }],
  ['core/moduleGate', { getModuleStates: async () => ({}) }],
] as const) {
  mock.module(`../../services/${module}.js`, () => completeModuleMock(path.resolve(import.meta.dir, `../../services/${module}.ts`), overrides));
}

const { offerBlocker, purchaseShopOffer } = await import('../../services/shop/shopService.js');

const ROLE = '111111111111111111';
const OTHER_ROLE = '222222222222222222';

describe('offres', () => {
  test('un rôle est exigé pour vendre un rôle ou un abonnement', () => {
    expect(normalizeShopOffer({ kind: 'ROLE', name: 'VIP', price: 100 })).toEqual({ error: 'role_required' });
    expect(normalizeShopOffer({ kind: 'SUBSCRIPTION', name: 'VIP', price: 100, roleId: ROLE })).toEqual({ error: 'invalid_duration' });
    const ok = normalizeShopOffer({ kind: 'SUBSCRIPTION', name: 'VIP', price: 100, roleId: ROLE, durationDays: 30, giftable: true });
    expect('offer' in ok && ok.offer.giftable).toBe(false);
  });

  test('un changement de type ne laisse pas traîner les champs de l’ancien', () => {
    const res = normalizeShopOffer({ kind: 'XP', name: 'Boost', price: 50, roleId: ROLE, durationDays: 7, quantity: 500, itemId: 'abcdefghijklmnopqrstu' });
    expect('offer' in res && res.offer).toMatchObject({ roleId: null, durationDays: null, itemId: null, quantity: 500 });
  });

  test('une prestation passe toujours par le staff', () => {
    const res = normalizeShopOffer({ kind: 'CUSTOM', name: 'Emoji perso', price: 1000, requiresApproval: false });
    expect('offer' in res && res.offer.requiresApproval).toBe(true);
  });

  test('prix et bornes', () => {
    expect(normalizeShopOffer({ kind: 'XP', name: 'x', price: 'abc', quantity: 1 })).toEqual({ error: 'invalid_price' });
    const res = normalizeShopOffer({ kind: 'XP', name: 'x', price: -5, quantity: 1, imageUrl: 'javascript:alert(1)', requiredRoleIds: [ROLE, ROLE, 'nope'] });
    expect('offer' in res && res.offer).toMatchObject({ price: 0, imageUrl: null, requiredRoleIds: [ROLE] });
  });
});

describe('codes promo', () => {
  test('code normalisé', () => {
    expect(normalizeShopCode(' noel-2026 ')).toBe('NOEL-2026');
    expect(normalizeShopCode('a')).toBeNull();
    expect(normalizeShopCode('code avec espace')).toBeNull();
  });

  test('remise jamais négative, pourcentage arrondi au profit du membre', () => {
    expect(discountedShopPrice(99, { percentOff: 10, amountOff: null })).toBe(89);
    expect(discountedShopPrice(100, { percentOff: null, amountOff: 250 })).toBe(0);
    expect(discountedShopPrice(100, null)).toBe(100);
  });
});

describe('accès à une offre', () => {
  const offer = (over: Record<string, unknown> = {}) =>
    ({
      id: 'offer1',
      guildId: 'g',
      kind: 'ROLE',
      enabled: true,
      stock: null,
      perMemberLimit: null,
      requiredRoleIds: [],
      minLevel: 0,
      roleId: ROLE,
      durationDays: null,
      ...over,
    }) as never;
  const member = (roles: string[]) => ({ id: '333333333333333333', roles: { cache: { has: (id: string) => roles.includes(id) } } }) as never;
  const modules = { economy: true, leveling: true };

  test('rôle requis, stock épuisé, rôle déjà possédé', async () => {
    expect(await offerBlocker(offer({ requiredRoleIds: [OTHER_ROLE] }), member([]), { modules })).toBe('missing_role');
    expect(await offerBlocker(offer({ requiredRoleIds: [OTHER_ROLE] }), member([OTHER_ROLE]), { modules })).toBeNull();
    expect(await offerBlocker(offer({ stock: 0 }), member([]), { modules })).toBe('out_of_stock');
    expect(await offerBlocker(offer(), member([ROLE]), { modules })).toBe('already_owned');
    // Un rôle temporaire se prolonge : le posséder n'empêche pas de le racheter.
    expect(await offerBlocker(offer({ durationDays: 7 }), member([ROLE]), { modules })).toBeNull();
  });

  test('limite par membre et abonnement en cours', async () => {
    counts.orders = 2;
    expect(await offerBlocker(offer({ perMemberLimit: 2, durationDays: 7 }), member([]), { modules })).toBe('limit_reached');
    counts.orders = 0;
    counts.subscription = { status: 'GRACE' };
    expect(await offerBlocker(offer({ kind: 'SUBSCRIPTION', durationDays: 30 }), member([]), { modules })).toBe('already_subscribed');
    counts.subscription = { status: 'ENDED' };
    expect(await offerBlocker(offer({ kind: 'SUBSCRIPTION', durationDays: 30 }), member([]), { modules })).toBeNull();
  });

  test('modules éteints', async () => {
    expect(await offerBlocker(offer(), member([]), { modules: { economy: false } })).toBe('economy_disabled');
    expect(await offerBlocker(offer({ kind: 'XP' }), member([]), { modules: { economy: true, leveling: false } })).toBe('leveling_disabled');
  });

  const buyer = {
    id: '333333333333333333',
    roles: { cache: { has: () => false }, add: async () => {} },
    guild: { id: 'g', roles: { cache: { get: (id: string) => ({ id, editable: true, permissions: { bitfield: 0n } }) } } },
  };
  const client = { guilds: { cache: { get: () => ({ members: { fetch: async () => buyer } }) } } } as never;

  test('abonnement ou rôle permanent en attente ou en cours de livraison : pas de second paiement', async () => {
    counts.subscription = null;
    for (const [kind, refus, requiresApproval] of [
      ['SUBSCRIPTION', 'already_subscribed', true],
      ['SUBSCRIPTION', 'already_subscribed', false],
      ['ROLE', 'already_owned', true],
      // Le rôle part après la commande : le second clic arrive avant qu'il soit porté.
      ['ROLE', 'already_owned', false],
    ] as const) {
      Object.assign(counts, { orders: 0, debits: 0 });
      orderRows = [];
      offerRow = offer({ kind, price: 100, requiresApproval });
      // Livraison pas encore faite : l'abonnement n'existe pas encore en base.
      counts.subscription = null;
      await purchaseShopOffer(client, 'g', buyer.id, 'offer1', { source: 'discord' });
      await expect(purchaseShopOffer(client, 'g', buyer.id, 'offer1', { source: 'discord' })).rejects.toMatchObject({ code: refus });
      expect(counts.debits).toBe(1);
    }
  });

  test('un abonnement terminé se rachète', async () => {
    Object.assign(counts, { orders: 0, debits: 0 });
    orderRows = [{ status: 'COMPLETED', source: 'discord', createdAt: new Date(Date.now() - 60_000) }];
    counts.subscription = { status: 'ENDED', endedAt: new Date(Date.now() - 1_000) };
    offerRow = offer({ kind: 'SUBSCRIPTION', price: 100, requiresApproval: true });
    await purchaseShopOffer(client, 'g', buyer.id, 'offer1', { source: 'discord' });
    expect(counts.debits).toBe(1);
  });

  test('un rôle permanent perdu se rachète, mais pas pendant sa livraison après validation', async () => {
    Object.assign(counts, { orders: 0, debits: 0 });
    const hier = new Date(Date.now() - 86_400_000);
    offerRow = offer({ kind: 'ROLE', price: 100 });
    // Validée à l'instant par le staff : le rôle est en route, le membre ne le porte pas encore.
    orderRows = [{ status: 'COMPLETED', source: 'discord', createdAt: hier, decidedAt: new Date() }];
    await expect(purchaseShopOffer(client, 'g', buyer.id, 'offer1', { source: 'discord' })).rejects.toMatchObject({ code: 'already_owned' });
    // Livré hier puis perdu (départ, retrait par le staff) : le membre ne le porte plus.
    orderRows = [{ status: 'COMPLETED', source: 'discord', createdAt: hier, decidedAt: null }];
    await purchaseShopOffer(client, 'g', buyer.id, 'offer1', { source: 'discord' });
    expect(counts.debits).toBe(1);
  });
});

/**
 * Boutique : offres relues, remises, et règles d'accès d'une offre.
 */
import { describe, expect, mock, test } from 'bun:test';
import { discountedShopPrice, normalizeShopCode, normalizeShopOffer } from '@kotbo/shared';

const counts = { orders: 0, subscription: null as null | { status: string } };
mock.module('../../utils/db.js', () => {
  const db = {
    shopOrder: { count: async () => counts.orders },
    shopSubscription: { findUnique: async () => counts.subscription },
    memberLevel: { findUnique: async () => null },
  };
  return { default: db, prisma: db, prismaRead: db };
});

const { offerBlocker } = await import('../../services/shop/shopService.js');

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
});

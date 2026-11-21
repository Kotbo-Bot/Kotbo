/**
 * Boutique du serveur (onglet Boutique d'Économie). Vit sous `/api/shop-admin`,
 * pas sous `/api/dashboard/guilds` : c'est la même boutique que le site du serveur.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { CHANNELS, DAY, PEOPLE, ROLES, ago, channelByName, role } from '../fixtures';

const BASE = '/api/shop-admin/:guildId';

const offer = (n: number, kind: string, name: string, price: number, extra: Record<string, unknown> = {}) => ({
  id: `offer-${n}`,
  kind,
  name,
  description: '',
  imageUrl: null,
  category: null,
  price,
  roleId: null,
  durationDays: null,
  itemId: null,
  quantity: 1,
  stock: null,
  perMemberLimit: null,
  requiredRoleIds: [],
  minLevel: 0,
  requiresApproval: false,
  giftable: true,
  enabled: true,
  sortOrder: n,
  sales30d: { count: 0, revenue: 0 },
  ...extra,
});

const offersSeed = () => [
  offer(1, 'ROLE', 'Rôle Habitué', 2_500, { description: 'Couleur rose et accès au salon des habitués.', category: 'Rôles', roleId: role('Habitué').id, minLevel: 10, sales30d: { count: 6, revenue: 15_000 } }),
  offer(2, 'SUBSCRIPTION', 'Pass VIP (30 jours)', 4_000, { description: 'Badge VIP et bonus d’XP pendant un mois.', category: 'Rôles', roleId: role('Habitué').id, durationDays: 30, sales30d: { count: 3, revenue: 12_000 } }),
  offer(3, 'ITEM', 'Potion de soin x5', 300, { description: 'Pour le RPG : rend 50 PV.', category: 'RPG', itemId: 'health_potion', quantity: 5, sales30d: { count: 21, revenue: 6_300 } }),
  offer(4, 'XP', 'Boost de 1 000 XP', 1_200, { description: 'Gagne 1 000 XP d’un coup.', category: 'Niveaux', quantity: 1_000, perMemberLimit: 1, sales30d: { count: 4, revenue: 4_800 } }),
  offer(5, 'CUSTOM', 'Pseudo personnalisé', 5_000, { description: 'Le staff change ton pseudo comme tu veux (dans le respect du règlement).', category: 'Spécial', requiresApproval: true, stock: 5, sales30d: { count: 2, revenue: 10_000 } }),
];

const codesSeed = () => [
  { id: 'code-1', code: 'AUTOMNE10', percentOff: 10, amountOff: null, maxUses: 50, uses: 12, offerIds: [], expiresAt: ago(-20 * DAY), enabled: true },
  { id: 'code-2', code: 'BIENVENUE', percentOff: null, amountOff: 200, maxUses: null, uses: 31, offerIds: ['offer-1'], expiresAt: null, enabled: true },
];

function ordersSeed() {
  const [buyerA, buyerB, buyerC] = PEOPLE.filter((p) => !p.bot).slice(6, 9);
  const order = (id: string, offerId: string, offerName: string, kind: string, buyer: (typeof PEOPLE)[number], price: number, status: string, createdAt: string, note: string | null = null) => ({
    id, offerId, offerName, kind, buyerId: buyer.id, recipientId: buyer.id, buyerName: buyer.displayName, recipientName: buyer.displayName,
    price, listPrice: price, status, source: 'discord', note, refusalReason: null, createdAt,
  });
  return [
    order('order-1', 'offer-5', 'Pseudo personnalisé', 'CUSTOM', buyerA, 5_000, 'PENDING', ago(95), 'Je voudrais « Lina la Fée » 🙏'),
    order('order-2', 'offer-5', 'Pseudo personnalisé', 'CUSTOM', buyerB, 5_000, 'PENDING', ago(26 * 60), 'Noé ⚡'),
    order('order-3', 'offer-3', 'Potion de soin x5', 'ITEM', buyerC, 300, 'COMPLETED', ago(3 * 60)),
    order('order-4', 'offer-1', 'Rôle Habitué', 'ROLE', buyerA, 2_250, 'COMPLETED', ago(2 * DAY)),
    order('order-5', 'offer-4', 'Boost de 1 000 XP', 'XP', buyerB, 1_200, 'COMPLETED', ago(4 * DAY)),
  ];
}

const settingsSeed = () => ({ enabled: true, approvalChannelId: channelByName('staff').id, logChannelId: channelByName('logs').id, graceDays: 3 });

const get = <T>(key: string, seed: () => T) => demoDb.get(`shop/${key}`, seed);
const set = <T>(key: string, value: T) => demoDb.set(`shop/${key}`, value);

export function registerShopRoutes(): void {
  route('GET', BASE, () => {
    const orders = get('orders', ordersSeed);
    return {
      settings: get('settings', settingsSeed),
      currency: { name: 'Pièces', emoji: '🪙' },
      channels: CHANNELS.filter((c) => c.type !== 'voice').map((c) => ({ id: c.id, name: c.name })),
      offers: get('offers', offersSeed),
      codes: get('codes', codesSeed),
      pending: orders.filter((o) => o.status === 'PENDING'),
      recent: orders.filter((o) => o.status !== 'PENDING'),
      items: [
        { id: 'health_potion', name: 'Potion de soin', emoji: '🧪', type: 'CONSUMABLE' },
        { id: 'iron_sword', name: 'Épée en fer', emoji: '🗡️', type: 'WEAPON' },
        { id: 'golden_rod', name: 'Canne dorée', emoji: '🎣', type: 'TOOL' },
      ],
      roles: ROLES.filter((r) => !r.managed).map((r) => ({ id: r.id, name: r.name, color: r.color, assignable: r.position < 9 })),
    };
  });
  route('PUT', `${BASE}/settings`, ({ body }) => ({ settings: set('settings', { ...get('settings', settingsSeed), ...(body ?? {}) }) }));

  route('POST', `${BASE}/offers`, ({ body }) => {
    const offers = get('offers', offersSeed);
    const created = { ...offer(offers.length + 1, body?.kind ?? 'CUSTOM', body?.name ?? 'Nouvelle offre', body?.price ?? 100), ...(body ?? {}), id: demoId(), sales30d: { count: 0, revenue: 0 } };
    set('offers', [...offers, created]);
    return { id: created.id };
  });
  route('PATCH', `${BASE}/offers/:id`, ({ params, body }) => {
    set('offers', get('offers', offersSeed).map((o) => (o.id === params.id ? { ...o, ...(body ?? {}) } : o)));
    return { ok: true };
  });
  route('DELETE', `${BASE}/offers/:id`, ({ params }) => {
    set('offers', get('offers', offersSeed).filter((o) => o.id !== params.id));
    return { ok: true, result: 'deleted' };
  });
  route('POST', `${BASE}/offers/reorder`, ({ body }) => {
    const ids: string[] = body?.ids ?? body?.order ?? [];
    const offers = get('offers', offersSeed);
    if (ids.length) set('offers', offers.map((o) => ({ ...o, sortOrder: Math.max(0, ids.indexOf(o.id)) })).sort((a, b) => a.sortOrder - b.sortOrder));
    return { ok: true };
  });

  route('POST', `${BASE}/codes`, ({ body }) => {
    const code = { id: demoId(), code: String(body?.code ?? 'CODE').toUpperCase(), percentOff: body?.percentOff ?? null, amountOff: body?.amountOff ?? null, maxUses: body?.maxUses ?? null, uses: 0, offerIds: body?.offerIds ?? [], expiresAt: body?.expiresAt ?? null, enabled: true };
    set('codes', [...get('codes', codesSeed), code]);
    return { id: code.id };
  });
  route('PATCH', `${BASE}/codes/:id`, ({ params, body }) => {
    set('codes', get('codes', codesSeed).map((c) => (c.id === params.id ? { ...c, ...(body ?? {}) } : c)));
    return { ok: true };
  });
  route('DELETE', `${BASE}/codes/:id`, ({ params }) => {
    set('codes', get('codes', codesSeed).filter((c) => c.id !== params.id));
    return { ok: true };
  });

  route('POST', `${BASE}/orders/:id/decide`, ({ params, body }) => {
    const status = body?.approve === false || body?.decision === 'REFUSE' || body?.status === 'REFUSED' ? 'REFUSED' : 'COMPLETED';
    set('orders', get('orders', ordersSeed).map((o) => (o.id === params.id ? { ...o, status, refusalReason: status === 'REFUSED' ? body?.reason ?? null : null } : o)));
    return { ok: true, status };
  });
}

/**
 * Boutique du serveur : offres vendues en monnaie du bot, sur le site et sur
 * Discord. Règles partagées par le bot (qui fait foi) et le dashboard (qui
 * prévient avant d'envoyer).
 */

export const SHOP_OFFER_KINDS = ['ROLE', 'ITEM', 'XP', 'SUBSCRIPTION', 'CUSTOM'] as const;
export type ShopOfferKind = (typeof SHOP_OFFER_KINDS)[number];

export const SHOP_LIMITS = {
  offers: 100,
  promoCodes: 100,
  name: 80,
  description: 600,
  category: 40,
  note: 500,
  price: 100_000_000,
  quantity: 1_000,
  xp: 1_000_000,
  durationDays: 365,
  stock: 1_000_000,
  perMemberLimit: 1_000,
  minLevel: 1_000,
  requiredRoles: 10,
  graceDays: 14,
  code: 32,
} as const;

export function isShopOfferKind(value: unknown): value is ShopOfferKind {
  return typeof value === 'string' && (SHOP_OFFER_KINDS as readonly string[]).includes(value);
}

export interface ShopOfferInput {
  kind: ShopOfferKind;
  name: string;
  description: string;
  imageUrl: string | null;
  category: string | null;
  price: number;
  roleId: string | null;
  durationDays: number | null;
  itemId: string | null;
  quantity: number;
  stock: number | null;
  perMemberLimit: number | null;
  requiredRoleIds: string[];
  minLevel: number;
  requiresApproval: boolean;
  giftable: boolean;
  enabled: boolean;
}

export type ShopOfferError =
  | 'invalid_kind'
  | 'name_required'
  | 'invalid_price'
  | 'role_required'
  | 'item_required'
  | 'invalid_duration'
  | 'invalid_quantity';

const SNOWFLAKE = /^\d{17,20}$/;

function int(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Offre relue champ par champ. Une offre reçoit les champs qui la concernent ;
 * les autres sont remis à zéro pour qu'un changement de type ne laisse pas un
 * rôle traîner sur une offre d'XP.
 */
export function normalizeShopOffer(raw: Record<string, unknown>): { offer: ShopOfferInput } | { error: ShopOfferError } {
  if (!isShopOfferKind(raw.kind)) return { error: 'invalid_kind' };
  const kind = raw.kind;
  const name = text(raw.name, SHOP_LIMITS.name);
  if (!name) return { error: 'name_required' };
  const price = int(raw.price, 0, SHOP_LIMITS.price);
  if (price === null) return { error: 'invalid_price' };

  const roleId = typeof raw.roleId === 'string' && SNOWFLAKE.test(raw.roleId) ? raw.roleId : null;
  if ((kind === 'ROLE' || kind === 'SUBSCRIPTION') && !roleId) return { error: 'role_required' };
  const itemId = typeof raw.itemId === 'string' && /^[a-z0-9]{20,32}$/i.test(raw.itemId) ? raw.itemId : null;
  if (kind === 'ITEM' && !itemId) return { error: 'item_required' };

  let durationDays: number | null = null;
  if (kind === 'ROLE' && raw.durationDays !== null && raw.durationDays !== undefined && raw.durationDays !== '') {
    durationDays = int(raw.durationDays, 1, SHOP_LIMITS.durationDays);
    if (durationDays === null) return { error: 'invalid_duration' };
  }
  if (kind === 'SUBSCRIPTION') {
    durationDays = int(raw.durationDays, 1, SHOP_LIMITS.durationDays);
    if (durationDays === null) return { error: 'invalid_duration' };
  }

  let quantity = 1;
  if (kind === 'ITEM' || kind === 'XP') {
    const q = int(raw.quantity, 1, kind === 'XP' ? SHOP_LIMITS.xp : SHOP_LIMITS.quantity);
    if (q === null) return { error: 'invalid_quantity' };
    quantity = q;
  }

  const optionalInt = (value: unknown, min: number, max: number) =>
    value === null || value === undefined || value === '' ? null : int(value, min, max);

  const imageUrl = typeof raw.imageUrl === 'string' && /^https:\/\/\S+$/i.test(raw.imageUrl.trim()) ? raw.imageUrl.trim().slice(0, 500) : null;

  return {
    offer: {
      kind,
      name,
      description: text(raw.description, SHOP_LIMITS.description),
      imageUrl,
      category: text(raw.category, SHOP_LIMITS.category) || null,
      price,
      roleId: kind === 'ROLE' || kind === 'SUBSCRIPTION' ? roleId : null,
      durationDays,
      itemId: kind === 'ITEM' ? itemId : null,
      quantity,
      stock: optionalInt(raw.stock, 0, SHOP_LIMITS.stock),
      perMemberLimit: optionalInt(raw.perMemberLimit, 1, SHOP_LIMITS.perMemberLimit),
      requiredRoleIds: Array.isArray(raw.requiredRoleIds)
        ? [...new Set(raw.requiredRoleIds.filter((id): id is string => typeof id === 'string' && SNOWFLAKE.test(id)))].slice(0, SHOP_LIMITS.requiredRoles)
        : [],
      minLevel: int(raw.minLevel, 0, SHOP_LIMITS.minLevel) ?? 0,
      // Une prestation se livre à la main : le staff valide toujours.
      requiresApproval: kind === 'CUSTOM' ? true : raw.requiresApproval === true,
      // Un abonnement se prélève sur le compte de celui qui en profite.
      giftable: kind === 'SUBSCRIPTION' ? false : raw.giftable !== false,
      enabled: raw.enabled !== false,
    },
  };
}

// ─── Codes promo ─────────────────────────────────────────────────────────────

/** Code promo saisi : majuscules, lettres, chiffres, tirets. */
export function normalizeShopCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code) ? code : null;
}

export interface ShopDiscount {
  percentOff: number | null;
  amountOff: number | null;
}

/** Prix après remise, jamais négatif. Le pourcentage est arrondi au profit du membre. */
export function discountedShopPrice(price: number, discount: ShopDiscount | null): number {
  if (!discount) return price;
  let result = price;
  if (discount.percentOff) result = Math.floor((price * (100 - Math.min(100, Math.max(0, discount.percentOff)))) / 100);
  else if (discount.amountOff) result = price - Math.max(0, discount.amountOff);
  return Math.max(0, result);
}

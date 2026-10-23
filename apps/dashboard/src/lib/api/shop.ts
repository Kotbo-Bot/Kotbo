/**
 * Boutique du serveur (`/boutique` sur Discord) : offres, codes promo,
 * commandes à valider et réglages. Droits de la section Économie.
 */
import type { ShopOfferKind } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { apiRequest } from './client';

const base = (guildId: string) => `/api/shop-admin/${guildId}`;
const gid = (guildId?: string | null) => guildId || authStore.selectedGuildId || '';

export interface ShopSettingsAdmin {
  enabled: boolean;
  approvalChannelId: string | null;
  logChannelId: string | null;
  graceDays: number;
}

export interface ShopOfferAdmin {
  id: string;
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
  sortOrder: number;
  sales30d: { count: number; revenue: number };
}

export interface ShopPromoCodeAdmin {
  id: string;
  code: string;
  percentOff: number | null;
  amountOff: number | null;
  maxUses: number | null;
  uses: number;
  offerIds: string[];
  expiresAt: string | null;
  enabled: boolean;
}

export interface ShopOrderAdmin {
  id: string;
  offerId: string | null;
  offerName: string;
  kind: ShopOfferKind;
  buyerId: string;
  recipientId: string;
  buyerName: string;
  recipientName: string;
  price: number;
  listPrice: number;
  status: 'PENDING' | 'COMPLETED' | 'REFUSED';
  source: string;
  note: string | null;
  refusalReason: string | null;
  createdAt: string;
}

export interface ShopAdminState {
  settings: ShopSettingsAdmin;
  currency: { name: string; emoji: string };
  /** Salons où le bot peut écrire (validation des commandes, journal). */
  channels: Array<{ id: string; name: string }>;
  offers: ShopOfferAdmin[];
  codes: ShopPromoCodeAdmin[];
  pending: ShopOrderAdmin[];
  recent: ShopOrderAdmin[];
  items: Array<{ id: string; name: string; emoji: string; type: string }>;
  roles: Array<{ id: string; name: string; color: string; assignable: boolean }>;
}

export function fetchShopAdmin(guildId?: string) {
  return apiRequest<ShopAdminState>(`${base(gid(guildId))}`, { errorContext: 'API Error (Shop):' });
}

export function saveShopSettingsAdmin(input: Partial<ShopSettingsAdmin>, guildId?: string) {
  return apiRequest<{ settings: ShopSettingsAdmin }>(`${base(gid(guildId))}/settings`, { method: 'PUT', payload: input, errorContext: 'API Error (Shop settings):' });
}

export function createShopOffer(input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ id: string }>(`${base(gid(guildId))}/offers`, { method: 'POST', payload: input, errorContext: 'API Error (Create shop offer):' });
}

export function updateShopOffer(id: string, input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/offers/${id}`, { method: 'PATCH', payload: input, errorContext: 'API Error (Update shop offer):' });
}

export function deleteShopOffer(id: string, guildId?: string) {
  return apiRequest<{ ok: boolean; result: 'deleted' | 'disabled' }>(`${base(gid(guildId))}/offers/${id}`, { method: 'DELETE', errorContext: 'API Error (Delete shop offer):' });
}

export function reorderShopOffers(ids: string[], guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/offers/reorder`, { method: 'POST', payload: { ids }, errorContext: 'API Error (Reorder shop offers):' });
}

export function createShopCode(input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ id: string }>(`${base(gid(guildId))}/codes`, { method: 'POST', payload: input, errorContext: 'API Error (Create promo code):' });
}

export function updateShopCode(id: string, input: Record<string, unknown>, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/codes/${id}`, { method: 'PATCH', payload: input, errorContext: 'API Error (Update promo code):' });
}

export function deleteShopCode(id: string, guildId?: string) {
  return apiRequest<{ ok: boolean }>(`${base(gid(guildId))}/codes/${id}`, { method: 'DELETE', errorContext: 'API Error (Delete promo code):' });
}

export function decideShopOrder(id: string, approve: boolean, reason: string, guildId?: string) {
  return apiRequest<{ ok: boolean; status: string }>(`${base(gid(guildId))}/orders/${id}/decide`, { method: 'POST', payload: { approve, reason }, errorContext: 'API Error (Decide shop order):' });
}

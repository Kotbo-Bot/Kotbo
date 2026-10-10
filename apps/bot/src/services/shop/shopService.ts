/**
 * Boutique du serveur, payée en monnaie du bot, sur le site et sur Discord.
 *
 * Un achat se règle en une transaction : stock, utilisation du code promo,
 * débit conditionnel du solde et commande. La livraison (rôle, objets, XP,
 * abonnement) suit ; si elle échoue, le membre est remboursé. Une offre soumise
 * à validation reste payée en attente : refusée, elle est remboursée.
 *
 * Les règles d'une offre (rôles ou niveau requis, limite par membre) portent
 * sur le bénéficiaire, qui n'est l'acheteur que hors cadeau.
 */

import { EmbedBuilder, type Client, type Guild, type GuildMember } from 'discord.js';
import { Prisma, type ShopOffer, type ShopOrder, type ShopPromoCode } from '@prisma/client';
import {
  discountedShopPrice,
  normalizeShopCode,
  normalizeShopOffer,
  SHOP_LIMITS,
  type ShopOfferError,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { getModuleStates } from '../core/moduleGate.js';
import { adminSpawnItem, creditBalance, getOrCreateRpgProfile } from '../features/economyService.js';
import { addXp, getGuildLevelCurve, getLevelFromXp } from '../progression/levelingService.js';
import { notifySiteMember } from '../site/siteNotifyService.js';
import { publishGuildSignal } from '../site/siteLive.js';

export type ShopErrorCode =
  | ShopOfferError
  | 'shop_disabled'
  | 'economy_disabled'
  | 'leveling_disabled'
  | 'offer_missing'
  | 'order_missing'
  | 'order_decided'
  | 'out_of_stock'
  | 'limit_reached'
  | 'missing_role'
  | 'level_too_low'
  | 'already_owned'
  | 'already_subscribed'
  | 'not_giftable'
  | 'recipient_missing'
  | 'insufficient_funds'
  | 'invalid_code'
  | 'code_expired'
  | 'code_exhausted'
  | 'code_used'
  | 'code_not_applicable'
  | 'code_taken'
  | 'invalid_discount'
  | 'role_unmanageable'
  | 'item_missing'
  | 'delivery_failed'
  | 'subscription_missing'
  | 'too_many_offers'
  | 'too_many_codes';

export class ShopError extends Error {
  constructor(
    readonly code: ShopErrorCode,
    readonly status = 400,
  ) {
    super(code);
  }
}

// ─── Réglages ───────────────────────────────────────────────────────────────

export async function getShopSettings(guildId: string) {
  const row = await prisma.shopSettings.findUnique({ where: { guildId } });
  return row ?? { guildId, enabled: true, approvalChannelId: null, logChannelId: null, graceDays: 3 };
}

const SNOWFLAKE = /^\d{17,20}$/;

export async function saveShopSettings(guildId: string, input: Record<string, unknown>) {
  const data: Prisma.ShopSettingsUpdateInput = {};
  if (typeof input.enabled === 'boolean') data.enabled = input.enabled;
  for (const key of ['approvalChannelId', 'logChannelId'] as const) {
    if (input[key] === null || input[key] === '') data[key] = null;
    else if (typeof input[key] === 'string' && SNOWFLAKE.test(input[key] as string)) data[key] = input[key] as string;
  }
  if (input.graceDays !== undefined) {
    const n = Math.floor(Number(input.graceDays));
    if (Number.isFinite(n)) data.graceDays = Math.min(SHOP_LIMITS.graceDays, Math.max(0, n));
  }
  return prisma.shopSettings.upsert({
    where: { guildId },
    create: { ...(data as Omit<Prisma.ShopSettingsCreateInput, 'guildId'>), guildId },
    update: data,
  });
}

// ─── Offres ─────────────────────────────────────────────────────────────────

export async function listShopOffers(guildId: string, options: { includeDisabled?: boolean } = {}) {
  return prisma.shopOffer.findMany({
    where: { guildId, ...(options.includeDisabled ? {} : { enabled: true }) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function saveShopOffer(client: Client, guildId: string, id: string | null, raw: Record<string, unknown>): Promise<ShopOffer> {
  const existing = id ? await prisma.shopOffer.findFirst({ where: { id, guildId } }) : null;
  if (id && !existing) throw new ShopError('offer_missing', 404);
  const normalized = normalizeShopOffer({ ...(existing ?? {}), ...raw });
  if ('error' in normalized) throw new ShopError(normalized.error);
  const offer = normalized.offer;

  if (offer.roleId) {
    const guild = await resolveGuild(client, guildId);
    const role = guild?.roles.cache.get(offer.roleId) ?? (await guild?.roles.fetch(offer.roleId).catch(() => null));
    if (guild && (!role || !role.editable || role.managed || role.id === guild.id)) throw new ShopError('role_unmanageable');
  }
  if (offer.itemId) {
    const item = await prisma.rpgItem.findFirst({ where: { id: offer.itemId, OR: [{ guildId }, { guildId: null }] }, select: { id: true } });
    if (!item) throw new ShopError('item_missing');
  }

  if (existing) return prisma.shopOffer.update({ where: { id: existing.id }, data: offer });
  const total = await prisma.shopOffer.count({ where: { guildId } });
  if (total >= SHOP_LIMITS.offers) throw new ShopError('too_many_offers', 409);
  return prisma.shopOffer.create({ data: { ...offer, guildId, sortOrder: total } });
}

/**
 * Retire une offre. Un abonnement en cours n'est pas coupé net : l'offre est
 * masquée et les abonnés vont au bout de la période payée.
 */
export async function deleteShopOffer(guildId: string, id: string): Promise<'deleted' | 'disabled'> {
  const offer = await prisma.shopOffer.findFirst({ where: { id, guildId } });
  if (!offer) return 'deleted';
  const running = await prisma.shopSubscription.updateMany({
    where: { offerId: id, status: { in: ['ACTIVE', 'GRACE'] } },
    data: { cancelAtPeriodEnd: true },
  });
  if (running.count > 0) {
    await prisma.shopOffer.update({ where: { id }, data: { enabled: false } });
    return 'disabled';
  }
  await prisma.shopOffer.delete({ where: { id } });
  return 'deleted';
}

export async function reorderShopOffers(guildId: string, ids: unknown): Promise<void> {
  if (!Array.isArray(ids)) return;
  await prisma.$transaction(
    ids
      .filter((id): id is string => typeof id === 'string')
      .slice(0, SHOP_LIMITS.offers)
      .map((id, index) => prisma.shopOffer.updateMany({ where: { id, guildId }, data: { sortOrder: index } })),
  );
}

// ─── Codes promo ────────────────────────────────────────────────────────────

export async function listShopPromoCodes(guildId: string) {
  return prisma.shopPromoCode.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' } });
}

export async function saveShopPromoCode(guildId: string, id: string | null, raw: Record<string, unknown>): Promise<ShopPromoCode> {
  const existing = id ? await prisma.shopPromoCode.findFirst({ where: { id, guildId } }) : null;
  if (id && !existing) throw new ShopError('invalid_code', 404);
  const code = raw.code !== undefined ? normalizeShopCode(raw.code) : existing?.code ?? null;
  if (!code) throw new ShopError('invalid_code');

  const percent = raw.percentOff !== undefined ? Number(raw.percentOff) : existing?.percentOff ?? null;
  const amount = raw.amountOff !== undefined ? Number(raw.amountOff) : existing?.amountOff ?? null;
  const percentOff = percent && Number.isFinite(percent) && percent > 0 ? Math.min(100, Math.floor(percent)) : null;
  const amountOff = !percentOff && amount && Number.isFinite(amount) && amount > 0 ? Math.min(SHOP_LIMITS.price, Math.floor(amount)) : null;
  if (!percentOff && !amountOff) throw new ShopError('invalid_discount');

  const maxUsesRaw = raw.maxUses !== undefined ? raw.maxUses : existing?.maxUses;
  const maxUses = maxUsesRaw === null || maxUsesRaw === undefined || maxUsesRaw === '' ? null : Math.max(1, Math.floor(Number(maxUsesRaw)) || 1);
  const expiresRaw = raw.expiresAt !== undefined ? raw.expiresAt : existing?.expiresAt;
  const expiresAt = expiresRaw ? new Date(expiresRaw as string) : null;
  const offerIds = Array.isArray(raw.offerIds)
    ? [...new Set(raw.offerIds.filter((v): v is string => typeof v === 'string' && /^[a-z0-9]{20,32}$/i.test(v)))].slice(0, SHOP_LIMITS.offers)
    : existing?.offerIds ?? [];

  const data = {
    code,
    percentOff,
    amountOff,
    maxUses,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    offerIds,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : existing?.enabled ?? true,
  };
  try {
    if (existing) return await prisma.shopPromoCode.update({ where: { id: existing.id }, data });
    const total = await prisma.shopPromoCode.count({ where: { guildId } });
    if (total >= SHOP_LIMITS.promoCodes) throw new ShopError('too_many_codes', 409);
    return await prisma.shopPromoCode.create({ data: { ...data, guildId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ShopError('code_taken', 409);
    throw err;
  }
}

export async function deleteShopPromoCode(guildId: string, id: string): Promise<void> {
  await prisma.shopPromoCode.deleteMany({ where: { id, guildId } });
}

// ─── Membres et éligibilité ─────────────────────────────────────────────────

async function resolveGuild(client: Client, guildId: string): Promise<Guild | null> {
  return client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
}

async function resolveMember(client: Client, guildId: string, userId: string): Promise<GuildMember | null> {
  const guild = await resolveGuild(client, guildId);
  return guild ? guild.members.fetch(userId).catch(() => null) : null;
}

async function memberLevel(guildId: string, userId: string): Promise<number> {
  const row = await prisma.memberLevel.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { xp: true } });
  if (!row) return 0;
  return getLevelFromXp(row.xp, await getGuildLevelCurve(guildId));
}

const OPEN_STATUSES = ['PENDING', 'COMPLETED'] as const;

/**
 * Ce qui empêche ce bénéficiaire d'obtenir l'offre, ou `null`. Le stock et le
 * solde sont revérifiés dans la transaction d'achat.
 */
export async function offerBlocker(offer: ShopOffer, member: GuildMember | null, options: { modules?: Record<string, boolean> } = {}): Promise<ShopErrorCode | null> {
  if (!offer.enabled) return 'offer_missing';
  if (offer.stock !== null && offer.stock <= 0) return 'out_of_stock';
  if (!member) return 'recipient_missing';
  const modules = options.modules ?? (await getModuleStates(offer.guildId));
  if (modules.economy === false) return 'economy_disabled';
  if (offer.kind === 'XP' && modules.leveling === false) return 'leveling_disabled';

  if (offer.requiredRoleIds.length > 0 && !offer.requiredRoleIds.some((id) => member.roles.cache.has(id))) return 'missing_role';
  if (offer.minLevel > 0 && (await memberLevel(offer.guildId, member.id)) < offer.minLevel) return 'level_too_low';

  if (offer.kind === 'SUBSCRIPTION') {
    const sub = await prisma.shopSubscription.findUnique({ where: { offerId_userId: { offerId: offer.id, userId: member.id } }, select: { status: true } });
    if (sub && sub.status !== 'ENDED') return 'already_subscribed';
  }
  if (offer.kind === 'ROLE' && offer.durationDays === null && offer.roleId && member.roles.cache.has(offer.roleId)) return 'already_owned';

  if (offer.perMemberLimit !== null) {
    const count = await prisma.shopOrder.count({ where: { offerId: offer.id, recipientId: member.id, status: { in: [...OPEN_STATUSES] }, source: { not: 'renewal' } } });
    if (count >= offer.perMemberLimit) return 'limit_reached';
  }
  return null;
}

async function resolvePromo(guildId: string, offer: ShopOffer, buyerId: string, rawCode: unknown): Promise<ShopPromoCode | null> {
  if (rawCode === undefined || rawCode === null || rawCode === '') return null;
  const code = normalizeShopCode(rawCode);
  if (!code) throw new ShopError('invalid_code');
  const promo = await prisma.shopPromoCode.findUnique({ where: { guildId_code: { guildId, code } } });
  if (!promo || !promo.enabled) throw new ShopError('invalid_code');
  if (promo.expiresAt && promo.expiresAt.getTime() <= Date.now()) throw new ShopError('code_expired');
  if (promo.maxUses !== null && promo.uses >= promo.maxUses) throw new ShopError('code_exhausted');
  if (promo.offerIds.length > 0 && !promo.offerIds.includes(offer.id)) throw new ShopError('code_not_applicable');
  const used = await prisma.shopOrder.count({ where: { guildId, buyerId, promoCodeId: promo.id, status: { in: [...OPEN_STATUSES] } } });
  if (used > 0) throw new ShopError('code_used');
  return promo;
}

export interface ShopPurchaseOptions {
  recipientId?: string | null;
  code?: unknown;
  note?: unknown;
  source: 'site' | 'discord';
}

export interface ShopQuote {
  price: number;
  listPrice: number;
  codeApplied: boolean;
  balance: number;
}

/** Prix à payer et solde, sans rien débiter : pour l'aperçu avant achat. */
export async function quoteShopOffer(client: Client, guildId: string, buyerId: string, offerId: string, options: Omit<ShopPurchaseOptions, 'source'>): Promise<ShopQuote> {
  const { offer, promo } = await preparePurchase(client, guildId, buyerId, offerId, options);
  const profile = await getOrCreateRpgProfile(guildId, buyerId);
  return { price: discountedShopPrice(offer.price, promo), listPrice: offer.price, codeApplied: Boolean(promo), balance: profile.balance };
}

async function preparePurchase(client: Client, guildId: string, buyerId: string, offerId: string, options: Omit<ShopPurchaseOptions, 'source'>) {
  const settings = await getShopSettings(guildId);
  if (!settings.enabled) throw new ShopError('shop_disabled', 403);
  const offer = await prisma.shopOffer.findFirst({ where: { id: offerId, guildId } });
  if (!offer) throw new ShopError('offer_missing', 404);

  const recipientId = options.recipientId && options.recipientId !== buyerId ? options.recipientId : buyerId;
  if (recipientId !== buyerId && !offer.giftable) throw new ShopError('not_giftable');
  if (!SNOWFLAKE.test(recipientId)) throw new ShopError('recipient_missing');

  const [buyer, recipient] = await Promise.all([
    resolveMember(client, guildId, buyerId),
    recipientId === buyerId ? null : resolveMember(client, guildId, recipientId),
  ]);
  if (!buyer) throw new ShopError('recipient_missing');
  const member = recipientId === buyerId ? buyer : recipient;
  const blocker = await offerBlocker(offer, member);
  if (blocker) throw new ShopError(blocker);

  if (offer.roleId) {
    const role = member!.guild.roles.cache.get(offer.roleId);
    if (!role || !role.editable) throw new ShopError('role_unmanageable');
  }
  const promo = await resolvePromo(guildId, offer, buyerId, options.code);
  return { offer, promo, settings, buyer, member: member!, recipientId };
}

/**
 * Achète une offre. Renvoie la commande, terminée ou en attente du staff.
 * Le solde est débité dans la même transaction que la commande : un double
 * clic ne paie et ne commande qu'une fois quand le solde ne couvre qu'un achat.
 */
export async function purchaseShopOffer(client: Client, guildId: string, buyerId: string, offerId: string, options: ShopPurchaseOptions): Promise<ShopOrder> {
  const { offer, promo, settings, member, recipientId } = await preparePurchase(client, guildId, buyerId, offerId, options);
  const price = discountedShopPrice(offer.price, promo);
  const note = typeof options.note === 'string' && options.note.trim() ? options.note.trim().slice(0, SHOP_LIMITS.note) : null;
  const profile = await getOrCreateRpgProfile(guildId, buyerId);

  const order = await prisma.$transaction(async (tx) => {
    // Une commande à la fois par offre et bénéficiaire : la limite par membre
    // compte les commandes déjà passées, deux achats simultanés la doubleraient.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop:${offer.id}:${recipientId}`}))`;
    if (offer.perMemberLimit !== null) {
      const count = await tx.shopOrder.count({ where: { offerId: offer.id, recipientId, status: { in: [...OPEN_STATUSES] }, source: { not: 'renewal' } } });
      if (count >= offer.perMemberLimit) throw new ShopError('limit_reached');
    }
    if (offer.stock !== null) {
      const taken = await tx.shopOffer.updateMany({ where: { id: offer.id, stock: { gt: 0 } }, data: { stock: { decrement: 1 } } });
      if (taken.count === 0) throw new ShopError('out_of_stock');
    }
    if (promo) {
      const used = await tx.shopPromoCode.updateMany({
        where: { id: promo.id, enabled: true, ...(promo.maxUses !== null ? { uses: { lt: promo.maxUses } } : {}) },
        data: { uses: { increment: 1 } },
      });
      if (used.count === 0) throw new ShopError('code_exhausted');
    }
    if (price > 0) {
      const debited = await tx.rpgProfile.updateMany({ where: { id: profile.id, balance: { gte: price } }, data: { balance: { decrement: price } } });
      if (debited.count === 0) throw new ShopError('insufficient_funds');
    }
    return tx.shopOrder.create({
      data: {
        guildId,
        offerId: offer.id,
        offerName: offer.name,
        kind: offer.kind,
        buyerId,
        recipientId,
        price,
        listPrice: offer.price,
        promoCodeId: promo?.id ?? null,
        status: offer.requiresApproval ? 'PENDING' : 'COMPLETED',
        source: options.source,
        note,
      },
    });
  });

  if (offer.requiresApproval) {
    await announcePendingOrder(client, guildId, settings.approvalChannelId, order).catch((err: unknown) => logger.warn('Shop', `Annonce de commande à valider non publiée (${guildId}) :`, err));
  } else {
    try {
      await deliverOrder(client, offer, order, member);
    } catch (err) {
      logger.warn('Shop', `Livraison impossible (${guildId}/${order.id}), remboursement :`, err);
      await refundOrder(order, 'delivery_failed', null);
      throw new ShopError('delivery_failed');
    }
    await afterCompletion(client, guildId, settings.logChannelId, order);
  }
  signalShop(guildId, buyerId, recipientId);
  return order;
}

function signalShop(guildId: string, ...userIds: string[]) {
  publishGuildSignal(guildId, 'module:shop');
  for (const userId of new Set(userIds)) publishGuildSignal(guildId, `user:${userId}`);
}

// ─── Livraison, remboursement, décision du staff ────────────────────────────

const PERIOD_MS = 86_400_000;

async function deliverOrder(client: Client, offer: ShopOffer, order: ShopOrder, member: GuildMember): Promise<void> {
  const reason = `Boutique : ${offer.name}`.slice(0, 512);
  switch (offer.kind) {
    case 'ROLE': {
      await member.roles.add(offer.roleId!, reason);
      if (offer.durationDays) await extendRoleGrant(order.guildId, member.id, offer.roleId!, offer.durationDays, order.id);
      return;
    }
    case 'SUBSCRIPTION': {
      await member.roles.add(offer.roleId!, reason);
      const period = offer.durationDays ?? 30;
      const values = {
        roleId: offer.roleId!,
        price: offer.price,
        periodDays: period,
        status: 'ACTIVE' as const,
        nextChargeAt: new Date(Date.now() + period * PERIOD_MS),
        graceUntil: null,
        cancelAtPeriodEnd: false,
        endedAt: null,
      };
      await prisma.shopSubscription.upsert({
        where: { offerId_userId: { offerId: offer.id, userId: member.id } },
        create: { ...values, guildId: order.guildId, offerId: offer.id, userId: member.id },
        update: values,
      });
      return;
    }
    case 'ITEM':
      await adminSpawnItem(order.guildId, member.id, offer.itemId!, offer.quantity);
      return;
    case 'XP':
      await addXp(order.guildId, member.id, offer.quantity, client);
      return;
    case 'CUSTOM':
      return;
  }
}

/** Rôle temporaire : prolonge la durée en cours plutôt que d'en ouvrir une seconde. */
async function extendRoleGrant(guildId: string, userId: string, roleId: string, days: number, orderId: string): Promise<void> {
  const current = await prisma.shopRoleGrant.findFirst({ where: { guildId, userId, roleId, removedAt: null }, orderBy: { expiresAt: 'desc' } });
  const from = current && current.expiresAt.getTime() > Date.now() ? current.expiresAt.getTime() : Date.now();
  const expiresAt = new Date(from + days * PERIOD_MS);
  if (current) await prisma.shopRoleGrant.update({ where: { id: current.id }, data: { expiresAt, orderId } });
  else await prisma.shopRoleGrant.create({ data: { guildId, userId, roleId, orderId, expiresAt } });
}

/** Rembourse l'acheteur, rend le stock et l'utilisation du code. */
async function refundOrder(order: ShopOrder, reason: string, decidedBy: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.shopOrder.updateMany({
      where: { id: order.id, status: { not: 'REFUSED' } },
      data: { status: 'REFUSED', refusalReason: reason.slice(0, SHOP_LIMITS.note), decidedBy, decidedAt: new Date() },
    });
    if (updated.count === 0) return;
    if (order.price > 0) {
      const profile = await tx.rpgProfile.findUnique({ where: { guildId_userId: { guildId: order.guildId, userId: order.buyerId } }, select: { id: true } });
      if (profile) await tx.rpgProfile.update({ where: { id: profile.id }, data: { balance: { increment: order.price } } });
    }
    if (order.offerId) await tx.shopOffer.updateMany({ where: { id: order.offerId, stock: { not: null } }, data: { stock: { increment: 1 } } });
    if (order.promoCodeId) await tx.shopPromoCode.updateMany({ where: { id: order.promoCodeId, uses: { gt: 0 } }, data: { uses: { decrement: 1 } } });
  });
}

/** Le staff accepte (livraison) ou refuse (remboursement) une commande en attente. */
export async function decideShopOrder(client: Client, guildId: string, orderId: string, staffId: string, approve: boolean, reason?: unknown): Promise<ShopOrder> {
  const order = await prisma.shopOrder.findFirst({ where: { id: orderId, guildId } });
  if (!order) throw new ShopError('order_missing', 404);
  if (order.status !== 'PENDING') throw new ShopError('order_decided', 409);
  const settings = await getShopSettings(guildId);
  const motive = typeof reason === 'string' && reason.trim() ? reason.trim() : '';

  if (!approve) {
    await refundOrder(order, motive || 'refused', staffId);
    await notifyOrderDecision(client, order, false, motive);
    signalShop(guildId, order.buyerId, order.recipientId);
    return { ...order, status: 'REFUSED' };
  }

  const offer = order.offerId ? await prisma.shopOffer.findUnique({ where: { id: order.offerId } }) : null;
  const member = await resolveMember(client, guildId, order.recipientId);
  if (!member || (!offer && order.kind !== 'CUSTOM')) {
    await refundOrder(order, 'delivery_failed', staffId);
    throw new ShopError('delivery_failed');
  }
  // La décision se prend une fois : deux membres du staff qui cliquent en même temps
  // ne livrent pas deux fois.
  const claimed = await prisma.shopOrder.updateMany({ where: { id: order.id, status: 'PENDING' }, data: { status: 'COMPLETED', decidedBy: staffId, decidedAt: new Date() } });
  if (claimed.count === 0) throw new ShopError('order_decided', 409);
  try {
    if (offer) await deliverOrder(client, offer, order, member);
  } catch (err) {
    logger.warn('Shop', `Livraison impossible après validation (${guildId}/${order.id}) :`, err);
    await prisma.shopOrder.update({ where: { id: order.id }, data: { status: 'PENDING', decidedBy: null, decidedAt: null } });
    await refundOrder(order, 'delivery_failed', staffId);
    throw new ShopError('delivery_failed');
  }
  const done = { ...order, status: 'COMPLETED' as const, decidedBy: staffId, decidedAt: new Date() };
  await notifyOrderDecision(client, order, true, motive);
  await afterCompletion(client, guildId, settings.logChannelId, done);
  signalShop(guildId, order.buyerId, order.recipientId);
  return done;
}

export async function listShopOrders(guildId: string, options: { status?: 'PENDING' | 'COMPLETED' | 'REFUSED'; limit?: number } = {}) {
  return prisma.shopOrder.findMany({
    where: { guildId, ...(options.status ? { status: options.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Math.max(1, options.limit ?? 50)),
  });
}

// ─── Espace membre ──────────────────────────────────────────────────────────

export async function memberShopState(guildId: string, userId: string) {
  const [orders, subscriptions, grants] = await Promise.all([
    prisma.shopOrder.findMany({
      where: { guildId, OR: [{ buyerId: userId }, { recipientId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.shopSubscription.findMany({
      where: { guildId, userId, status: { in: ['ACTIVE', 'GRACE'] } },
      include: { offer: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.shopRoleGrant.findMany({ where: { guildId, userId, removedAt: null }, orderBy: { expiresAt: 'asc' } }),
  ]);
  return { orders, subscriptions, grants };
}

/** Résiliation (fin de période) ou reprise d'un abonnement par le membre. */
export async function setShopSubscriptionCancelled(guildId: string, userId: string, subscriptionId: string, cancelled: boolean): Promise<void> {
  const updated = await prisma.shopSubscription.updateMany({
    where: { id: subscriptionId, guildId, userId, status: { in: ['ACTIVE', 'GRACE'] } },
    data: { cancelAtPeriodEnd: cancelled },
  });
  if (updated.count === 0) throw new ShopError('subscription_missing', 404);
  signalShop(guildId, userId);
}

// ─── Prélèvements et échéances ──────────────────────────────────────────────

/**
 * Passe sur les abonnements à prélever et les rôles temporaires échus. Ne
 * traite que les serveurs de ce shard : c'est lui qui peut toucher aux rôles.
 */
export async function processShopRenewals(client: Client): Promise<{ charged: number; ended: number; expired: number }> {
  const now = new Date();
  const result = { charged: 0, ended: 0, expired: 0 };

  const due = await prisma.shopSubscription.findMany({
    where: { status: { in: ['ACTIVE', 'GRACE'] }, nextChargeAt: { lte: now } },
    orderBy: { nextChargeAt: 'asc' },
    take: 200,
  });
  for (const sub of due) {
    if (!client.guilds.cache.has(sub.guildId)) continue;
    try {
      const outcome = await renewSubscription(client, sub, now);
      if (outcome === 'charged') result.charged += 1;
      if (outcome === 'ended') result.ended += 1;
    } catch (err) {
      logger.warn('Shop', `Prélèvement d'abonnement en échec (${sub.id}) :`, err);
    }
  }

  const expired = await prisma.shopRoleGrant.findMany({ where: { removedAt: null, expiresAt: { lte: now } }, take: 200 });
  for (const grant of expired) {
    if (!client.guilds.cache.has(grant.guildId)) continue;
    // Le même rôle peut aussi venir d'un abonnement en cours : on le laisse.
    const subscribed = await prisma.shopSubscription.count({ where: { guildId: grant.guildId, userId: grant.userId, roleId: grant.roleId, status: { in: ['ACTIVE', 'GRACE'] } } });
    if (!subscribed) {
      const member = await resolveMember(client, grant.guildId, grant.userId);
      await member?.roles.remove(grant.roleId, 'Boutique : durée écoulée').catch((err: unknown) => logger.warn('Shop', `Rôle temporaire non retiré (${grant.id}) :`, err));
    }
    await prisma.shopRoleGrant.update({ where: { id: grant.id }, data: { removedAt: now } });
    result.expired += 1;
    signalShop(grant.guildId, grant.userId);
    const locale = await localeOf(client, grant.guildId);
    const role = client.guilds.cache.get(grant.guildId)?.roles.cache.get(grant.roleId);
    await notifyShopMember(client, grant.guildId, grant.userId, {
      title: m.shop_notify_role_expired_title({}, { locale }),
      body: m.shop_notify_role_expired_body({ role: role?.name ?? grant.roleId }, { locale }),
    });
  }
  return result;
}

type ShopSubscriptionRow = Awaited<ReturnType<typeof prisma.shopSubscription.findMany>>[number];

async function renewSubscription(client: Client, sub: ShopSubscriptionRow, now: Date): Promise<'charged' | 'grace' | 'ended' | 'waiting'> {
  const offer = await prisma.shopOffer.findUnique({ where: { id: sub.offerId } });
  const locale = await localeOf(client, sub.guildId);
  const name = offer?.name ?? '';
  if (sub.cancelAtPeriodEnd || !offer) {
    await endSubscription(client, sub, now);
    await notifyShopMember(client, sub.guildId, sub.userId, {
      title: m.shop_notify_sub_ended_title({}, { locale }),
      body: m.shop_notify_sub_ended_body({ name }, { locale }),
      path: '/me',
    });
    return 'ended';
  }

  const profile = await getOrCreateRpgProfile(sub.guildId, sub.userId);
  const price = sub.price;
  const paid = await prisma.$transaction(async (tx) => {
    if (price > 0) {
      const debited = await tx.rpgProfile.updateMany({ where: { id: profile.id, balance: { gte: price } }, data: { balance: { decrement: price } } });
      if (debited.count === 0) return false;
    }
    const next = new Date(Math.max(now.getTime(), sub.nextChargeAt.getTime()) + sub.periodDays * PERIOD_MS);
    await tx.shopSubscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', graceUntil: null, nextChargeAt: next } });
    await tx.shopOrder.create({
      data: {
        guildId: sub.guildId,
        offerId: offer.id,
        offerName: offer.name,
        kind: 'SUBSCRIPTION',
        buyerId: sub.userId,
        recipientId: sub.userId,
        price,
        listPrice: price,
        status: 'COMPLETED',
        source: 'renewal',
      },
    });
    return true;
  });
  if (paid) {
    signalShop(sub.guildId, sub.userId);
    return 'charged';
  }

  if (sub.status === 'ACTIVE') {
    const settings = await getShopSettings(sub.guildId);
    const graceUntil = new Date(now.getTime() + settings.graceDays * PERIOD_MS);
    if (settings.graceDays <= 0) {
      await endSubscription(client, sub, now);
      await notifyShopMember(client, sub.guildId, sub.userId, { title: m.shop_notify_sub_ended_title({}, { locale }), body: m.shop_notify_sub_unpaid_body({ name }, { locale }), path: '/me' });
      return 'ended';
    }
    await prisma.shopSubscription.update({ where: { id: sub.id }, data: { status: 'GRACE', graceUntil } });
    await notifyShopMember(client, sub.guildId, sub.userId, {
      title: m.shop_notify_sub_grace_title({}, { locale }),
      body: m.shop_notify_sub_grace_body({ name, price: await formatShopPrice(sub.guildId, price), date: graceUntil.toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR') }, { locale }),
      path: '/me',
    });
    signalShop(sub.guildId, sub.userId);
    return 'grace';
  }
  if (sub.graceUntil && sub.graceUntil.getTime() <= now.getTime()) {
    await endSubscription(client, sub, now);
    await notifyShopMember(client, sub.guildId, sub.userId, { title: m.shop_notify_sub_ended_title({}, { locale }), body: m.shop_notify_sub_unpaid_body({ name }, { locale }), path: '/me' });
    return 'ended';
  }
  return 'waiting';
}

async function endSubscription(client: Client, sub: ShopSubscriptionRow, now: Date): Promise<void> {
  await prisma.shopSubscription.update({ where: { id: sub.id }, data: { status: 'ENDED', endedAt: now, graceUntil: null } });
  const otherGrant = await prisma.shopRoleGrant.count({ where: { guildId: sub.guildId, userId: sub.userId, roleId: sub.roleId, removedAt: null, expiresAt: { gt: now } } });
  if (!otherGrant) {
    const member = await resolveMember(client, sub.guildId, sub.userId);
    await member?.roles.remove(sub.roleId, 'Boutique : abonnement terminé').catch((err: unknown) => logger.warn('Shop', `Rôle d'abonnement non retiré (${sub.id}) :`, err));
  }
  signalShop(sub.guildId, sub.userId);
}

// ─── Messages ───────────────────────────────────────────────────────────────

/** Montant suivi du nom de la monnaie du serveur. */
export async function formatShopPrice(guildId: string, amount: number): Promise<string> {
  const config = await prisma.economyConfig.findUnique({ where: { guildId }, select: { currencyName: true, currencyEmoji: true } });
  return [amount.toLocaleString('fr-FR'), config?.currencyEmoji, config?.currencyName ?? 'KotboCoins'].filter(Boolean).join(' ');
}

async function localeOf(client: Client, guildId: string): Promise<'fr' | 'en'> {
  const guild = client.guilds.cache.get(guildId);
  return (await resolveGuildLocale(guildId, guild?.preferredLocale)) === 'en' ? 'en' : 'fr';
}

/**
 * MP au membre. Passe par le site quand il est en ligne (bouton vers la page,
 * préférences du membre) ; sinon, simple message.
 */
async function notifyShopMember(client: Client, guildId: string, userId: string, notification: { title: string; body: string; path?: string }): Promise<void> {
  const viaSite = await notifySiteMember(client, guildId, userId, 'shop', notification).catch(() => false);
  if (viaSite) return;
  const site = await prisma.communitySite.findUnique({ where: { guildId }, select: { published: true } });
  if (site?.published) return; // Le membre a coupé ces MP depuis son espace.
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [new EmbedBuilder().setTitle(notification.title.slice(0, 256)).setDescription(notification.body.slice(0, 2000))] });
  } catch {
    // MP fermés : rien à faire.
  }
}

async function notifyOrderDecision(client: Client, order: ShopOrder, approved: boolean, reason: string): Promise<void> {
  const locale = await localeOf(client, order.guildId);
  await notifyShopMember(client, order.guildId, order.buyerId, approved
    ? { title: m.shop_notify_approved_title({}, { locale }), body: m.shop_notify_approved_body({ name: order.offerName }, { locale }), path: '/me' }
    : {
        title: m.shop_notify_refused_title({}, { locale }),
        body: `${m.shop_notify_refused_body({ name: order.offerName, price: await formatShopPrice(order.guildId, order.price) }, { locale })}${reason ? `\n> ${reason.slice(0, 300)}` : ''}`,
        path: '/me',
      });
}

async function afterCompletion(client: Client, guildId: string, logChannelId: string | null, order: ShopOrder): Promise<void> {
  const locale = await localeOf(client, guildId);
  if (order.recipientId !== order.buyerId) {
    await notifyShopMember(client, guildId, order.recipientId, {
      title: m.shop_notify_gift_title({}, { locale }),
      body: m.shop_notify_gift_body({ name: order.offerName, buyer: `<@${order.buyerId}>` }, { locale }),
      path: '/me',
    });
  }
  if (!logChannelId) return;
  const channel = client.channels.cache.get(logChannelId);
  if (!channel?.isSendable()) return;
  const gift = order.recipientId !== order.buyerId ? m.shop_log_gift({ recipient: `<@${order.recipientId}>` }, { locale }) : '';
  await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setTitle(m.shop_log_title({}, { locale }))
          .setDescription(`${m.shop_log_body({ buyer: `<@${order.buyerId}>`, name: order.offerName, price: await formatShopPrice(guildId, order.price) }, { locale })}${gift ? `\n${gift}` : ''}`)
          .setTimestamp(order.createdAt),
      ],
      allowedMentions: { parse: [] },
    })
    .catch((err: unknown) => logger.debug('Shop', `Journal de vente non publié (${guildId}) :`, err));
}

async function announcePendingOrder(client: Client, guildId: string, channelId: string | null, order: ShopOrder): Promise<void> {
  if (!channelId) return;
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isSendable()) return;
  const locale = await localeOf(client, guildId);
  const { getDashboardUrl } = await import('../../api/shared.js');
  const url = `${getDashboardUrl().replace(/\/$/, '')}/site/boutique`;
  const lines = [
    m.shop_pending_body({ buyer: `<@${order.buyerId}>`, name: order.offerName, price: await formatShopPrice(guildId, order.price) }, { locale }),
    order.recipientId !== order.buyerId ? m.shop_log_gift({ recipient: `<@${order.recipientId}>` }, { locale }) : '',
    order.note ? `> ${order.note.slice(0, 500).split('\n').join('\n> ')}` : '',
    m.shop_pending_link({ url }, { locale }),
  ].filter(Boolean);
  await channel.send({ embeds: [new EmbedBuilder().setTitle(m.shop_pending_title({}, { locale })).setDescription(lines.join('\n'))], allowedMentions: { parse: [] } });
}

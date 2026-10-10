/**
 * Blocs de la boutique : le catalogue (avec le formulaire d'achat, de cadeau
 * et de code promo) et, dans l'espace membre, les achats, abonnements et rôles
 * temporaires du visiteur.
 */

import type { Client } from 'discord.js';
import type { ShopOffer } from '@prisma/client';
import { siteIconSvg } from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import * as m from '../../../lib/paraglide/messages.js';
import { attrs, cls, esc } from '../siteHtml.js';
import { getShopSettings, listShopOffers, memberShopState, type ShopErrorCode } from '../../shop/shopService.js';
import { emptyState, formatNumber, timeTag, type BlockContext, type BlockRegistry } from './blockContext.js';
import { viewerGate } from './memberBlocks.js';

interface Currency {
  name: string;
  emoji: string;
}

async function currencyOf(guildId: string): Promise<Currency> {
  const config = await prisma.economyConfig.findUnique({ where: { guildId }, select: { currencyName: true, currencyEmoji: true } });
  return { name: config?.currencyName ?? 'KotboCoins', emoji: config?.currencyEmoji ?? '' };
}

function price(amount: number, currency: Currency, ctx: BlockContext): string {
  return `${formatNumber(amount, ctx.locale)}${currency.emoji ? ` ${esc(currency.emoji)}` : ''} <span class="shop-currency">${esc(currency.name)}</span>`;
}

function roleName(ctx: BlockContext, roleId: string | null): string {
  if (!roleId) return '';
  return ctx.guild?.roles.cache.get(roleId)?.name ?? roleId;
}

/** Ce que l'offre donne, en une ligne. */
function offerSummary(ctx: BlockContext, offer: ShopOffer, items: Map<string, { name: string; emoji: string }>): string {
  const o = { locale: ctx.locale };
  switch (offer.kind) {
    case 'ROLE':
      return offer.durationDays
        ? m.site_shop_kind_role_timed({ role: roleName(ctx, offer.roleId), days: offer.durationDays }, o)
        : m.site_shop_kind_role({ role: roleName(ctx, offer.roleId) }, o);
    case 'SUBSCRIPTION':
      return m.site_shop_kind_subscription({ role: roleName(ctx, offer.roleId), days: offer.durationDays ?? 30 }, o);
    case 'ITEM': {
      const item = offer.itemId ? items.get(offer.itemId) : null;
      return m.site_shop_kind_item({ item: item ? `${item.emoji} ${item.name}`.trim() : '?', count: offer.quantity }, o);
    }
    case 'XP':
      return m.site_shop_kind_xp({ count: formatNumber(offer.quantity, ctx.locale) }, o);
    default:
      return m.site_shop_kind_custom({}, o);
  }
}

function offerRules(ctx: BlockContext, offer: ShopOffer): string[] {
  const o = { locale: ctx.locale };
  const rules: string[] = [];
  if (offer.stock !== null) rules.push(offer.stock > 0 ? m.site_shop_rule_stock({ count: offer.stock }, o) : m.site_shop_rule_sold_out({}, o));
  if (offer.perMemberLimit !== null) rules.push(m.site_shop_rule_limit({ count: offer.perMemberLimit }, o));
  if (offer.requiredRoleIds.length > 0) rules.push(m.site_shop_rule_roles({ roles: offer.requiredRoleIds.map((id) => roleName(ctx, id)).join(', ') }, o));
  if (offer.minLevel > 0) rules.push(m.site_shop_rule_level({ level: offer.minLevel }, o));
  if (offer.requiresApproval) rules.push(m.site_shop_rule_approval({}, o));
  return rules;
}

function buyForm(ctx: BlockContext, offer: ShopOffer, currency: Currency): string {
  const o = { locale: ctx.locale };
  const id = `shop-${offer.id}`;
  const gift = offer.giftable
    ? `<div class="field"><label for="${id}-to">${esc(m.site_shop_gift_label({}, o))}</label><p class="field-help">${esc(m.site_shop_gift_help({}, o))}</p><input${attrs({ id: `${id}-to`, name: 'recipient', maxlength: 40, autocomplete: 'off' })}></div>`
    : '';
  const note =
    offer.kind === 'CUSTOM'
      ? `<div class="field"><label for="${id}-note">${esc(m.site_shop_note_label({}, o))}</label><textarea${attrs({ id: `${id}-note`, name: 'note', rows: 3, maxlength: 500, required: true })}></textarea></div>`
      : '';
  return `<details class="shop-buy">
  <summary class="btn btn-primary btn-sm">${esc(m.site_shop_buy({}, o))}</summary>
  <form class="shop-form"${attrs({ 'data-shop-buy': offer.id, 'data-requires-login': '1' })}>
    ${gift}
    <div class="field"><label for="${id}-code">${esc(m.site_shop_code_label({}, o))}</label><div class="shop-code"><input${attrs({ id: `${id}-code`, name: 'code', maxlength: 32, autocomplete: 'off' })}><button type="button" class="btn btn-secondary btn-sm" data-shop-quote>${esc(m.site_shop_code_apply({}, o))}</button></div></div>
    ${note}
    <p class="shop-total">${esc(m.site_shop_total({}, o))} <strong data-shop-total>${price(offer.price, currency, ctx)}</strong></p>
    <p class="form-status" role="status" aria-live="polite"></p>
    <div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">${esc(m.site_shop_pay({}, o))}</button></div>
  </form>
</details>`;
}

async function renderShop(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const o = { locale: ctx.locale };
  const guildId = ctx.site.guildId;
  const settings = await getShopSettings(guildId);
  if (!settings.enabled) return emptyState(m.site_shop_closed({}, o));
  const category = typeof config.category === 'string' ? config.category.trim().toLowerCase() : '';
  const offers = (await listShopOffers(guildId)).filter((offer) => !category || (offer.category ?? '').toLowerCase() === category);
  if (offers.length === 0) return emptyState(m.site_shop_empty({}, o));

  const itemIds = offers.map((offer) => offer.itemId).filter((id): id is string => Boolean(id));
  const [currency, items, profile] = await Promise.all([
    currencyOf(guildId),
    itemIds.length ? prisma.rpgItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, emoji: true } }) : Promise.resolve([]),
    ctx.viewer ? prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId: ctx.viewer.userId } }, select: { balance: true } }) : Promise.resolve(null),
  ]);
  const itemMap = new Map(items.map((item) => [item.id, item]));

  // Rangées par catégorie, dans l'ordre de la boutique.
  const groups = new Map<string, ShopOffer[]>();
  for (const offer of offers) {
    const key = offer.category ?? '';
    groups.set(key, [...(groups.get(key) ?? []), offer]);
  }

  const card = (offer: ShopOffer) => {
    const rules = offerRules(ctx, offer);
    const soldOut = offer.stock !== null && offer.stock <= 0;
    const missingRole = ctx.viewer && offer.requiredRoleIds.length > 0 && !offer.requiredRoleIds.some((id) => ctx.viewer!.roleIds.includes(id));
    const image = offer.imageUrl ? `<img class="shop-image"${attrs({ src: offer.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })}>` : '';
    const action = soldOut
      ? `<p class="card-meta">${esc(m.site_shop_rule_sold_out({}, o))}</p>`
      : missingRole
        ? `<p class="card-meta">${siteIconSvg('lock', 16)} ${esc(m.site_shop_locked({}, o))}</p>`
        : buyForm(ctx, offer, currency);
    return `<article class="${cls('shop-card', soldOut && 'is-sold-out')}">
  ${image}
  <div class="card-body">
    <h3 class="card-title">${esc(offer.name)}</h3>
    <p class="card-meta">${esc(offerSummary(ctx, offer, itemMap))}</p>
    ${offer.description ? `<p class="shop-desc">${esc(offer.description)}</p>` : ''}
    <p class="shop-price">${price(offer.price, currency, ctx)}${offer.kind === 'SUBSCRIPTION' ? ` <span class="shop-period">${esc(m.site_shop_per_period({ days: offer.durationDays ?? 30 }, o))}</span>` : ''}</p>
    ${rules.length ? `<ul class="shop-rules">${rules.map((rule) => `<li>${esc(rule)}</li>`).join('')}</ul>` : ''}
    <div class="card-actions">${action}</div>
  </div>
</article>`;
  };

  const sections = [...groups.entries()]
    .map(([name, list]) => `${name ? `<h3 class="shop-category">${esc(name)}</h3>` : ''}<div class="card-grid">${list.map(card).join('')}</div>`)
    .join('');
  const balance = ctx.viewer
    ? `<p class="mod-meta">${esc(m.site_shop_balance({}, o))} <strong>${price(profile?.balance ?? 0, currency, ctx)}</strong></p>`
    : `<p class="mod-meta">${esc(m.site_shop_login_hint({}, o))} <a href="#" data-login>${esc(m.site_login({}, o))}</a></p>`;
  return `<div class="shop" data-member-block><p class="mod-title">${esc(m.site_shop_title({}, o))}</p>${balance}${sections}</div>`;
}

async function renderMemberPurchases(ctx: BlockContext): Promise<string> {
  const gate = viewerGate(ctx);
  if (gate !== null) return gate;
  const o = { locale: ctx.locale };
  const viewer = ctx.viewer!;
  const guildId = ctx.site.guildId;
  const [state, currency] = await Promise.all([memberShopState(guildId, viewer.userId), currencyOf(guildId)]);

  const subscriptions = state.subscriptions
    .map((sub) => {
      const status = sub.status === 'GRACE'
        ? m.site_shop_sub_grace({ date: timeTag(sub.graceUntil, ctx.locale, 'medium') }, o)
        : sub.cancelAtPeriodEnd
          ? m.site_shop_sub_ends({ date: timeTag(sub.nextChargeAt, ctx.locale, 'medium') }, o)
          : m.site_shop_sub_next({ date: timeTag(sub.nextChargeAt, ctx.locale, 'medium') }, o);
      const button = sub.cancelAtPeriodEnd
        ? `<button type="button" class="btn btn-secondary btn-sm"${attrs({ 'data-action': 'shop-sub-resume', 'data-id': sub.id })}>${esc(m.site_shop_sub_resume({}, o))}</button>`
        : `<button type="button" class="btn btn-secondary btn-sm"${attrs({ 'data-action': 'shop-sub-cancel', 'data-id': sub.id })}>${esc(m.site_shop_sub_cancel({}, o))}</button>`;
      return `<li class="${cls('shop-line', sub.status === 'GRACE' && 'is-warning')}"><span class="shop-line-main"><strong>${esc(sub.offer.name)}</strong> · ${price(sub.price, currency, ctx)}<br><span class="card-meta">${status}</span></span>${button}</li>`;
    })
    .join('');

  const grants = state.grants
    .map((grant) => `<li class="shop-line"><span class="shop-line-main"><strong>${esc(roleName(ctx, grant.roleId))}</strong><br><span class="card-meta">${m.site_shop_role_until({ date: timeTag(grant.expiresAt, ctx.locale, 'medium') }, o)}</span></span></li>`)
    .join('');

  const STATUS: Record<string, () => string> = {
    PENDING: () => m.site_shop_status_pending({}, o),
    COMPLETED: () => m.site_shop_status_completed({}, o),
    REFUSED: () => m.site_shop_status_refused({}, o),
  };
  const orders = state.orders
    .map((order) => {
      const gift =
        order.recipientId !== order.buyerId
          ? order.buyerId === viewer.userId
            ? ` · ${esc(m.site_shop_gift_to({}, o))}`
            : ` · ${esc(m.site_shop_gift_from({}, o))}`
          : '';
      const renewal = order.source === 'renewal' ? ` · ${esc(m.site_shop_renewal({}, o))}` : '';
      return `<li class="shop-line"><span class="shop-line-main"><strong>${esc(order.offerName)}</strong>${gift}${renewal}<br><span class="card-meta">${timeTag(order.createdAt, ctx.locale, 'medium')} · ${price(order.price, currency, ctx)}${order.refusalReason && order.status === 'REFUSED' && order.refusalReason !== 'refused' && order.refusalReason !== 'delivery_failed' ? ` · ${esc(order.refusalReason)}` : ''}</span></span><span class="${cls('tag', `shop-status-${order.status.toLowerCase()}`)}">${esc(STATUS[order.status]())}</span></li>`;
    })
    .join('');

  if (!subscriptions && !grants && !orders) return `<p class="mod-title">${esc(m.site_shop_mine_title({}, o))}</p>${emptyState(m.site_shop_mine_empty({}, o))}`;
  return `<p class="mod-title">${esc(m.site_shop_mine_title({}, o))}</p>
${subscriptions ? `<h3 class="shop-category">${esc(m.site_shop_mine_subscriptions({}, o))}</h3><ul class="shop-lines">${subscriptions}</ul>` : ''}
${grants ? `<h3 class="shop-category">${esc(m.site_shop_mine_roles({}, o))}</h3><ul class="shop-lines">${grants}</ul>` : ''}
${orders ? `<h3 class="shop-category">${esc(m.site_shop_mine_orders({}, o))}</h3><ul class="shop-lines">${orders}</ul>` : ''}`;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * Bénéficiaire d'un cadeau : identifiant Discord, ou pseudo cherché parmi les
 * membres (correspondance exacte d'abord, sinon un seul résultat).
 */
export async function resolveShopRecipient(client: Client, guildId: string, input: string): Promise<string | null> {
  const query = input.trim().replace(/^@/, '');
  if (/^\d{17,20}$/.test(query)) return query;
  if (query.length < 2) return null;
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  const found = guild ? await guild.members.search({ query, limit: 5 }).catch(() => null) : null;
  if (!found || found.size === 0) return null;
  const lower = query.toLowerCase();
  const exact = found.find((member) => member.user.username.toLowerCase() === lower || member.displayName.toLowerCase() === lower);
  if (exact) return exact.id;
  return found.size === 1 ? found.first()!.id : null;
}

export function shopErrorMessage(code: ShopErrorCode, o: { locale: 'fr' | 'en' }): string {
  const messages: Partial<Record<ShopErrorCode, () => string>> = {
    shop_disabled: () => m.site_shop_closed({}, o),
    economy_disabled: () => m.site_shop_closed({}, o),
    leveling_disabled: () => m.site_shop_err_unavailable({}, o),
    offer_missing: () => m.site_shop_err_unavailable({}, o),
    item_missing: () => m.site_shop_err_unavailable({}, o),
    role_unmanageable: () => m.site_shop_err_unavailable({}, o),
    out_of_stock: () => m.site_shop_rule_sold_out({}, o),
    limit_reached: () => m.site_shop_err_limit({}, o),
    missing_role: () => m.site_shop_locked({}, o),
    level_too_low: () => m.site_shop_err_level({}, o),
    already_owned: () => m.site_shop_err_owned({}, o),
    already_subscribed: () => m.site_shop_err_subscribed({}, o),
    not_giftable: () => m.site_shop_err_not_giftable({}, o),
    recipient_missing: () => m.site_shop_err_recipient({}, o),
    insufficient_funds: () => m.site_shop_err_funds({}, o),
    invalid_code: () => m.site_shop_err_code({}, o),
    code_expired: () => m.site_shop_err_code_expired({}, o),
    code_exhausted: () => m.site_shop_err_code_expired({}, o),
    code_used: () => m.site_shop_err_code_used({}, o),
    code_not_applicable: () => m.site_shop_err_code_offer({}, o),
    delivery_failed: () => m.site_shop_err_delivery({}, o),
    subscription_missing: () => m.site_shop_err_unavailable({}, o),
  };
  return (messages[code] ?? (() => m.site_error_generic({}, o)))();
}

export const shopBlocks: BlockRegistry = {
  shop: renderShop,
  memberPurchases: renderMemberPurchases,
};

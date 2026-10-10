/**
 * Messages d'erreur de la boutique, communs au site et à Discord.
 */

import * as m from '../../lib/paraglide/messages.js';
import type { ShopErrorCode } from './shopService.js';

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

/** Messages lisibles pour les codes d'erreur de l'API des sites. */
import { isDashboardApiError } from '../../api/errors';
import { m } from '../../i18n';

const MESSAGES: Record<string, () => string> = {
  slug_too_short: () => m.ste_err_slug_short(),
  slug_too_long: () => m.ste_err_slug_long(),
  slug_invalid: () => m.ste_err_slug_invalid(),
  slug_reserved: () => m.ste_err_slug_reserved(),
  slug_taken: () => m.ste_err_slug_taken(),
  site_exists: () => m.ste_err_site_exists(),
  site_missing: () => m.ste_err_site_missing(),
  site_suspended: () => m.ste_err_site_suspended(),
  title_required: () => m.ste_err_title_required(),
  invalid_image: () => m.ste_err_invalid_image(),
  invalid_theme: () => m.ste_err_invalid(),
  invalid_field: () => m.ste_err_invalid(),
  invalid_navigation: () => m.ste_err_invalid_navigation(),
  invalid_home: () => m.ste_err_invalid(),
  invalid_parent: () => m.ste_err_invalid_parent(),
  parent_cycle: () => m.ste_err_parent_cycle(),
  invalid_date: () => m.ste_err_invalid_date(),
  css_too_long: () => m.ste_err_css_too_long(),
  too_many_pages: () => m.ste_err_too_many_pages(),
  page_missing: () => m.ste_err_page_missing(),
  revision_missing: () => m.ste_err_page_missing(),
  too_large: () => m.ste_err_too_large(),
  unsupported: () => m.ste_err_unsupported(),
  unreadable: () => m.ste_err_unreadable(),
  quota: () => m.ste_err_quota(),
  forbidden: () => m.ste_err_forbidden(),
  not_staff: () => m.ste_err_not_staff(),
  agent_locked: () => m.ste_err_agent_locked(),
  invalid_vote_url: () => m.ste_err_invalid_vote_url(),
  vote_key_required: () => m.ste_err_vote_key_required(),
  invalid_provider: () => m.ste_err_invalid_provider(),
  too_many_vote_sites: () => m.ste_err_too_many_vote_sites(),
  vote_site_missing: () => m.ste_err_vote_site_missing(),
  offer_missing: () => m.ste_err_offer_missing(),
  order_missing: () => m.ste_err_order_decided(),
  order_decided: () => m.ste_err_order_decided(),
  role_unmanageable: () => m.ste_err_role_unmanageable(),
  item_missing: () => m.ste_err_item_missing(),
  code_taken: () => m.ste_err_code_taken(),
  invalid_code: () => m.ste_err_invalid_code(),
  invalid_discount: () => m.ste_err_invalid_discount(),
  delivery_failed: () => m.ste_err_delivery_failed(),
  too_many_offers: () => m.ste_err_too_many_offers(),
  too_many_codes: () => m.ste_err_too_many_codes(),
  name_required: () => m.ste_err_name_required(),
  invalid_price: () => m.ste_shop_err_price(),
  role_required: () => m.ste_shop_err_role(),
  item_required: () => m.ste_shop_err_item(),
  invalid_duration: () => m.ste_shop_err_duration(),
  invalid_quantity: () => m.ste_shop_err_quantity(),
  category_missing: () => m.ste_err_category_missing(),
  channel_invalid: () => m.ste_err_forum_channel(),
  webhook_failed: () => m.ste_err_forum_webhook(),
  too_many_categories: () => m.ste_err_too_many_categories(),
};

export function siteErrorMessage(err: unknown): string {
  if (isDashboardApiError(err)) {
    const data = (err.data ?? {}) as { error?: string; detail?: string | null };
    const code = data.error ?? err.code ?? '';
    if (code === 'scam_link') return m.ste_err_scam_link({ domain: data.detail ?? '?' });
    const message = MESSAGES[code];
    if (message) return message();
    return err.userMessage;
  }
  return m.ste_err_generic();
}

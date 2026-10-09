/**
 * Blocs de l'espace membre : réglages (profil public, messages privés),
 * récompenses récentes et série, inventaire. Rendus pour le visiteur connecté
 * (le rendu serveur, anonyme, affiche un état d'attente que le script remplace).
 */

import { normalizeSiteRewards, SITE_NOTIFICATION_KINDS, type SiteNotificationKind } from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import * as m from '../../../lib/paraglide/messages.js';
import { attrs, esc } from '../siteHtml.js';
import { getSiteMemberSettings } from '../siteMemberService.js';
import { listSiteRewards } from '../siteRewardService.js';
import { emptyState, formatNumber, timeTag, type BlockContext, type BlockRegistry } from './blockContext.js';

/** Attente du visiteur, ou invitation à se connecter. `null` = visiteur connu. */
function viewerGate(ctx: BlockContext): string | null {
  const o = { locale: ctx.locale };
  // `data-member-block` : le script recharge le bloc même pour un anonyme, qui doit voir l'invitation à se connecter.
  if (!ctx.viewerKnown) return `<div data-member-block>${emptyState(m.site_loading({}, o))}</div>`;
  if (!ctx.viewer) {
    return `<div data-member-block>${emptyState(m.site_profile_login({}, o))}<p class="btn-row"><a class="btn btn-primary btn-discord" data-login href="#">${esc(m.site_login({}, o))}</a></p></div>`;
  }
  return null;
}

async function renderMemberSettings(ctx: BlockContext): Promise<string> {
  const gate = viewerGate(ctx);
  if (gate !== null) return gate;
  const viewer = ctx.viewer!;
  const o = { locale: ctx.locale };
  const settings = await getSiteMemberSettings(ctx.site.guildId, viewer.userId);
  const labels: Record<SiteNotificationKind, string> = {
    comments: m.site_notify_pref_comments({}, o),
    tickets: m.site_notify_pref_tickets({}, o),
    shop: m.site_notify_pref_shop({}, o),
    voteReminder: m.site_notify_pref_vote_reminder({}, o),
  };
  const checkbox = (name: string, checked: boolean, label: string) =>
    `<label class="choice"><input type="checkbox"${attrs({ name, checked })}> ${esc(label)}</label>`;
  return `<p class="mod-title">${esc(m.site_member_settings_title({}, o))}</p>
<form class="site-form" data-member-settings>
  <fieldset class="field">
    <legend>${esc(m.site_member_profile_legend({}, o))}</legend>
    ${checkbox('profileVisible', !settings.profileHidden, m.site_member_profile_visible({}, o))}
    <p class="field-help"><a${attrs({ href: `${ctx.basePath}/u/${viewer.userId}` })}>${esc(m.site_member_profile_see({}, o))}</a></p>
  </fieldset>
  <fieldset class="field">
    <legend>${esc(m.site_member_dm_legend({}, o))}</legend>
    <div class="choices">${SITE_NOTIFICATION_KINDS.map((kind) => checkbox(`notify_${kind}`, settings.notifications[kind], labels[kind])).join('')}</div>
  </fieldset>
  <p class="form-status" role="status" aria-live="polite"></p>
  <div class="form-actions"><button type="submit" class="btn btn-primary">${esc(m.site_save({}, o))}</button></div>
</form>`;
}

async function renderMemberRewards(ctx: BlockContext): Promise<string> {
  const settings = normalizeSiteRewards(ctx.site.rewards);
  if (!settings.enabled) return '';
  const gate = viewerGate(ctx);
  if (gate !== null) return gate;
  const viewer = ctx.viewer!;
  const o = { locale: ctx.locale };
  const [member, rewards] = await Promise.all([getSiteMemberSettings(ctx.site.guildId, viewer.userId), listSiteRewards(ctx.site.guildId, viewer.userId, 12)]);
  const kindLabel = (kind: string) =>
    ({ DAILY: m.site_reward_daily({}, o), PARTICIPATION: m.site_reward_participation({}, o), READ: m.site_reward_read({}, o), VOTE: m.site_reward_vote({}, o) })[kind] ?? kind;
  const gains = (coins: number, xp: number) =>
    [coins ? m.site_reward_coins({ count: formatNumber(coins, ctx.locale) }, o) : '', xp ? m.site_reward_xp({ count: formatNumber(xp, ctx.locale) }, o) : ''].filter(Boolean).join(' · ');
  const rows = rewards
    .map((r) => `<li class="reward-row"><span>${esc(kindLabel(r.kind))}</span><span class="reward-gain">${esc(gains(r.coins, r.xp))}</span>${timeTag(r.createdAt, ctx.locale, 'medium')}</li>`)
    .join('');
  return `<p class="mod-title">${esc(m.site_member_rewards_title({}, o))}</p>
<p class="mod-meta">${esc(m.site_member_streak({ count: member.dailyStreak }, o))}</p>
${rows ? `<ul class="reward-list">${rows}</ul>` : emptyState(m.site_member_rewards_empty({}, o))}`;
}

async function renderMemberInventory(ctx: BlockContext): Promise<string> {
  const gate = viewerGate(ctx);
  if (gate !== null) return gate;
  const viewer = ctx.viewer!;
  const o = { locale: ctx.locale };
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId: ctx.site.guildId, userId: viewer.userId } },
    select: { balance: true, inventory: { select: { quantity: true, item: { select: { name: true, emoji: true, rarity: true } } }, orderBy: { item: { name: 'asc' } }, take: 120 } },
  });
  const items = (profile?.inventory ?? []).filter((entry) => entry.quantity > 0);
  const cards = items
    .map((entry) => `<li class="inventory-item"><span class="market-emoji" aria-hidden="true">${esc(entry.item.emoji)}</span><span class="inventory-name">${esc(entry.item.name)}</span><span class="market-qty">×${formatNumber(entry.quantity, ctx.locale)}</span></li>`)
    .join('');
  return `<p class="mod-title">${esc(m.site_member_inventory_title({}, o))}</p>
<p class="mod-meta">${esc(m.site_coins({ value: formatNumber(profile?.balance ?? 0, ctx.locale) }, o))}</p>
${cards ? `<ul class="inventory">${cards}</ul>` : emptyState(m.site_member_inventory_empty({}, o))}`;
}

export const memberBlocks: BlockRegistry = {
  memberSettings: renderMemberSettings,
  memberRewards: renderMemberRewards,
  memberInventory: renderMemberInventory,
};

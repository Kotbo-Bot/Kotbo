import * as m from '../../lib/paraglide/messages.js';
import type { BotLocale } from '../../utils/i18n.js';
import type { ConditionFailure, GiveawayCondition } from './giveawayConditions.js';

const roles = (ids: string[]) => ids.map((id) => `<@&${id}>`).join(' ');

const periodLabel = (period: 'total' | '7d' | '30d' | 'since_start', locale: BotLocale) => {
  const o = { locale };
  switch (period) {
    case 'total': return m.gvw_period_total({}, o);
    case '7d': return m.gvw_period_7d({}, o);
    case '30d': return m.gvw_period_30d({}, o);
    case 'since_start': return m.gvw_period_since_start({}, o);
  }
};

/** Phrase lisible d'une condition, dans la langue du serveur. */
export function describeCondition(c: GiveawayCondition, locale: BotLocale): string {
  const o = { locale };
  switch (c.type) {
    case 'roles_all': return m.gvw_cond_roles_all({ roles: roles(c.roleIds) }, o);
    case 'roles_any': return m.gvw_cond_roles_any({ roles: roles(c.roleIds) }, o);
    case 'roles_none': return m.gvw_cond_roles_none({ roles: roles(c.roleIds) }, o);
    case 'account_age': return m.gvw_cond_account_age({ days: c.days }, o);
    case 'member_age': return m.gvw_cond_member_age({ days: c.days }, o);
    case 'booster': return c.mode === 'required' ? m.gvw_cond_booster_required({}, o) : m.gvw_cond_booster_excluded({}, o);
    case 'avatar': return m.gvw_cond_avatar({}, o);
    case 'banner': return m.gvw_cond_banner({}, o);
    case 'server_tag': return m.gvw_cond_server_tag({}, o);
    case 'topgg_vote': return m.gvw_cond_topgg_vote({}, o);
    case 'nickname_contains': return m.gvw_cond_nickname_contains({ text: c.text }, o);
    case 'status_contains': return m.gvw_cond_status_contains({ text: c.text }, o);
    case 'messages': return m.gvw_cond_messages({ min: c.min, period: periodLabel(c.period, locale) }, o);
    case 'voice_minutes': return m.gvw_cond_voice_minutes({ min: c.min, period: periodLabel(c.period, locale) }, o);
    case 'invites': return m.gvw_cond_invites({ min: c.min }, o);
    case 'level': return m.gvw_cond_level({ min: c.min }, o);
    case 'xp': return m.gvw_cond_xp({ min: c.min }, o);
    case 'coins': return m.gvw_cond_coins({ min: c.min }, o);
    case 'reputation': return m.gvw_cond_reputation({ min: c.min }, o);
    case 'in_guild': return m.gvw_cond_in_guild({ guild: c.guildName ?? c.guildId }, o);
  }
}

/** Liste à puces : les conditions d'un groupe sont réunies sous « au moins une ». */
function renderList(conditions: GiveawayCondition[], locale: BotLocale): string[] {
  const lines: string[] = [];
  const groups = new Map<string, GiveawayCondition[]>();
  for (const c of conditions) {
    if (!c.group) lines.push(`• ${describeCondition(c, locale)}`);
    else groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  }
  for (const members of groups.values()) {
    lines.push(`• ${m.gvw_cond_group({}, { locale })}`);
    for (const c of members) lines.push(`  ◦ ${describeCondition(c, locale)}`);
  }
  return lines;
}

/** Bloc de l'embed du concours. Vide sans condition. */
export function conditionsBlock(conditions: GiveawayCondition[], locale: BotLocale): string {
  if (conditions.length === 0) return '';
  return `**${m.gvw_cond_title({}, { locale })}**\n${renderList(conditions, locale).join('\n')}`;
}

/** Refus au clic : tous les manquements, pas seulement le premier. */
export function failuresMessage(failures: ConditionFailure[], locale: BotLocale): string {
  const lines = renderList(failures.map((f) => f.condition), locale);
  return `${m.gvw_cond_header({}, { locale })}\n${lines.join('\n')}`;
}

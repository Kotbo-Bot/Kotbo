import * as m from '../../lib/paraglide/messages.js';
import type { BotLocale } from '../../utils/i18n.js';
import type { ReputationSettings, RepRefusalCode } from './reputationService.js';

/** Seuils du serveur cités par les refus. */
export type RepRefusalLimits = Pick<ReputationSettings, 'dailyLimit' | 'sameMemberCooldownDays' | 'minAccountAgeDays' | 'minMemberDays'>;

/** Texte d'un refus de vote, dans la langue du serveur. */
export function repRefusalMessage(code: RepRefusalCode, locale: BotLocale, limits: RepRefusalLimits): string {
  switch (code) {
    case 'SELF':
      return m.b2_rep_err_self({}, { locale });
    case 'BOT':
      return m.b2_rep_err_bot({}, { locale });
    case 'DAILY_LIMIT':
      return m.b2_rep_err_daily_limit({ limit: limits.dailyLimit }, { locale });
    case 'ALREADY_TODAY':
      return m.b2_rep_err_already_today({}, { locale });
    case 'COOLDOWN':
      return m.b2_rep_err_cooldown({ days: limits.sameMemberCooldownDays }, { locale });
    case 'CHANNEL_EXCLUDED':
      return m.b2_rep_err_channel_excluded({}, { locale });
    case 'GIVER_EXCLUDED':
      return m.b2_rep_err_giver_excluded({}, { locale });
    case 'RECEIVER_EXCLUDED':
      return m.b2_rep_err_receiver_excluded({}, { locale });
    case 'ACCOUNT_TOO_NEW':
      return m.b2_rep_err_account_too_new({ days: limits.minAccountAgeDays }, { locale });
    case 'MEMBER_TOO_NEW':
      return m.b2_rep_err_member_too_new({ days: limits.minMemberDays }, { locale });
  }
}

/** Même texte, avec les seuils lus dans les réglages du serveur. */
export async function repRefusalText(guildId: string, code: RepRefusalCode, locale: BotLocale): Promise<string> {
  // Import différé : ce fichier reste chargeable sans base de données.
  const { getReputationConfig } = await import('./reputationService.js');
  return repRefusalMessage(code, locale, await getReputationConfig(guildId));
}

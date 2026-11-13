import * as m from '../../lib/paraglide/messages.js';
import type { BotLocale } from '../../utils/i18n.js';
import type { RepRefusalCode } from './reputationService.js';

/** Texte d'un refus de vote, dans la langue du serveur. */
export function repRefusalMessage(code: RepRefusalCode, locale: BotLocale, dailyLimit: number): string {
  switch (code) {
    case 'SELF':
      return m.b2_rep_err_self({}, { locale });
    case 'BOT':
      return m.b2_rep_err_bot({}, { locale });
    case 'DAILY_LIMIT':
      return m.b2_rep_err_daily_limit({ limit: dailyLimit }, { locale });
    case 'ALREADY_TODAY':
      return m.b2_rep_err_already_today({}, { locale });
  }
}

/** Même texte, avec la limite du jour lue dans les réglages du serveur. */
export async function repRefusalText(guildId: string, code: RepRefusalCode, locale: BotLocale): Promise<string> {
  // Import différé : ce fichier reste chargeable sans base de données.
  const { getReputationConfig } = await import('./reputationService.js');
  const { dailyLimit } = await getReputationConfig(guildId);
  return repRefusalMessage(code, locale, dailyLimit);
}

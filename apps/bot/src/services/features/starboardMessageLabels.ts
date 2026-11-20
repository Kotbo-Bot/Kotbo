import * as m from '../../lib/paraglide/messages.js';
import type { BotLocale } from '../../utils/i18n.js';

/** Textes du message à la une, dans la langue du serveur, pour l'aperçu du dashboard. */
export interface StarboardMessageLabels {
  locale: string;
  jumpButton: string;
  /** Porte `{up}` et `{down}`. */
  footerVotes: string;
  attachmentsField: string;
}

export function starboardMessageLabels(locale: BotLocale): StarboardMessageLabels {
  const o = { locale };
  return {
    locale,
    jumpButton: m.starboard_jump_button({}, o),
    footerVotes: m.starboard_footer_votes({ up: '{up}', down: '{down}' }, o),
    attachmentsField: m.starboard_attachments_field({}, o),
  };
}

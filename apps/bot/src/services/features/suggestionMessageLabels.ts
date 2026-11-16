import * as m from '../../lib/paraglide/messages.js';
import type { BotLocale } from '../../utils/i18n.js';
import type { SuggestionMessageLabels } from './suggestionMessage.js';

/** Textes du message public, dans la langue du serveur, trous compris. */
export function suggestionMessageLabels(locale: BotLocale): SuggestionMessageLabels {
  const o = { locale };
  return {
    locale,
    title: m.b5_suggestion_msg_title({}, o),
    statusField: m.b5_suggestion_msg_status({}, o),
    votesField: m.b5_suggestion_msg_votes({}, o),
    finalVotesField: m.b5_suggestion_msg_final_votes({}, o),
    votesValue: m.b5_suggestion_msg_votes_value({ up: '{up}', down: '{down}' }, o),
    responseField: m.b5_suggestion_msg_response({}, o),
    noResponse: m.b5_suggestion_msg_no_response({}, o),
    voteUp: m.b5_suggestion_btn_up({}, o),
    voteDown: m.b5_suggestion_btn_down({}, o),
    footer: m.b5_suggestion_msg_footer({ id: '{id}' }, o),
    status: {
      PENDING: m.b5_suggestion_status_pending({}, o),
      APPROVED: m.b5_suggestion_status_approved({}, o),
      REJECTED: m.b5_suggestion_status_rejected({}, o),
      IMPLEMENTED: m.b5_suggestion_status_implemented({}, o),
    },
  };
}

import * as m from '../../lib/paraglide/messages.js';
import type { BotLocale } from '../../utils/i18n.js';
import type { SuggestionRefusalCode, SuggestionSubmitRules } from '@kotbo/shared';
import type { SuggestionMessageLabels, SuggestionNoticeLabels } from './suggestionMessage.js';

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

/** Textes de l'avis de décision envoyé à l'auteur, dans la langue du serveur. */
export function suggestionNoticeLabels(locale: BotLocale): SuggestionNoticeLabels {
  const o = { locale };
  return {
    title: m.b5_suggestion_notice_title({ server: '{server}' }, o),
    contentField: m.b5_suggestion_notice_content({}, o),
    responseField: m.b5_suggestion_notice_response({}, o),
    decided: {
      APPROVED: m.b5_suggestion_notice_approved({}, o),
      REJECTED: m.b5_suggestion_notice_rejected({}, o),
      IMPLEMENTED: m.b5_suggestion_notice_implemented({}, o),
    },
  };
}

/** Motif d'un refus de proposer, avec les seuils du serveur. */
export function suggestionRefusalMessage(
  refusal: { code: SuggestionRefusalCode; retryAt?: Date },
  rules: Pick<SuggestionSubmitRules, 'minAccountAgeDays' | 'minMemberDays'>,
  locale: BotLocale,
  now: Date = new Date(),
): string {
  const o = { locale };
  switch (refusal.code) {
    case 'ROLE':
      return m.b5_suggestion_err_role({}, o);
    case 'COOLDOWN':
      return m.b5_suggestion_err_cooldown({
        minutes: Math.max(1, Math.ceil(((refusal.retryAt?.getTime() ?? now.getTime()) - now.getTime()) / 60_000)),
      }, o);
    case 'ACCOUNT_TOO_NEW':
      return m.b5_suggestion_err_account_too_new({ days: rules.minAccountAgeDays }, o);
    case 'MEMBER_TOO_NEW':
      return m.b5_suggestion_err_member_too_new({ days: rules.minMemberDays }, o);
  }
}

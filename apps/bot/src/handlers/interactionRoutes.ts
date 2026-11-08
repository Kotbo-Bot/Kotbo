export type ValidateRoute = {
  /** `dismiss` = hors-sujet : aucun point, mais aucune sanction (Daily Algo). */
  action: 'approve' | 'reject' | 'dismiss' | 'translate' | 'pin' | 'rate';
  type: 'daily-algo';
  itemId: string;
};

export type UserCaseSection = 'resume' | 'sanctions' | 'identite' | 'activite';

export type UserCaseRoute = {
  action: 'open' | 'refresh' | 'prev' | 'next' | 'close' | 'section' | 'note' | 'sanction_action' | 'sanction' | 'revoke';
  userId: string;
  section?: UserCaseSection;
  pageIndex?: number;
  /** Type de sanction rapide demandé via bouton (warn/timeout/kick/ban). */
  sanctionType?: 'warn' | 'timeout' | 'kick' | 'ban';
  /** ID de la sanction à révoquer. */
  sanctionId?: string;
};

export function parseValidateRoute(customId: string): ValidateRoute | null {
  if (!customId.startsWith('validate:')) return null;

  const parts = customId.split(':');
  if (parts.length < 4) return null;

  const action = parts[1] as ValidateRoute['action'];
  const type = parts[2] as ValidateRoute['type'];
  const itemId = parts[3];

  return { action, type, itemId };
}

export function parseSessionRoute(customId: string): { type: string; sessionId: string } | null {
  if (!customId.startsWith('session:')) return null;
  const parts = customId.split(':');
  if (parts.length < 3) return null;
  return { type: parts[1], sessionId: parts[2] };
}

export function parseMeetingRoute(customId: string): { meetingId: string; status: string } | null {
  if (!customId.startsWith('meeting:')) return null;
  const parts = customId.split(':');
  if (parts.length < 3) return null;
  return { meetingId: parts[1], status: parts[2] };
}

export function parseMeetingExcuseModal(customId: string): string | null {
  if (!customId.startsWith('meeting_excuse_modal:')) return null;
  return customId.split(':')[1] ?? null;
}

export function parseRecruitExcuseModal(customId: string): string | null {
  if (!customId.startsWith('recruit_excuse_modal:')) return null;
  return customId.split(':')[1] ?? null;
}

export function parseConfigRoute(customId: string): string | null {
  if (!customId.startsWith('cfg:')) return null;
  return customId.split(':')[2] ?? null;
}

export function parseModalSessionId(customId: string, expectedPrefix: string): string | null {
  if (!customId.startsWith(expectedPrefix)) return null;
  return customId.split(':')[3] ?? null;
}

export function parseUserCaseRoute(customId: string): UserCaseRoute | null {
  if (!customId.startsWith('case:')) return null;

  const parts = customId.split(':');
  const action = parts[1];

  if (action === 'open' || action === 'close' || action === 'note' || action === 'sanction_action') {
    const userId = parts[2];
    if (!userId) return null;
    return { action, userId } as UserCaseRoute;
  }

  if (action === 'refresh' || action === 'prev' || action === 'next') {
    const userId = parts[2];
    const section = parts[3] as UserCaseSection | undefined;
    const pageIndex = Number.parseInt(parts[4] ?? '0', 10);
    if (!userId) return null;
    if (section && section !== 'resume' && section !== 'sanctions' && section !== 'identite' && section !== 'activite') return null;
    return {
      action,
      userId,
      section,
      pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0,
    };
  }

  if (action === 'section') {
    const userId = parts[2];
    const pageIndex = Number.parseInt(parts[3] ?? '0', 10);
    if (!userId) return null;
    return {
      action,
      userId,
      pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0,
    };
  }

  // case:sanction:<userId>:<warn|timeout|kick|ban>
  if (action === 'sanction') {
    const userId = parts[2];
    const sanctionType = parts[3];
    if (!userId) return null;
    if (sanctionType !== 'warn' && sanctionType !== 'timeout' && sanctionType !== 'kick' && sanctionType !== 'ban') return null;
    return { action, userId, sanctionType };
  }

  // case:revoke:<userId>:<sanctionId>:<pageIndex>
  if (action === 'revoke') {
    const userId = parts[2];
    const sanctionId = parts[3];
    const pageIndex = Number.parseInt(parts[4] ?? '0', 10);
    if (!userId || !sanctionId) return null;
    return {
      action,
      userId,
      sanctionId,
      pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0,
    };
  }

  return null;
}

/**
 * Route générique du hub `/rpg` : `rpg:<action>:<ownerId>:<...rest>`.
 * L'action reste une string libre (trop de variantes pour un union type) ;
 * c'est `rpgPanelService` qui interprète `action`/`rest` au cas par cas.
 * `ownerId` est systématiquement le Discord user id du propriétaire de la
 * session, pour que le handler puisse refuser les clics d'un autre membre.
 */
export type RpgRoute = {
  action: string;
  ownerId: string;
  rest: string[];
};

export function parseRpgRoute(customId: string): RpgRoute | null {
  if (!customId.startsWith('rpg:')) return null;

  const parts = customId.split(':');
  const action = parts[1];
  const ownerId = parts[2];
  if (!action || !ownerId) return null;

  return { action, ownerId, rest: parts.slice(3) };
}

export function parseEventQuizRoute(customId: string): { questionId: string; optionIndex?: number } | null {
  if (customId.startsWith('event-quiz-answer:')) {
    const parts = customId.split(':');
    return { questionId: parts[1], optionIndex: parseInt(parts[2], 10) };
  }
  if (customId.startsWith('event-quiz-select:')) {
    const parts = customId.split(':');
    return { questionId: parts[1] };
  }
  return null;
}

export function parseEventResultRoute(customId: string): { eventId: string; page: number } | null {
  if (!customId.startsWith('event-result-page:')) return null;
  const parts = customId.split(':');
  if (parts.length < 3) return null;
  return { eventId: parts[1], page: parseInt(parts[2], 10) };
}

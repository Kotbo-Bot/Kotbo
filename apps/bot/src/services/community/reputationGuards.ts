/**
 * Garde-fous d'un vote de réputation, réglés par serveur : salons et rôles
 * exclus, âge du compte et ancienneté du donneur, attente avant de remercier
 * à nouveau le même membre. Règles pures, sans Discord ni base.
 */
import type { ReputationSettings } from './reputationService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type RepGuardCode =
  | 'CHANNEL_EXCLUDED'
  | 'GIVER_EXCLUDED'
  | 'RECEIVER_EXCLUDED'
  | 'ACCOUNT_TOO_NEW'
  | 'MEMBER_TOO_NEW';

export type RepGuardSettings = Pick<
  ReputationSettings,
  'minAccountAgeDays' | 'minMemberDays' | 'excludedRoleIds' | 'excludedChannelIds'
>;

export interface RepGuardInput {
  giver: { accountCreatedAt: Date; joinedAt: Date | null; roleIds: readonly string[] };
  receiverRoleIds: readonly string[];
  /** Absent pour un vote sans salon (menu contextuel sur un membre). */
  channelId?: string | null;
}

/** Un garde-fou demande le profil des membres : sans lui, inutile de les récupérer. */
export function hasMemberGuards(settings: RepGuardSettings): boolean {
  return settings.minAccountAgeDays > 0 || settings.minMemberDays > 0 || settings.excludedRoleIds.length > 0;
}

function olderThan(date: Date, days: number, now: Date): boolean {
  return now.getTime() - date.getTime() >= days * DAY_MS;
}

export function repGuardRefusal(input: RepGuardInput, settings: RepGuardSettings, now: Date = new Date()): RepGuardCode | null {
  if (input.channelId && settings.excludedChannelIds.includes(input.channelId)) return 'CHANNEL_EXCLUDED';

  const excluded = new Set(settings.excludedRoleIds);
  if (input.giver.roleIds.some((roleId) => excluded.has(roleId))) return 'GIVER_EXCLUDED';
  if (input.receiverRoleIds.some((roleId) => excluded.has(roleId))) return 'RECEIVER_EXCLUDED';

  if (settings.minAccountAgeDays > 0 && !olderThan(input.giver.accountCreatedAt, settings.minAccountAgeDays, now)) {
    return 'ACCOUNT_TOO_NEW';
  }
  if (settings.minMemberDays > 0 && input.giver.joinedAt && !olderThan(input.giver.joinedAt, settings.minMemberDays, now)) {
    return 'MEMBER_TOO_NEW';
  }
  return null;
}

/** Jours (YYYY-MM-DD, fuseau du serveur) : le dernier vote vers ce membre bloque-t-il encore ? */
export function repCooldownBlocks(lastDay: string, today: string, cooldownDays: number): boolean {
  const elapsed = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`)) / DAY_MS);
  return elapsed < cooldownDays;
}

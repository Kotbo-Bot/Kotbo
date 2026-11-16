/**
 * Règles du module Suggestions partagées entre le bot et le dashboard : ce que
 * le formulaire et la page annoncent est ce que l'API applique.
 */

export const SUGGESTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'IMPLEMENTED'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];
export type SuggestionDecision = Exclude<SuggestionStatus, 'PENDING'>;

/** Réponse du staff : elle tombe dans un champ d'embed, plafonné à 1 024 caractères. */
export const SUGGESTION_RESPONSE_MAX = 1000;

/** Rôles autorisés à proposer. Liste vide = tout le monde. */
export const SUGGESTION_ALLOWED_ROLES_MAX = 25;

/** Jours après lesquels une suggestion encore en attente est signalée. */
export const SUGGESTION_STALE_DAYS = 7;

/** Fenêtre des statistiques de la page, en jours. */
export const SUGGESTION_STATS_DAYS = 30;

/** Suggestions en attente renvoyées d'un bloc à la file du dashboard. */
export const SUGGESTION_QUEUE_MAX = 200;

/** Couleur du message Discord, par statut. */
export const SUGGESTION_STATUS_COLORS: Record<SuggestionStatus, string> = {
  PENDING: '#FE75C2',
  APPROVED: '#57F287',
  REJECTED: '#ED4245',
  IMPLEMENTED: '#5865F2',
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function isSuggestionStatus(value: unknown): value is SuggestionStatus {
  return typeof value === 'string' && (SUGGESTION_STATUSES as readonly string[]).includes(value);
}

/** Remettre en attente n'a rien à expliquer : seule une décision demande un mot. */
export function suggestionNeedsComment(status: SuggestionStatus, requireComment: boolean): boolean {
  return requireComment && status !== 'PENDING';
}

/**
 * Votes ouverts : en attente toujours ; sur une suggestion approuvée quand le
 * serveur veut mesurer l'envie jusqu'à la mise en place.
 */
export function isSuggestionVotingOpen(status: SuggestionStatus, voteWhileApproved: boolean): boolean {
  return status === 'PENDING' || (voteWhileApproved && status === 'APPROVED');
}

/**
 * Membre autorisé à proposer : liste vide, un rôle de la liste, ou gestionnaire
 * du serveur. Un membre introuvable ne passe qu'une liste vide.
 */
export function canSubmitSuggestion(
  allowedRoleIds: readonly string[],
  member: { roleIds: readonly string[]; canManageGuild: boolean } | null,
): boolean {
  if (allowedRoleIds.length === 0) return true;
  if (!member) return false;
  return member.canManageGuild || member.roleIds.some((roleId) => allowedRoleIds.includes(roleId));
}

export function isSuggestionStale(createdAt: Date | string, now: Date = new Date()): boolean {
  return now.getTime() - new Date(createdAt).getTime() > SUGGESTION_STALE_DAYS * DAY_MS;
}

/** Une ligne du relevé SQL : décisions d'un statut sur la fenêtre, délai moyen en secondes. */
export interface SuggestionResolutionRow {
  status: string;
  count: number;
  avgSeconds: number | null;
}

export interface SuggestionResolutionSummary {
  resolved: number;
  /** Part des décisions favorables (approuvée ou mise en place), entre 0 et 1. */
  acceptanceRate: number | null;
  avgResponseHours: number | null;
}

export function summarizeSuggestionResolutions(rows: readonly SuggestionResolutionRow[]): SuggestionResolutionSummary {
  const decided = rows.filter((row) => isSuggestionStatus(row.status) && row.status !== 'PENDING' && row.count > 0);
  const resolved = decided.reduce((sum, row) => sum + row.count, 0);
  if (resolved === 0) return { resolved: 0, acceptanceRate: null, avgResponseHours: null };

  const accepted = decided
    .filter((row) => row.status === 'APPROVED' || row.status === 'IMPLEMENTED')
    .reduce((sum, row) => sum + row.count, 0);
  const totalSeconds = decided.reduce((sum, row) => sum + (row.avgSeconds ?? 0) * row.count, 0);
  return {
    resolved,
    acceptanceRate: accepted / resolved,
    avgResponseHours: totalSeconds / resolved / 3600,
  };
}

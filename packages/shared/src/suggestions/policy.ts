/**
 * Règles du module Suggestions partagées entre le bot et le dashboard : ce que
 * le formulaire et la page annoncent est ce que l'API applique.
 */

/** `IN_PROGRESS` : acceptée et en cours de réalisation, entre l'approbation et la mise en place. */
export const SUGGESTION_STATUSES = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'REJECTED', 'IMPLEMENTED'] as const;
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
  IN_PROGRESS: '#FEE75C',
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
 * Votes ouverts : en attente toujours ; sur une suggestion approuvée ou en
 * cours quand le serveur veut mesurer l'envie jusqu'à la mise en place.
 */
export function isSuggestionVotingOpen(status: SuggestionStatus, voteWhileApproved: boolean): boolean {
  return status === 'PENDING' || (voteWhileApproved && (status === 'APPROVED' || status === 'IN_PROGRESS'));
}

/** Décision favorable : approuvée, en cours ou mise en place. */
export function isSuggestionAccepted(status: SuggestionStatus): boolean {
  return status === 'APPROVED' || status === 'IN_PROGRESS' || status === 'IMPLEMENTED';
}

/**
 * Ce que devient la récompense de l'auteur quand le statut change : versée en
 * entrant dans une décision favorable, reprise en en sortant (refus,
 * réouverture). Passer d'« approuvée » à « mise en place » ne la verse pas deux fois.
 */
export function suggestionRewardMove(before: SuggestionStatus, after: SuggestionStatus): 'grant' | 'reclaim' | null {
  const was = isSuggestionAccepted(before);
  const is = isSuggestionAccepted(after);
  if (!was && is) return 'grant';
  if (was && !is) return 'reclaim';
  return null;
}

/** Récompense de l'auteur d'une suggestion acceptée. `0` = rien. */
export const SUGGESTION_REWARD_XP = { min: 0, max: 5_000 } as const;
export const SUGGESTION_REWARD_COINS = { min: 0, max: 100_000 } as const;

/** Catégories proposées dans la fenêtre : une liste déroulante en tient 25, on en garde moins. */
export const SUGGESTION_CATEGORIES_MAX = 10;
export const SUGGESTION_CATEGORY_NAME_MAX = 32;

export type SuggestionCategoryError = 'NOT_ARRAY' | 'TOO_MANY' | 'TOO_LONG';

/** Liste nettoyée : espaces retirés, vides et doublons (sans tenir compte de la casse) écartés. */
export function normalizeSuggestionCategories(raw: unknown): { categories: string[] } | { error: SuggestionCategoryError } {
  if (!Array.isArray(raw) || raw.some((name) => typeof name !== 'string')) return { error: 'NOT_ARRAY' };
  const categories: string[] = [];
  for (const name of (raw as string[]).map((value) => value.trim()).filter(Boolean)) {
    if (name.length > SUGGESTION_CATEGORY_NAME_MAX) return { error: 'TOO_LONG' };
    if (!categories.some((kept) => kept.toLowerCase() === name.toLowerCase())) categories.push(name);
  }
  if (categories.length > SUGGESTION_CATEGORIES_MAX) return { error: 'TOO_MANY' };
  return { categories };
}

/** Catégorie du serveur qui correspond au choix, à la casse près ; `null` sinon. */
export function matchSuggestionCategory(categories: readonly string[], choice: string | null | undefined): string | null {
  const wanted = choice?.trim().toLowerCase();
  return (wanted && categories.find((name) => name.toLowerCase() === wanted)) || null;
}

/** Titre facultatif d'une suggestion : un nom de fil Discord, plafonné à 100 caractères. */
export const SUGGESTION_TITLE_MAX = 100;

/** Votes « pour » à partir desquels une suggestion est signalée au staff. */
export const SUGGESTION_VOTE_THRESHOLD = { min: 2, max: 1000 } as const;

/** Garde-fous de qui propose. `0` = aucune exigence. */
export const SUGGESTION_COOLDOWN_MINUTES = { min: 0, max: 10_080 } as const;
export const SUGGESTION_MIN_ACCOUNT_AGE_DAYS = { min: 0, max: 365 } as const;
export const SUGGESTION_MIN_MEMBER_DAYS = { min: 0, max: 365 } as const;

export type SuggestionRefusalCode = 'ROLE' | 'COOLDOWN' | 'ACCOUNT_TOO_NEW' | 'MEMBER_TOO_NEW';

export interface SuggestionSubmitRules {
  /** Rôles autorisés à proposer. Vide = tout le monde. */
  allowedRoleIds: readonly string[];
  cooldownMinutes: number;
  minAccountAgeDays: number;
  minMemberDays: number;
}

export interface SuggestionSubmitter {
  roleIds: readonly string[];
  canManageGuild: boolean;
  accountCreatedAt: Date;
  /** `null` quand Discord ne la donne pas : l'ancienneté n'est alors pas prouvée. */
  joinedAt: Date | null;
}

/**
 * Ce qui empêche ce membre de proposer maintenant, ou `null`.
 *
 * Un gestionnaire du serveur passe toujours. Un membre introuvable ne passe
 * que les règles qui ne le concernent pas : rôles, âge du compte et ancienneté
 * ne se vérifient pas sans lui. Le délai se compte depuis sa dernière
 * suggestion, et `retryAt` dit quand il pourra recommencer.
 */
export function suggestionSubmitBlocker(
  rules: SuggestionSubmitRules,
  member: SuggestionSubmitter | null,
  lastSuggestionAt: Date | null,
  now: Date = new Date(),
): { code: Exclude<SuggestionRefusalCode, 'COOLDOWN'> } | { code: 'COOLDOWN'; retryAt: Date } | null {
  if (member?.canManageGuild) return null;

  if (rules.allowedRoleIds.length > 0 && !member?.roleIds.some((roleId) => rules.allowedRoleIds.includes(roleId))) {
    return { code: 'ROLE' };
  }
  if (rules.minAccountAgeDays > 0
    && (!member || now.getTime() - member.accountCreatedAt.getTime() < rules.minAccountAgeDays * DAY_MS)) {
    return { code: 'ACCOUNT_TOO_NEW' };
  }
  if (rules.minMemberDays > 0
    && (!member?.joinedAt || now.getTime() - member.joinedAt.getTime() < rules.minMemberDays * DAY_MS)) {
    return { code: 'MEMBER_TOO_NEW' };
  }
  if (rules.cooldownMinutes > 0 && lastSuggestionAt) {
    const retryAt = new Date(lastSuggestionAt.getTime() + rules.cooldownMinutes * 60_000);
    if (retryAt.getTime() > now.getTime()) return { code: 'COOLDOWN', retryAt };
  }
  return null;
}

/** Le vote qui fait passer les « pour » de sous le seuil à au moins le seuil. */
export function crossedSuggestionThreshold(threshold: number | null, upvotesBefore: number, upvotesAfter: number): boolean {
  return threshold !== null && upvotesBefore < threshold && upvotesAfter >= threshold;
}

/** Nom du fil de discussion : le titre, sinon le début du texte sur une ligne. */
export function suggestionThreadName(title: string | null, content: string): string {
  const source = (title?.trim() || content).replace(/\s+/g, ' ').trim();
  return source.length <= SUGGESTION_TITLE_MAX ? source : `${source.slice(0, SUGGESTION_TITLE_MAX - 1)}…`;
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
  /** Part des décisions favorables (approuvée, en cours ou mise en place), entre 0 et 1. */
  acceptanceRate: number | null;
  avgResponseHours: number | null;
}

export function summarizeSuggestionResolutions(rows: readonly SuggestionResolutionRow[]): SuggestionResolutionSummary {
  const decided = rows.filter((row) => isSuggestionStatus(row.status) && row.status !== 'PENDING' && row.count > 0);
  const resolved = decided.reduce((sum, row) => sum + row.count, 0);
  if (resolved === 0) return { resolved: 0, acceptanceRate: null, avgResponseHours: null };

  const accepted = decided
    .filter((row) => isSuggestionStatus(row.status) && isSuggestionAccepted(row.status))
    .reduce((sum, row) => sum + row.count, 0);
  const totalSeconds = decided.reduce((sum, row) => sum + (row.avgSeconds ?? 0) * row.count, 0);
  return {
    resolved,
    acceptanceRate: accepted / resolved,
    avgResponseHours: totalSeconds / resolved / 3600,
  };
}

/** Une ligne du relevé par catégorie et statut. `category: null` = sans catégorie. */
export interface SuggestionCategoryRow {
  category: string | null;
  status: string;
  count: number;
}

export interface SuggestionCategorySummary {
  category: string | null;
  total: number;
  pending: number;
  accepted: number;
}

/** Bilan par catégorie, la plus fournie d'abord. */
export function summarizeSuggestionCategories(rows: readonly SuggestionCategoryRow[]): SuggestionCategorySummary[] {
  const byCategory = new Map<string | null, SuggestionCategorySummary>();
  for (const row of rows) {
    const entry = byCategory.get(row.category) ?? { category: row.category, total: 0, pending: 0, accepted: 0 };
    entry.total += row.count;
    if (row.status === 'PENDING') entry.pending += row.count;
    else if (isSuggestionStatus(row.status) && isSuggestionAccepted(row.status)) entry.accepted += row.count;
    byCategory.set(row.category, entry);
  }
  return [...byCategory.values()].sort((a, b) => b.total - a.total);
}

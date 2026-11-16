import type { SuggestionStatus } from '@kotbo/shared';

export interface SuggestionConfig {
  /** Salon de publication. `null` = repli sur un salon nommé « suggestions ». */
  channelId: string | null;
  /** Une décision doit porter un commentaire public. */
  requireComment: boolean;
  /** Votes ouverts sur une suggestion approuvée. */
  voteWhileApproved: boolean;
  /** Rôles autorisés à proposer. Vide = tout le monde. */
  allowedRoleIds: string[];
}

export interface SuggestionItem {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  content: string;
  status: SuggestionStatus;
  responseText: string | null;
  respondedById: string | null;
  respondedByName: string | null;
  respondedAt: string | null;
  upvotes: number;
  downvotes: number;
  createdAt: string;
  messageUrl: string | null;
}

export interface SuggestionStats {
  pending: number;
  stalePending: number;
  createdRecent: number;
  resolvedRecent: number;
  /** Entre 0 et 1 ; `null` sans décision sur la fenêtre. */
  acceptanceRate: number | null;
  avgResponseHours: number | null;
  lastCreatedAt: string | null;
}

/** Gabarits du message public dans la langue du serveur ; `votesValue` porte `{up}` et `{down}`. */
export interface SuggestionMessageLabels {
  locale: string;
  title: string;
  statusField: string;
  votesField: string;
  finalVotesField: string;
  votesValue: string;
  responseField: string;
  noResponse: string;
  voteUp: string;
  voteDown: string;
  footer: string;
  status: Record<SuggestionStatus, string>;
}

export interface SuggestionsOverview {
  config: SuggestionConfig;
  stats: SuggestionStats;
  /** En attente, la plus ancienne d'abord. */
  queue: SuggestionItem[];
  /** La file a été coupée : il y en a plus que ce qui est montré. */
  queueTruncated: boolean;
  /** Absent d'un bot plus ancien : l'aperçu du message est alors masqué. */
  messageLabels: SuggestionMessageLabels | null;
}

export interface SuggestionPage {
  suggestions: SuggestionItem[];
  nextCursor: string | null;
}

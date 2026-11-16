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
  /** Garde-fous de qui propose. `0` = aucune exigence. */
  cooldownMinutes: number;
  minAccountAgeDays: number;
  minMemberDays: number;
  /** Prévenir l'auteur en message privé quand le staff tranche. */
  notifyAuthor: boolean;
  /** Ouvrir un fil de discussion sous chaque nouvelle suggestion. */
  createThread: boolean;
  /** Votes « pour » qui signalent la suggestion. `null` = pas de seuil. */
  voteThreshold: number | null;
  /** Épingler le message au seuil ; la décision le désépingle. */
  pinAtThreshold: boolean;
  /** Récompense de l'auteur d'une suggestion acceptée. `0` = rien. */
  rewardXp: number;
  rewardCoins: number;
  /** Catégories proposées à qui suggère. Vide = pas de catégorie. */
  categories: string[];
  /** Le staff voit qui a voté. */
  showVoters: boolean;
}

export interface SuggestionItem {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** Titre saisi par l'auteur, absent d'une suggestion proposée sans fenêtre. */
  title: string | null;
  /** Catégorie choisie à la proposition. */
  category: string | null;
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
  /** Fil de discussion, quand le serveur en ouvre. */
  threadUrl: string | null;
  /** Premier passage du seuil de votes. */
  thresholdReachedAt: string | null;
  /** Récompense réellement versée à l'auteur ; absente d'un bot plus ancien. */
  rewarded?: { xp: number; coins: number };
}

export interface SuggestionCategoryStat {
  /** `null` : suggestions sans catégorie. */
  category: string | null;
  total: number;
  pending: number;
  accepted: number;
}

export interface SuggestionVoter {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
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
  categoryField?: string;
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
  categoryStats: SuggestionCategoryStat[];
}

export interface SuggestionPage {
  suggestions: SuggestionItem[];
  nextCursor: string | null;
}

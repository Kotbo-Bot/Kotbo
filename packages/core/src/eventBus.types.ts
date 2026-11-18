/**
 * Kotbo Internal Event Bus - Type definitions
 *
 * Each domain module publishes and subscribes to typed events.
 * Phase 1: in-process EventEmitter (same bot instance)
 * Phase 2: Redis Pub/Sub (multi-process, multi-bot split)
 */

// ── Message Events ──────────────────────────────────────────────
export interface MessageNewEvent {
  guildId: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  content: string;
  isBot: boolean;
  isCommand: boolean;
  hasReference: boolean;
  messageId: string;
  attachmentCount: number;
  isInteraction: boolean;
  timestamp: number;
}

export interface MessageDeleteEvent {
  guildId: string;
  channelId: string;
  authorId: string | null;
  authorTag: string | null;
  messageId: string;
  content: string | null;
  timestamp: number;
}

export interface MessageUpdateEvent {
  guildId: string;
  channelId: string;
  authorId: string | null;
  messageId: string;
  oldContent: string | null;
  newContent: string | null;
  /**
   * Date de la dernière modification du texte. Discord publie aussi une mise à
   * jour quand il ajoute l'aperçu d'un lien ou qu'un message est épinglé : sans
   * modification récente, ce n'est pas une édition.
   */
  editedTimestamp?: number | null;
  timestamp: number;
}

// ── Voice Events ────────────────────────────────────────────────
export interface VoiceJoinEvent {
  guildId: string;
  userId: string;
  channelId: string;
  channelName: string | null;
  timestamp: number;
}

export interface VoiceLeaveEvent {
  guildId: string;
  userId: string;
  channelId: string;
  channelName: string | null;
  durationMs: number | null;
  joinTimestamp: number | null;
  timestamp: number;
}

export interface VoiceMoveEvent {
  guildId: string;
  userId: string;
  fromChannelId: string;
  fromChannelName: string | null;
  toChannelId: string;
  toChannelName: string | null;
  joinTimestamp: number | null;
  timestamp: number;
}

// ── Member Events ───────────────────────────────────────────────
export interface MemberJoinEvent {
  guildId: string;
  userId: string;
  userTag: string;
  isBot: boolean;
  timestamp: number;
}

/**
 * Arrivée dont l'invitation utilisée a pu être identifiée.
 *
 * Distinct de `member:join` parce que cette identification n'est pas gratuite :
 * elle se déduit d'un différentiel de compteurs d'invitations, et ce
 * différentiel se consomme. Un second détecteur qui rejouerait la comparaison
 * ne verrait plus rien. L'événement est donc publié par le seul endroit qui la
 * calcule, et tous ceux qui ont besoin de la provenance s'y abonnent.
 *
 * Publié après `member:join`, et seulement quand une invitation a été
 * identifiée : une arrivée par URL personnalisée ou par découverte n'en produit
 * pas.
 */
export interface MemberJoinInviteEvent {
  guildId: string;
  userId: string;
  userTag: string;
  isBot: boolean;
  inviteCode: string;
  inviterId: string | null;
  timestamp: number;
}

export interface MemberLeaveEvent {
  guildId: string;
  userId: string;
  userTag: string;
  isBot: boolean;
  timestamp: number;
}

export interface MemberUpdateEvent {
  guildId: string;
  userId: string;
  oldNickname: string | null;
  newNickname: string | null;
  addedRoles: string[];
  removedRoles: string[];
  isBoosting: boolean;
  timestamp: number;
}

export interface MemberTagEvent {
  guildId: string;
  userId: string;
  userTag: string;
  oldGuildId: string | null;
  oldTag: string | null;
  oldBadge: string | null;
  newGuildId: string | null;
  newTag: string | null;
  newBadge: string | null;
  isOwnGuild: boolean;
  timestamp: number;
}

// ── Moderation Events ───────────────────────────────────────────
export interface SanctionAppliedEvent {
  guildId: string;
  targetId: string;
  targetTag: string;
  moderatorId: string;
  moderatorTag: string;
  /** Reprend l'énumération Prisma `SanctionType` sans la traduire. */
  type: 'WARN' | 'KICK' | 'TIMEOUT' | 'TEMP_BAN' | 'BAN' | 'SOFTBAN' | 'JAIL';
  reason: string | null;
  duration: number | null;
  sanctionId: string | null;
  timestamp: number;
}

/**
 * Sanction levée. Publiée depuis les événements Discord (débannissement, fin
 * d'exclusion temporaire retirée à la main) : toutes les sources y passent,
 * dashboard, commandes ou Discord lui-même. Discord ne signale pas la fin
 * naturelle d'une exclusion temporaire, ni qui a levé la sanction.
 */
export interface SanctionRevokedEvent {
  guildId: string;
  targetId: string;
  targetTag?: string | null;
  moderatorId: string;
  type: 'UNBAN' | 'UNTIMEOUT' | 'UNMUTE' | 'UNWARN';
  sanctionId: string | null;
  timestamp: number;
}

export interface AutoModTriggeredEvent {
  guildId: string;
  userId: string;
  channelId: string;
  rule: string;
  matchedContent: string | null;
  /** CENSOR : passages masqués, message republié sous l'identité du membre. */
  action: 'DELETE' | 'WARN' | 'TIMEOUT' | 'LOG' | 'CENSOR';
  timestamp: number;
}

// ── Reaction / Thread Events ────────────────────────────────────
export interface ReactionAddEvent {
  guildId: string;
  channelId: string;
  userId: string;
  messageId: string;
  emoji: string;
  timestamp: number;
}

export type ReactionRemoveEvent = ReactionAddEvent;

export interface ThreadCreateEvent {
  guildId: string;
  channelId: string;
  threadId: string;
  creatorId: string | null;
  timestamp: number;
}

// ── Channel Events ──────────────────────────────────────────────
export interface ChannelCreateEvent {
  guildId: string;
  channelId: string;
  channelName: string;
  channelType: number;
  timestamp: number;
}

export interface ChannelDeleteEvent {
  guildId: string;
  channelId: string;
  channelName: string;
  channelType: number;
  timestamp: number;
}

// ── Ticket Events ───────────────────────────────────────────────
export interface TicketCreatedEvent {
  guildId: string;
  ticketId: string;
  userId: string;
  userTag: string;
  /** Null en mode MP : la conversation ne vit dans aucun salon du serveur. */
  channelId: string | null;
  ticketTypeId: string | null;
  ticketTypeLabel: string | null;
  subject: string;
  timestamp: number;
}

export interface TicketClosedEvent {
  guildId: string;
  ticketId: string;
  userId: string;
  userTag: string;
  closedById: string;
  claimedById: string | null;
  /** Null quand la conversation ne vit pas dans un salon du serveur du ticket. */
  channelId: string | null;
  ticketTypeId: string | null;
  ticketTypeLabel: string | null;
  subject: string;
  openedAt: number;
  timestamp: number;
}

/** Première note laissée au sondage de satisfaction d'un ticket. */
export interface TicketRatedEvent {
  guildId: string;
  ticketId: string;
  userId: string;
  userTag: string;
  staffId: string | null;
  rating: number;
  channelId: string | null;
  ticketTypeLabel: string | null;
  subject: string;
  timestamp: number;
}

// ── Formulaires et suggestions ─────────────────────────────────

export interface FormSubmittedEvent {
  guildId: string;
  formId: string;
  formName: string;
  submissionId: string;
  /**
   * Null quand l'identité n'est pas garantie par Discord : une page publique
   * sans connexion laisse le navigateur déclarer l'identifiant qu'il veut.
   */
  userId: string | null;
  /** Nom saisi ou fourni par Discord, à afficher seulement. */
  authorName: string;
  /** Dans l'ordre du formulaire, les champs laissés vides en moins. */
  answers: Array<{ label: string; value: string }>;
  timestamp: number;
}

export interface SuggestionCreatedEvent {
  guildId: string;
  suggestionId: string;
  userId: string;
  username: string;
  /** Titre saisi dans la fenêtre de proposition, sinon null. */
  title: string | null;
  /** Catégorie choisie parmi celles du serveur, sinon null. */
  category: string | null;
  content: string;
  channelId: string;
  /** Null quand le bot n'a pas pu poster la suggestion. */
  messageId: string | null;
  timestamp: number;
}

/** Décision du staff : publiée à chaque changement de statut, jamais pour une remise en attente. */
export interface SuggestionResolvedEvent {
  guildId: string;
  suggestionId: string;
  userId: string;
  username: string;
  title: string | null;
  category: string | null;
  content: string;
  status: 'APPROVED' | 'IN_PROGRESS' | 'REJECTED' | 'IMPLEMENTED';
  /** Statut avant cette décision : `PENDING` pour une première décision. */
  previousStatus: 'PENDING' | 'APPROVED' | 'IN_PROGRESS' | 'REJECTED' | 'IMPLEMENTED';
  responseText: string;
  /** Null pour une réponse de l'assistant MCP. */
  respondedById: string | null;
  upvotes: number;
  downvotes: number;
  timestamp: number;
}

/** Une suggestion vient d'atteindre le seuil de votes « pour » du serveur, une seule fois. */
export interface SuggestionThresholdReachedEvent {
  guildId: string;
  suggestionId: string;
  userId: string;
  username: string;
  title: string | null;
  category: string | null;
  content: string;
  upvotes: number;
  downvotes: number;
  threshold: number;
  /** Message public de la suggestion, `null` si l'envoi a échoué. */
  channelId: string | null;
  messageId: string | null;
  timestamp: number;
}

/**
 * Un message vient de passer à la une pour la première fois (ou de nouveau
 * après un retrait du staff annulé). Ses suites pour l'auteur (gains, paliers)
 * sont déjà appliquées.
 */
export interface StarboardFeaturedEvent {
  guildId: string;
  entryId: string;
  authorId: string;
  /** Salon (ou fil) du message d'origine. */
  channelId: string;
  messageId: string;
  /** Republication dans le salon des messages à la une. */
  starChannelId: string;
  starMessageId: string;
  score: number;
  /** Messages de l'auteur passés à la une, celui-ci compris. */
  featuredCount: number;
  timestamp: number;
}

/** Un message affiché à la une vient d'en être retiré. */
export interface StarboardRemovedEvent {
  guildId: string;
  entryId: string;
  authorId: string;
  channelId: string;
  messageId: string;
  /** `BELOW_THRESHOLD`, `STAFF`, `GUARD` (auteur exclu, salon NSFW) ou `SOURCE_DELETED`. */
  reason: string;
  score: number;
  timestamp: number;
}

// ── Progression Events ──────────────────────────────────────────
export interface LevelUpEvent {
  guildId: string;
  userId: string;
  previousLevel: number;
  level: number;
  timestamp: number;
}

// ── Role Events ─────────────────────────────────────────────────
export interface RoleCreateEvent {
  guildId: string;
  roleId: string;
  roleName: string;
  timestamp: number;
}

export interface RoleDeleteEvent {
  guildId: string;
  roleId: string;
  roleName: string;
  timestamp: number;
}

// ── Paris en points de clan ─────────────────────────────────────

/**
 * Pari tranché par un arbitre.
 *
 * Le camp gagnant et les perdants sont transportés entiers : un abonné qui
 * n'aurait que les identifiants devrait relire la base pour savoir qui a gagné
 * quoi, alors que le règlement vient précisément de le calculer.
 */
export interface BetResolvedEvent {
  guildId: string;
  betId: string;
  subject: string;
  season: number;
  /** DUEL | POOL | TEAMS */
  shape: string;
  /** Enjeu total redistribué, crédit compris. */
  pot: number;
  winningSideLabel: string;
  /** Gain net de chacun : ce qu'il a touché moins ce qu'il avait engagé. */
  winners: Array<{ userId: string; netGain: number }>;
  losers: Array<{ userId: string; lost: number }>;
  resolvedById: string | null;
  timestamp: number;
}

/** Pari clos sans vainqueur : mises rendues. */
export interface BetRefundedEvent {
  guildId: string;
  betId: string;
  subject: string;
  season: number;
  /** REFUNDED | CANCELLED | EXPIRED | DECLINED */
  reason: string;
  refunded: Array<{ userId: string; amount: number }>;
  timestamp: number;
}

/**
 * Un membre vient d'engager plus de points qu'il n'en possède.
 *
 * `amount` est ce qui vient d'être creusé, `total` ce qu'il doit désormais :
 * un serveur qui alerte au franchissement d'un seuil a besoin du second, un
 * serveur qui journalise chaque emprunt a besoin du premier.
 */
export interface ClanDebtOpenedEvent {
  guildId: string;
  userId: string;
  amount: number;
  total: number;
  source: string;
  timestamp: number;
}

/** Dette entièrement remboursée sur les gains du membre. */
export interface ClanDebtClearedEvent {
  guildId: string;
  userId: string;
  repaid: number;
  timestamp: number;
}

/** Un membre vient de rejoindre un concours en cliquant sur le bouton. */
export interface GiveawayEntryEvent {
  guildId: string;
  giveawayId: string;
  userId: string;
  prize: string;
  channelId: string;
  /** Nombre d'inscrits après cette entrée. */
  participantCount: number;
  timestamp: number;
}

/**
 * Un membre a gagné, et son lot vient de lui être remis.
 *
 * Publié une fois par gagnant, et seulement quand le gain est acquis : un
 * tirage en attente de validation n'en publie pas, le staff pouvant encore
 * relancer.
 */
export interface GiveawayWinnerEvent {
  guildId: string;
  giveawayId: string;
  userId: string;
  prize: string;
  channelId: string;
  timestamp: number;
}

/** Mini-jeux des salons fun qui désignent un gagnant. */
export type FunGameKey = 'guess_number' | 'emoji_riddle';

/**
 * Un membre vient de gagner un mini-jeu d'un salon fun.
 *
 * Publié après l'enregistrement de la manche suivante : un workflow qui relit
 * l'état du jeu y trouve déjà le nouveau nombre ou le nouveau rébus. Une remise
 * à zéro depuis le dashboard ne publie rien, personne n'ayant gagné.
 */
export interface FunGameWonEvent {
  guildId: string;
  game: FunGameKey;
  userId: string;
  channelId: string;
  messageId: string;
  /** Texte du message gagnant, tel que le membre l'a écrit. */
  content: string;
  /** Réponse trouvée, telle qu'affichée aux joueurs : le nombre, ou le titre du rébus. */
  answer: string;
  timestamp: number;
}

/**
 * Un membre vient d'en remercier un autre (commande, menu contextuel ou
 * réaction), vote accepté. Les ajustements du staff ne sont pas publiés : ce
 * ne sont pas des remerciements.
 */
export interface ReputationGivenEvent {
  guildId: string;
  voteId: string;
  giverId: string;
  receiverId: string;
  reason: string | null;
  /** Salon du remerciement, `null` s'il est inconnu. */
  channelId: string | null;
  /** Message remercié, quand le vote en vient. */
  messageId: string | null;
  /** Réputation du membre remercié après ce vote. */
  total: number;
  timestamp: number;
}

/** Une saison de leveling vient de s'ouvrir (à la main, par le planning ou par enchaînement). */
export interface SeasonStartedEvent {
  guildId: string;
  seasonId: string;
  number: number;
  name: string;
  /** Fin prévue, ISO 8601. */
  endDate: string;
  timestamp: number;
}

/** Une saison de leveling vient d'être clôturée : classement figé, récompenses données. */
export interface SeasonEndedEvent {
  guildId: string;
  seasonId: string;
  number: number;
  name: string;
  /** Membres ayant gagné au moins 1 XP pendant la saison. */
  participants: number;
  /** Premier du classement, `null` si personne n'a gagné d'XP. */
  winnerId: string | null;
  winnerXp: number;
  timestamp: number;
}

/** Un concours vient d'être clôturé, avec ou sans gagnant. */
export interface GiveawayEndedEvent {
  guildId: string;
  giveawayId: string;
  prize: string;
  channelId: string;
  participantCount: number;
  winnerCount: number;
  timestamp: number;
}

// ── Partenariats ────────────────────────────────────────────────

// ── Mapping type → payload ──────────────────────────────────────
export interface KotboEventMap {
  'message:new': MessageNewEvent;
  'message:delete': MessageDeleteEvent;
  'message:update': MessageUpdateEvent;
  'voice:join': VoiceJoinEvent;
  'voice:leave': VoiceLeaveEvent;
  'voice:move': VoiceMoveEvent;
  'member:join': MemberJoinEvent;
  'member:join:invite': MemberJoinInviteEvent;
  'member:leave': MemberLeaveEvent;
  'member:update': MemberUpdateEvent;
  'member:tag': MemberTagEvent;
  'sanction:applied': SanctionAppliedEvent;
  'sanction:revoked': SanctionRevokedEvent;
  'automod:triggered': AutoModTriggeredEvent;
  'reaction:add': ReactionAddEvent;
  'reaction:remove': ReactionRemoveEvent;
  'form:submitted': FormSubmittedEvent;
  'suggestion:created': SuggestionCreatedEvent;
  'suggestion:resolved': SuggestionResolvedEvent;
  'suggestion:threshold-reached': SuggestionThresholdReachedEvent;
  'ticket:created': TicketCreatedEvent;
  'ticket:closed': TicketClosedEvent;
  'ticket:rated': TicketRatedEvent;
  'level:up': LevelUpEvent;
  'thread:create': ThreadCreateEvent;
  'channel:create': ChannelCreateEvent;
  'channel:delete': ChannelDeleteEvent;
  'role:create': RoleCreateEvent;
  'role:delete': RoleDeleteEvent;
  'bet:resolved': BetResolvedEvent;
  'bet:refunded': BetRefundedEvent;
  'clan:debt-opened': ClanDebtOpenedEvent;
  'clan:debt-cleared': ClanDebtClearedEvent;
  'giveaway:entry': GiveawayEntryEvent;
  'giveaway:winner': GiveawayWinnerEvent;
  'giveaway:ended': GiveawayEndedEvent;
  'fun:game-won': FunGameWonEvent;
  'reputation:given': ReputationGivenEvent;
  'starboard:featured': StarboardFeaturedEvent;
  'starboard:removed': StarboardRemovedEvent;
  'season:started': SeasonStartedEvent;
  'season:ended': SeasonEndedEvent;
}

export type KotboEventName = keyof KotboEventMap;

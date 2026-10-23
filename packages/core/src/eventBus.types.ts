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

// ── Moderation Events ───────────────────────────────────────────
export interface SanctionAppliedEvent {
  guildId: string;
  targetId: string;
  targetTag: string;
  moderatorId: string;
  moderatorTag: string;
  /** Reprend l'énumération Prisma `SanctionType` sans la traduire. */
  type: 'WARN' | 'KICK' | 'TIMEOUT' | 'TEMP_BAN' | 'BAN' | 'SOFTBAN';
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
  content: string;
  channelId: string;
  /** Null quand le bot n'a pas pu poster la suggestion. */
  messageId: string | null;
  timestamp: number;
}

export interface SuggestionResolvedEvent {
  guildId: string;
  suggestionId: string;
  userId: string;
  username: string;
  content: string;
  status: 'APPROVED' | 'REJECTED' | 'IMPLEMENTED';
  responseText: string;
  /** Null pour une réponse de l'assistant MCP. */
  respondedById: string | null;
  upvotes: number;
  downvotes: number;
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

/**
 * Un partenariat vient de changer d'etape.
 *
 * Publie apres l'ecriture et apres l'application des avantages : un workflow
 * qui reagit a l'activation trouve donc le role deja pose, et non une seconde
 * avant.
 */
export interface PartnershipStageEvent {
  guildId: string;
  partnershipId: string;
  partnerId: string;
  partnerName: string;
  /** Serveur du partenaire, quand il s'agit d'une communaute Discord. */
  partnerGuildId: string | null;
  type: string;
  fromStage: string;
  toStage: string;
  reason: string | null;
  timestamp: number;
}

/** Un engagement n'a pas ete tenu sur la periode ecoulee. */
export interface PartnershipCommitmentEvent {
  guildId: string;
  partnershipId: string;
  partnerName: string;
  commitmentId: string;
  kind: string;
  label: string | null;
  /** Nombre de periodes manquees d'affilee. */
  failureStreak: number;
  timestamp: number;
}

/** Une arrivee vient d'etre attribuee a un partenariat. */
export interface PartnershipReferralEvent {
  guildId: string;
  userId: string;
  partnershipId: string;
  partnerId: string;
  partnerName: string;
  timestamp: number;
}

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
  'partnership:stage': PartnershipStageEvent;
  'partnership:commitment-failed': PartnershipCommitmentEvent;
  'partnership:referral': PartnershipReferralEvent;
  'member:leave': MemberLeaveEvent;
  'member:update': MemberUpdateEvent;
  'sanction:applied': SanctionAppliedEvent;
  'sanction:revoked': SanctionRevokedEvent;
  'automod:triggered': AutoModTriggeredEvent;
  'reaction:add': ReactionAddEvent;
  'reaction:remove': ReactionRemoveEvent;
  'form:submitted': FormSubmittedEvent;
  'suggestion:created': SuggestionCreatedEvent;
  'suggestion:resolved': SuggestionResolvedEvent;
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
}

export type KotboEventName = keyof KotboEventMap;

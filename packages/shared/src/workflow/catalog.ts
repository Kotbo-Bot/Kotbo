import type { ConfigFieldDef, NodeDef, PortDataType, PortDef, TextSlot, WorkflowGraph, WorkflowNode } from './types.js';

/**
 * Catalogue des nœuds disponibles.
 *
 * Source de vérité unique : l'éditeur en déduit la palette et la forme des
 * blocs, le moteur en déduit les ports à évaluer. Ajouter un nœud ici sans
 * écrire son exécuteur côté bot le fera échouer à la validation.
 */

/**
 * Nom affiché des mini-jeux gagnables, exposé par le port « Jeu » du
 * déclencheur. Les clés sont celles de l'événement `fun:game-won`.
 */
export const FUN_GAME_LABELS: Record<string, string> = {
  guess_number: 'Nombre mystère',
  emoji_riddle: 'Rébus emoji',
};

/**
 * Libellé affiché des types de sanction, exposé par le port « Type » des
 * déclencheurs de sanction. Les clés sont celles des événements
 * `sanction:applied` et `sanction:revoked`.
 */
export const SANCTION_TYPE_LABELS: Record<string, string> = {
  WARN: 'Avertissement',
  TIMEOUT: 'Exclusion temporaire',
  KICK: 'Expulsion',
  TEMP_BAN: 'Bannissement temporaire',
  BAN: 'Bannissement',
  SOFTBAN: 'Softban',
  JAIL: 'Quarantaine (Jail)',
  UNBAN: 'Débannissement',
  UNJAIL: 'Levée de quarantaine',
  UNTIMEOUT: "Retrait d'exclusion temporaire",
};

/**
 * Libellé affiché des décisions sur une suggestion, exposé par le port
 * « Décision ». Les clés sont celles de l'événement `suggestion:resolved`.
 */
export const SUGGESTION_STATUS_LABELS: Record<string, string> = {
  APPROVED: 'Approuvée',
  REJECTED: 'Refusée',
  IMPLEMENTED: 'Implémentée',
};

const EXEC_IN: PortDef = { id: 'exec', label: '', type: 'Exec' };
const EXEC_OUT: PortDef = { id: 'next', label: '', type: 'Exec' };

// ============================================================================
// DÉCLENCHEURS - sans entrée d'exécution, ils démarrent le graphe
// ============================================================================

/** Réglage du déclencheur qui restreint les salons écoutés. */
export const TRIGGER_CHANNEL_FILTER_KEY = 'channelIds';

/**
 * Filtre de salons des déclencheurs fréquents. Appliqué par le bot avant de
 * lancer quoi que ce soit : filtrer par une condition revenait à exécuter et
 * enregistrer l'automatisation pour chaque message du serveur, puis à
 * l'arrêter à la première étape.
 */
const CHANNEL_FILTER_FIELD: ConfigFieldDef = {
  key: TRIGGER_CHANNEL_FILTER_KEY,
  label: 'Salons concernés',
  type: 'channels',
  placeholder: 'Tous les salons',
};

/** Réglage du déclencheur qui restreint les rôles écoutés. */
export const TRIGGER_ROLE_FILTER_KEY = 'roleIds';

/**
 * Filtre de rôles des déclencheurs « Rôle attribué » et « Rôle retiré ».
 * Appliqué par le bot avant de lancer quoi que ce soit, comme le filtre de
 * salons. Une condition sur le rôle ne suffit pas : elle s'évalue après le
 * comptage de la limite par membre, et un autre rôle donné en même temps
 * consommerait la limite à la place du rôle visé.
 */
const ROLE_FILTER_FIELD: ConfigFieldDef = {
  key: TRIGGER_ROLE_FILTER_KEY,
  label: 'Rôles concernés',
  type: 'roles',
  placeholder: 'Tous les rôles',
};

/** Réglages des déclencheurs de réaction qui restreignent les messages et émojis écoutés. */
export const TRIGGER_MESSAGE_FILTER_KEY = 'messages';
export const TRIGGER_EMOJI_FILTER_KEY = 'emojis';

/**
 * Filtres des déclencheurs de réaction, appliqués par le bot avant de lancer
 * quoi que ce soit, comme le filtre de salons : un rôle-réaction posé sur un
 * seul message s'exécutait sinon, et s'enregistrait, à chaque réaction du
 * serveur. Ce sont des textes libres, relus par `parseMessageFilter` et
 * `parseEmojiFilter`, pour accepter un lien copié depuis Discord ou un émoji
 * collé tel quel.
 */
const MESSAGE_FILTER_FIELD: ConfigFieldDef = {
  key: TRIGGER_MESSAGE_FILTER_KEY,
  label: 'Messages concernés',
  type: 'text',
  placeholder: 'Lien ou identifiant, tous les messages si vide',
};

const EMOJI_FILTER_FIELD: ConfigFieldDef = {
  key: TRIGGER_EMOJI_FILTER_KEY,
  label: 'Émojis concernés',
  type: 'text',
  placeholder: 'Émojis collés ou :nom:, tous les émojis si vide',
};

const REACTION_OUTPUTS: PortDef[] = [
  EXEC_OUT,
  { id: 'member', label: 'Membre', type: 'Member' },
  { id: 'emoji', label: 'Émoji', type: 'String' },
  { id: 'channel', label: 'Salon', type: 'Channel' },
  { id: 'message', label: 'Message', type: 'Message' },
  { id: 'author', label: 'Auteur du message', type: 'Member' },
];

const TRIGGERS: NodeDef[] = [
  {
    type: 'OnMemberJoin',
    label: 'Arrivée d\'un membre',
    category: 'trigger',
    description: 'Se déclenche quand un membre rejoint le serveur.',
    event: 'member:join',
    inputs: [],
    outputs: [EXEC_OUT, { id: 'member', label: 'Membre', type: 'Member' }],
  },
  {
    type: 'OnMemberLeave',
    label: 'Départ d\'un membre',
    category: 'trigger',
    description: 'Se déclenche quand un membre quitte le serveur.',
    event: 'member:leave',
    inputs: [],
    outputs: [EXEC_OUT, { id: 'member', label: 'Membre', type: 'Member' }],
  },
  {
    type: 'OnRoleAdded',
    label: 'Rôle attribué',
    category: 'trigger',
    description: 'Se déclenche quand un rôle est ajouté à un membre, une fois par rôle quand plusieurs sont donnés en même temps.',
    event: 'member:role-added',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
    config: [ROLE_FILTER_FIELD],
  },
  {
    type: 'OnRoleRemoved',
    label: 'Rôle retiré',
    category: 'trigger',
    description: 'Se déclenche quand un rôle est retiré à un membre, une fois par rôle quand plusieurs sont retirés en même temps.',
    event: 'member:role-removed',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
    config: [ROLE_FILTER_FIELD],
  },
  {
    type: 'OnMessageSend',
    label: 'Message envoyé',
    category: 'trigger',
    description: 'Se déclenche à chaque message posté par un humain.',
    event: 'message:new',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'message', label: 'Message', type: 'Message' },
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnReactionAdd',
    label: 'Réaction ajoutée',
    category: 'trigger',
    description:
      "Se déclenche quand un membre réagit à un message. Les réactions des bots sont ignorées. L'auteur du message est vide s'il n'est plus sur le serveur.",
    event: 'reaction:add',
    inputs: [],
    outputs: REACTION_OUTPUTS,
    config: [CHANNEL_FILTER_FIELD, MESSAGE_FILTER_FIELD, EMOJI_FILTER_FIELD],
  },
  {
    type: 'OnReactionRemove',
    label: 'Réaction retirée',
    category: 'trigger',
    description:
      "Se déclenche quand un membre retire sa réaction d'un message. Les réactions des bots sont ignorées, et effacer d'un coup toutes les réactions d'un message ne déclenche rien. L'auteur du message est vide s'il n'est plus sur le serveur.",
    event: 'reaction:remove',
    inputs: [],
    outputs: REACTION_OUTPUTS,
    config: [CHANNEL_FILTER_FIELD, MESSAGE_FILTER_FIELD, EMOJI_FILTER_FIELD],
  },
  {
    type: 'OnVoiceJoin',
    label: 'Arrivée en vocal',
    category: 'trigger',
    description: 'Se déclenche quand un membre rejoint un salon vocal.',
    event: 'voice:join',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnVoiceLeave',
    label: 'Départ du vocal',
    category: 'trigger',
    description: 'Se déclenche quand un membre quitte un salon vocal.',
    event: 'voice:leave',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'minutes', label: 'Durée (min)', type: 'Number' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnTicketCreated',
    label: 'Ticket créé',
    category: 'trigger',
    description:
      "Se déclenche à l'ouverture d'un ticket de support. Le salon est vide pour un ticket en MP ou relayé sur le serveur staff, et le filtre de salons écarte alors le ticket.",
    event: 'ticket:created',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'channel', label: 'Salon du ticket', type: 'Channel' },
      { id: 'subject', label: 'Sujet', type: 'String' },
      { id: 'ticketType', label: 'Type de ticket', type: 'String' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnTicketClosed',
    label: 'Ticket fermé',
    category: 'trigger',
    description:
      "Se déclenche quand un ticket est fermé, depuis Discord, le dashboard ou l'assistant IA. Supprimer un ticket sans le fermer ne compte pas. Le salon est vide pour un ticket en MP ou relayé sur le serveur staff, et le filtre de salons écarte alors le ticket. Le staff est vide si personne n'a pris le ticket en charge.",
    event: 'ticket:closed',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'closedBy', label: 'Fermé par', type: 'Member' },
      { id: 'staff', label: 'Pris en charge par', type: 'Member' },
      { id: 'channel', label: 'Salon du ticket', type: 'Channel' },
      { id: 'subject', label: 'Sujet', type: 'String' },
      { id: 'ticketType', label: 'Type de ticket', type: 'String' },
      { id: 'minutes', label: "Durée d'ouverture (min)", type: 'Number' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnTicketRated',
    label: 'Avis sur un ticket',
    category: 'trigger',
    description:
      "Se déclenche quand l'auteur d'un ticket fermé donne sa note au sondage de satisfaction, de 1 à 5. Seule la première note compte. Le commentaire facultatif arrive après et n'est pas transmis. Le salon est vide pour un ticket en MP, relayé sur le serveur staff ou déjà supprimé.",
    event: 'ticket:rated',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'staff', label: 'Pris en charge par', type: 'Member' },
      { id: 'channel', label: 'Salon du ticket', type: 'Channel' },
      { id: 'rating', label: 'Note (1 à 5)', type: 'Number' },
      { id: 'subject', label: 'Sujet', type: 'String' },
      { id: 'ticketType', label: 'Type de ticket', type: 'String' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    /**
     * Le membre n'est fourni que si Discord a garanti son identité (fenêtre
     * sur Discord, ou connexion Discord sur la page publique) : un formulaire
     * sans connexion laisse le navigateur déclarer l'identifiant qu'il veut,
     * et une automatisation qui donne un rôle le donnerait à n'importe qui.
     */
    type: 'OnFormSubmitted',
    label: 'Formulaire envoyé',
    category: 'trigger',
    description:
      "Se déclenche quand un formulaire personnalisé est envoyé, depuis Discord ou depuis sa page publique. Le membre est vide si la personne ne s'est pas connectée avec Discord ou n'est pas sur le serveur. Les réponses sont regroupées en un texte, une ligne « Question : réponse » par champ rempli.",
    event: 'form:submitted',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'formName', label: 'Formulaire', type: 'String' },
      { id: 'answers', label: 'Réponses', type: 'String' },
      { id: 'authorName', label: 'Nom indiqué', type: 'String' },
    ],
  },
  {
    type: 'OnSuggestionCreated',
    label: 'Suggestion publiée',
    category: 'trigger',
    description:
      "Se déclenche quand un membre publie une suggestion. Le message est celui que le bot poste dans le salon des suggestions ; il est vide si l'envoi a échoué.",
    event: 'suggestion:created',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'content', label: 'Suggestion', type: 'String' },
      { id: 'channel', label: 'Salon des suggestions', type: 'Channel' },
      { id: 'message', label: 'Message de la suggestion', type: 'Message' },
    ],
  },
  {
    type: 'OnSuggestionResolved',
    label: 'Suggestion traitée',
    category: 'trigger',
    description:
      "Se déclenche quand le staff approuve, refuse ou marque comme implémentée une suggestion, depuis le dashboard ou l'assistant. L'auteur est réduit à son pseudo s'il a quitté le serveur ; le staff est vide pour une réponse de l'assistant.",
    event: 'suggestion:resolved',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'staff', label: 'Traitée par', type: 'Member' },
      { id: 'content', label: 'Suggestion', type: 'String' },
      { id: 'response', label: 'Réponse du staff', type: 'String' },
      { id: 'statusLabel', label: 'Décision', type: 'String' },
      { id: 'upvotes', label: 'Votes pour', type: 'Number' },
      { id: 'downvotes', label: 'Votes contre', type: 'Number' },
      { id: 'isApproved', label: 'Approuvée', type: 'Boolean' },
      { id: 'isRejected', label: 'Refusée', type: 'Boolean' },
      { id: 'isImplemented', label: 'Implémentée', type: 'Boolean' },
    ],
  },
  {
    /**
     * Les booléens servent aux conditions « la sanction est … », comme pour les
     * mini-jeux. Le port `type` garde le code brut (`BAN`, `TEMP_BAN`…) : des
     * workflows enregistrés le comparent déjà à ces valeurs, et le traduire
     * les ferait échouer sans bruit. `isBan` couvre aussi le bannissement
     * temporaire, que la durée distingue.
     */
    type: 'OnSanctionApplied',
    label: 'Sanction appliquée',
    category: 'trigger',
    description:
      "Se déclenche quand une sanction est prononcée. Un membre expulsé ou banni a déjà quitté le serveur : seul son pseudo reste utilisable, les actions qui le visent sur le serveur échouent et un message privé est ignoré. Le modérateur est vide s'il n'est plus sur le serveur ; la durée vaut 0 pour une sanction sans échéance.",
    event: 'sanction:applied',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Sanctionné', type: 'Member' },
      { id: 'moderator', label: 'Modérateur', type: 'Member' },
      { id: 'typeLabel', label: 'Type', type: 'String' },
      { id: 'reason', label: 'Motif', type: 'String' },
      { id: 'minutes', label: 'Durée (min)', type: 'Number' },
      { id: 'isWarn', label: 'Avertissement', type: 'Boolean' },
      { id: 'isTimeout', label: 'Exclusion temporaire', type: 'Boolean' },
      { id: 'isKick', label: 'Expulsion', type: 'Boolean' },
      { id: 'isBan', label: 'Bannissement', type: 'Boolean' },
      { id: 'isSoftban', label: 'Softban', type: 'Boolean' },
      { id: 'type', label: 'Code du type', type: 'String' },
    ],
  },
  {
    /**
     * Seul déclencheur qui ne vient pas du bus : un balayage passe chaque
     * minute et lance les workflows planifiés dont le motif tombe. Le nom
     * d'événement ci-dessous ne sert donc qu'à indexer la table, il n'est
     * jamais publié - s'y abonner ne recevrait rien.
     */
    type: 'OnSchedule',
    label: 'Planification',
    category: 'trigger',
    description: 'Se déclenche à heure fixe, selon une planification récurrente.',
    event: 'schedule:fired',
    inputs: [],
    outputs: [EXEC_OUT],
    config: [
      { key: 'cron', label: 'Planification', type: 'text', defaultValue: '0 9 * * *', placeholder: '0 9 * * *' },
    ],
  },
  {
    type: 'OnPartnershipStage',
    label: "Partenariat : changement d'étape",
    category: 'trigger',
    description:
      "Se déclenche quand un dossier de partenariat change d'étape. L'événement part après l'application des avantages : le rôle partenaire est déjà posé.",
    event: 'partnership:stage',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'partnerName', label: 'Partenaire', type: 'String' },
      { id: 'stage', label: 'Nouvelle étape', type: 'String' },
      { id: 'previousStage', label: 'Étape précédente', type: 'String' },
      { id: 'partnershipType', label: 'Type', type: 'String' },
      { id: 'reason', label: 'Motif', type: 'String' },
    ],
  },
  {
    type: 'OnPartnershipCommitmentFailed',
    label: 'Partenariat : engagement non tenu',
    category: 'trigger',
    description:
      "Se déclenche au constat d'un manquement. « Périodes manquées » permet de ne réagir qu'à partir de la deuxième ou de la troisième fois.",
    event: 'partnership:commitment-failed',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'partnerName', label: 'Partenaire', type: 'String' },
      { id: 'commitment', label: 'Engagement', type: 'String' },
      { id: 'failureStreak', label: 'Périodes manquées', type: 'Number' },
    ],
  },
  {
    type: 'OnPartnershipReferral',
    label: 'Partenariat : arrivée attribuée',
    category: 'trigger',
    description:
      "Se déclenche quand un membre arrive par l'invitation d'un partenariat. Ne part que pour les arrivées réellement attribuées, pas pour toutes les arrivées.",
    event: 'partnership:referral',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'partnerName', label: 'Partenaire', type: 'String' },
    ],
  },
  {
    type: 'OnGiveawayEntry',
    label: 'Participation à un concours',
    category: 'trigger',
    description: 'Se déclenche quand un membre rejoint un giveaway.',
    event: 'giveaway:entry',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'prize', label: 'Lot', type: 'String' },
      { id: 'participants', label: 'Participants', type: 'Number' },
    ],
  },
  {
    type: 'OnGiveawayWinner',
    label: 'Gagnant d\'un concours',
    category: 'trigger',
    description: 'Se déclenche pour chaque gagnant, une fois son lot acquis. Un tirage en attente de validation ne déclenche rien tant que le staff n\'a pas validé.',
    event: 'giveaway:winner',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'prize', label: 'Lot', type: 'String' },
    ],
  },
  {
    type: 'OnGiveawayEnded',
    label: 'Fin d\'un concours',
    category: 'trigger',
    description: 'Se déclenche à la clôture d\'un giveaway, qu\'il ait fait des gagnants ou non.',
    event: 'giveaway:ended',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'prize', label: 'Lot', type: 'String' },
      { id: 'participants', label: 'Participants', type: 'Number' },
      { id: 'winners', label: 'Gagnants', type: 'Number' },
    ],
  },
  {
    /**
     * Les deux booléens servent aux conditions « le jeu est … » : comparer le
     * port texte à un libellé fixe ne se relirait pas, la décompilation prenant
     * toute valeur saisie pour celle de l'utilisateur.
     */
    type: 'OnFunGameWon',
    label: 'Victoire à un mini-jeu',
    category: 'trigger',
    description:
      "Se déclenche quand un membre trouve le nombre mystère ou résout un rébus emoji. Ne part que si le module Salons fun est actif et le salon du jeu configuré ; une remise à zéro depuis le dashboard ne compte pas comme une victoire.",
    event: 'fun:game-won',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Gagnant', type: 'Member' },
      { id: 'channel', label: 'Salon du jeu', type: 'Channel' },
      { id: 'message', label: 'Message gagnant', type: 'Message' },
      { id: 'game', label: 'Jeu', type: 'String' },
      { id: 'answer', label: 'Réponse trouvée', type: 'String' },
      { id: 'isGuessNumber', label: 'Nombre mystère', type: 'Boolean' },
      { id: 'isEmojiRiddle', label: 'Rébus emoji', type: 'Boolean' },
    ],
  },
  {
    type: 'OnLevelUp',
    label: 'Passage de niveau',
    category: 'trigger',
    description: 'Se déclenche quand un membre gagne un niveau.',
    event: 'level:up',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'level', label: 'Niveau', type: 'Number' },
    ],
  },
  {
    /**
     * Le port `member` porte le premier vainqueur, pas le camp entier : les
     * actions du catalogue s'adressent à un membre, et un port `List` ne
     * saurait pas les alimenter. Le décompte reste disponible à côté pour les
     * paris à plusieurs.
     */
    type: 'OnBetResolved',
    label: 'Pari tranché',
    category: 'trigger',
    description: 'Se déclenche quand un arbitre désigne le camp gagnant d\'un pari en points de clan.',
    event: 'bet:resolved',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Vainqueur', type: 'Member' },
      { id: 'subject', label: 'Sujet', type: 'String' },
      { id: 'side', label: 'Camp gagnant', type: 'String' },
      { id: 'netGain', label: 'Gain net', type: 'Number' },
      { id: 'pot', label: 'Pot', type: 'Number' },
      { id: 'winnerCount', label: 'Nombre de vainqueurs', type: 'Number' },
    ],
  },
  {
    type: 'OnBetRefunded',
    label: 'Pari annulé',
    category: 'trigger',
    description: 'Se déclenche quand un pari se clôt sans vainqueur et que les mises sont rendues.',
    event: 'bet:refunded',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'subject', label: 'Sujet', type: 'String' },
      { id: 'reason', label: 'Motif', type: 'String' },
      { id: 'refunded', label: 'Points rendus', type: 'Number' },
    ],
  },
  {
    type: 'OnClanDebtOpened',
    label: 'Dette de clan creusée',
    category: 'trigger',
    description: 'Se déclenche quand un membre mise des points de clan qu\'il ne possède pas.',
    event: 'clan:debt-opened',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'amount', label: 'Montant emprunté', type: 'Number' },
      { id: 'total', label: 'Dette totale', type: 'Number' },
    ],
  },
  {
    type: 'OnClanDebtCleared',
    label: 'Dette de clan soldée',
    category: 'trigger',
    description: 'Se déclenche quand un membre finit de rembourser sa dette de points de clan.',
    event: 'clan:debt-cleared',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'repaid', label: 'Dernier remboursement', type: 'Number' },
    ],
  },
  {
    type: 'OnMessageDelete',
    label: 'Message supprimé',
    category: 'trigger',
    description:
      "Se déclenche quand un message d'un membre est supprimé. Ne part pas pour les messages de bots, ni pour un message trop ancien dont le bot ne connaît plus l'auteur ; une suppression en masse ne compte pas.",
    event: 'message:delete',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'content', label: 'Contenu', type: 'String' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnAutoModTriggered',
    label: 'AutoMod déclenché',
    category: 'trigger',
    description: 'Se déclenche quand l\'AutoMod de Kotbo sanctionne un message (spam, invitation, majuscules, émojis, mentions, everyone).',
    event: 'automod:triggered',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'rule', label: 'Règle', type: 'String' },
      { id: 'action', label: 'Action', type: 'String' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnSanctionRevoked',
    label: 'Sanction levée',
    category: 'trigger',
    description:
      "Se déclenche quand un membre est débanni ou que son exclusion temporaire est retirée avant son terme, quelle qu'en soit l'origine. La fin naturelle d'une exclusion n'est pas signalée par Discord, et un débannissement moins d'une minute après le bannissement est pris pour un softban et ignoré.",
    event: 'sanction:revoked',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'typeLabel', label: 'Type', type: 'String' },
      { id: 'isUnban', label: 'Débannissement', type: 'Boolean' },
      { id: 'isUntimeout', label: "Retrait d'exclusion", type: 'Boolean' },
      { id: 'type', label: 'Code du type', type: 'String' },
    ],
  },
  {
    type: 'OnChannelCreated',
    label: 'Salon créé',
    category: 'trigger',
    description: 'Se déclenche à la création d\'un salon ou d\'une catégorie, y compris par le bot. Les fils n\'en font pas partie.',
    event: 'channel:create',
    inputs: [],
    outputs: [EXEC_OUT, { id: 'channel', label: 'Salon', type: 'Channel' }],
  },
  {
    type: 'OnChannelDeleted',
    label: 'Salon supprimé',
    category: 'trigger',
    description: 'Se déclenche à la suppression d\'un salon ou d\'une catégorie. Le salon n\'existe plus : seul son nom reste utilisable.',
    event: 'channel:delete',
    inputs: [],
    outputs: [EXEC_OUT, { id: 'channel', label: 'Salon', type: 'Channel' }],
  },
  {
    type: 'OnRoleCreated',
    label: 'Rôle créé',
    category: 'trigger',
    description: 'Se déclenche à la création d\'un rôle, y compris par une intégration ou le bot.',
    event: 'role:create',
    inputs: [],
    outputs: [EXEC_OUT, { id: 'role', label: 'Rôle', type: 'Role' }],
  },
  {
    type: 'OnRoleDeleted',
    label: 'Rôle supprimé',
    category: 'trigger',
    description: 'Se déclenche à la suppression d\'un rôle. Le rôle n\'existe plus : seul son nom reste utilisable.',
    event: 'role:delete',
    inputs: [],
    outputs: [EXEC_OUT, { id: 'role', label: 'Rôle', type: 'Role' }],
  },
  {
    type: 'OnMemberInvited',
    label: 'Arrivée par invitation',
    category: 'trigger',
    description:
      "Se déclenche quand un membre arrive par une invitation que le bot a pu identifier. Demande le module Logs actif, qui repère l'invitation utilisée, et la permission Gérer le serveur. Une arrivée par l'URL personnalisée ou dont l'invitation n'a pas pu être déterminée ne part pas. L'auteur de l'invitation est vide s'il n'est plus sur le serveur.",
    event: 'member:join:invite',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'inviter', label: "Auteur de l'invitation", type: 'Member' },
      { id: 'inviteCode', label: "Code d'invitation", type: 'String' },
    ],
  },
  {
    type: 'OnMessageEdit',
    label: 'Message modifié',
    category: 'trigger',
    description:
      "Se déclenche quand un membre modifie le texte d'un de ses messages. L'ajout d'un aperçu de lien ou l'épinglage ne comptent pas. L'ancien texte est vide pour un message trop ancien que le bot n'a plus en mémoire.",
    event: 'message:update',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'message', label: 'Message', type: 'Message' },
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'oldContent', label: 'Ancien texte', type: 'String' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnVoiceMove',
    label: 'Changement de salon vocal',
    category: 'trigger',
    description:
      "Se déclenche quand un membre passe d'un salon vocal à un autre sans quitter le vocal. Le filtre de salons porte sur le salon d'arrivée.",
    event: 'voice:move',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'channel', label: "Salon d'arrivée", type: 'Channel' },
      { id: 'fromChannel', label: 'Salon quitté', type: 'Channel' },
      { id: 'minutes', label: 'Durée dans le salon quitté (min)', type: 'Number' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnThreadCreated',
    label: 'Fil créé',
    category: 'trigger',
    description:
      "Se déclenche quand un membre crée un fil ou un post de forum. Les fils créés par un bot ne comptent pas. Le filtre de salons porte sur le salon ou le forum parent.",
    event: 'thread:create',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'thread', label: 'Fil', type: 'Channel' },
      { id: 'member', label: 'Créateur', type: 'Member' },
      { id: 'channel', label: 'Salon parent', type: 'Channel' },
    ],
    config: [CHANNEL_FILTER_FIELD],
  },
  {
    type: 'OnNicknameChanged',
    label: 'Surnom modifié',
    category: 'trigger',
    description:
      "Se déclenche quand le surnom d'un membre sur le serveur change, qu'il le fasse lui-même ou non. Un texte vide signifie pas de surnom. Un changement de nom global Discord ne compte pas.",
    event: 'member:nickname',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'oldNickname', label: 'Ancien surnom', type: 'String' },
      { id: 'newNickname', label: 'Nouveau surnom', type: 'String' },
    ],
  },
  {
    type: 'OnMemberBoost',
    label: 'Boost du serveur',
    category: 'trigger',
    description:
      "Se déclenche quand un membre commence à booster le serveur. Un boost supplémentaire d'un membre qui boostait déjà n'est pas signalé par Discord. Le nombre de boosts est celui que le bot connaît à cet instant et peut ne pas encore compter ce boost.",
    event: 'member:boost',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'boostCount', label: 'Boosts du serveur', type: 'Number' },
    ],
  },
];

// ============================================================================
// CONTRÔLE DE FLUX
// ============================================================================

const FLOW: NodeDef[] = [
  {
    type: 'If',
    label: 'Si',
    category: 'flow',
    description: 'Oriente l\'exécution selon une condition booléenne.',
    inputs: [EXEC_IN, { id: 'condition', label: 'Condition', type: 'Boolean' }],
    outputs: [
      { id: 'true', label: 'Vrai', type: 'Exec' },
      { id: 'false', label: 'Faux', type: 'Exec' },
    ],
  },
  {
    type: 'Switch',
    label: 'Aiguillage',
    category: 'flow',
    description: 'Compare une valeur texte à une liste de cas et suit la sortie correspondante.',
    inputs: [EXEC_IN, { id: 'value', label: 'Valeur', type: 'String' }],
    // Les sorties par cas sont générées à partir de la configuration ;
    // « Sinon » est toujours présent.
    outputs: [{ id: 'default', label: 'Sinon', type: 'Exec' }],
    config: [
      { key: 'cases', label: 'Cas', type: 'cases', defaultValue: [] },
    ],
  },
  {
    type: 'ForEach',
    label: 'Pour chaque',
    category: 'flow',
    description: 'Parcourt une liste et exécute le corps de boucle pour chaque élément.',
    inputs: [EXEC_IN, { id: 'list', label: 'Liste', type: 'List' }],
    outputs: [
      { id: 'body', label: 'Corps', type: 'Exec' },
      { id: 'done', label: 'Terminé', type: 'Exec' },
      { id: 'item', label: 'Élément', type: 'String' },
      { id: 'index', label: 'Index', type: 'Number' },
    ],
  },
  {
    type: 'Delay',
    label: 'Attendre',
    category: 'flow',
    description: 'Suspend l\'exécution ; elle reprend même après un redémarrage du bot.',
    inputs: [EXEC_IN, { id: 'seconds', label: 'Secondes', type: 'Number', optional: true }],
    outputs: [EXEC_OUT],
    config: [
      { key: 'seconds', label: 'Secondes', type: 'number', defaultValue: 60, min: 1, max: 2_592_000 },
    ],
  },
];

// ============================================================================
// ACTIONS
// ============================================================================

const ACTIONS: NodeDef[] = [
  {
    type: 'SendMessage',
    label: 'Envoyer un message',
    category: 'action',
    description: 'Poste un message texte dans un salon.',
    inputs: [
      EXEC_IN,
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'text', label: 'Texte', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'SendEmbed',
    label: 'Envoyer un embed',
    category: 'action',
    description: 'Poste un message enrichi dans un salon.',
    inputs: [
      EXEC_IN,
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'title', label: 'Titre', type: 'String' },
      { id: 'description', label: 'Description', type: 'String' },
    ],
    outputs: [EXEC_OUT],
    config: [
      { key: 'color', label: 'Couleur', type: 'text', placeholder: '#5865F2', defaultValue: '#5865F2' },
    ],
  },
  {
    type: 'SendDM',
    label: 'Envoyer un message privé',
    category: 'action',
    description: 'Envoie un message privé à un membre. Sans effet si ses MP sont fermés.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'text', label: 'Texte', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'AddRole',
    label: 'Ajouter un rôle',
    category: 'action',
    description: 'Attribue un rôle à un membre.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'RemoveRole',
    label: 'Retirer un rôle',
    category: 'action',
    description: 'Retire un rôle à un membre.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'SetNickname',
    label: 'Changer le surnom',
    category: 'action',
    description: 'Modifie le surnom d\'un membre sur le serveur.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'nickname', label: 'Surnom', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'TimeoutMember',
    label: 'Exclure temporairement',
    category: 'action',
    description: 'Applique une exclusion temporaire à un membre.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'minutes', label: 'Minutes', type: 'Number' },
      { id: 'reason', label: 'Motif', type: 'String', optional: true },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'KickMember',
    label: 'Expulser',
    category: 'action',
    description: 'Expulse un membre du serveur.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'reason', label: 'Motif', type: 'String', optional: true },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'DeleteMessage',
    label: 'Supprimer un message',
    category: 'action',
    description: 'Supprime un message existant.',
    inputs: [
      EXEC_IN,
      { id: 'message', label: 'Message', type: 'Message' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'AddReaction',
    label: 'Réagir à un message',
    category: 'action',
    description: 'Ajoute une réaction à un message.',
    inputs: [
      EXEC_IN,
      { id: 'message', label: 'Message', type: 'Message' },
      { id: 'emoji', label: 'Émoji', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'PinMessage',
    label: 'Épingler un message',
    category: 'action',
    description: 'Épingle un message dans son salon.',
    inputs: [
      EXEC_IN,
      { id: 'message', label: 'Message', type: 'Message' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'CreateThread',
    label: 'Ouvrir un fil',
    category: 'action',
    description: 'Ouvre un fil de discussion dans un salon.',
    inputs: [
      EXEC_IN,
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'name', label: 'Nom du fil', type: 'String' },
    ],
    outputs: [EXEC_OUT, { id: 'thread', label: 'Fil créé', type: 'Channel' }],
  },
  {
    type: 'BanMember',
    label: 'Bannir',
    category: 'action',
    description: 'Bannit un membre du serveur, définitivement ou pour une durée donnée.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'days', label: 'Jours', type: 'Number', optional: true },
      { id: 'reason', label: 'Motif', type: 'String', optional: true },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'CreateTicket',
    label: 'Ouvrir un ticket',
    category: 'action',
    description: 'Ouvre un ticket de support au nom d\'un membre.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'subject', label: 'Sujet', type: 'String' },
    ],
    outputs: [EXEC_OUT, { id: 'channel', label: 'Salon créé', type: 'Channel' }],
  },
  {
    type: 'ReplyToMessage',
    label: 'Répondre à un message',
    category: 'action',
    description: 'Répond à un message dans son salon. Si le message a été supprimé entre-temps, la réponse est postée sans citation.',
    inputs: [
      EXEC_IN,
      { id: 'message', label: 'Message', type: 'Message' },
      { id: 'text', label: 'Texte', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'AddTemporaryRole',
    label: 'Donner un rôle temporaire',
    category: 'action',
    description: 'Attribue un rôle et le retire à l\'échéance. Un membre qui avait déjà le rôle le garde : seul un rôle donné par cette action est retiré.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
      { id: 'minutes', label: 'Durée (minutes)', type: 'Number' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'GiveCoins',
    label: 'Donner des pièces',
    category: 'action',
    description: 'Crédite des pièces sur le solde d\'un membre. Échoue si le module Économie est désactivé.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'amount', label: 'Montant', type: 'Number' },
    ],
    outputs: [EXEC_OUT, { id: 'balance', label: 'Nouveau solde', type: 'Number' }],
  },
  {
    type: 'RemoveCoins',
    label: 'Retirer des pièces',
    category: 'action',
    description: 'Retire des pièces du solde d\'un membre, sans descendre sous zéro. Échoue si le module Économie est désactivé.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'amount', label: 'Montant', type: 'Number' },
    ],
    outputs: [EXEC_OUT, { id: 'balance', label: 'Nouveau solde', type: 'Number' }],
  },
  {
    type: 'GiveXp',
    label: 'Donner de l\'XP',
    category: 'action',
    description: 'Crédite de l\'XP de niveau à un membre, avec passage de niveau et rôles de récompense. Échoue si le module Leveling est désactivé.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'amount', label: 'XP', type: 'Number' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'AddMemberNote',
    label: 'Ajouter une note au membre',
    category: 'action',
    description: 'Ajoute une ligne datée à la note de modération du membre. Au-delà de 1000 caractères, les plus anciennes lignes automatiques sont retirées ; le texte du staff n\'est jamais effacé, et l\'action échoue si lui seul remplit la note.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'text', label: 'Note', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'SendLogMessage',
    label: 'Écrire dans les logs',
    category: 'action',
    description: 'Poste un message dans le salon de logs du serveur. Échoue si aucun salon de logs n\'est configuré.',
    inputs: [
      EXEC_IN,
      { id: 'text', label: 'Texte', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
];

// ============================================================================
// DONNÉES - constantes, sélecteurs et accesseurs
// ============================================================================

const DATA: NodeDef[] = [
  {
    type: 'ConstText',
    label: 'Texte',
    category: 'data',
    description: 'Une valeur texte fixe.',
    inputs: [],
    outputs: [{ id: 'value', label: 'Valeur', type: 'String' }],
    config: [{ key: 'value', label: 'Texte', type: 'textarea', defaultValue: '' }],
  },
  {
    type: 'ConstNumber',
    label: 'Nombre',
    category: 'data',
    description: 'Une valeur numérique fixe.',
    inputs: [],
    outputs: [{ id: 'value', label: 'Valeur', type: 'Number' }],
    config: [{ key: 'value', label: 'Nombre', type: 'number', defaultValue: 0 }],
  },
  {
    type: 'ConstBoolean',
    label: 'Booléen',
    category: 'data',
    description: 'Vrai ou faux.',
    inputs: [],
    outputs: [{ id: 'value', label: 'Valeur', type: 'Boolean' }],
    config: [{ key: 'value', label: 'Vrai ?', type: 'boolean', defaultValue: false }],
  },
  {
    type: 'FormatText',
    label: 'Texte composé',
    category: 'data',
    description: 'Un texte dans lequel des valeurs du contexte viennent s\'insérer.',
    // Les entrées sont dérivées des emplacements déclarés en configuration :
    // un texte « Bienvenue {slot0} » n'a qu'une entrée, deux jetons en créent
    // deux. Passer par `resolveNodeInputs` est donc obligatoire pour ce nœud.
    inputs: [],
    outputs: [{ id: 'value', label: 'Valeur', type: 'String' }],
    config: [
      { key: 'template', label: 'Texte', type: 'textarea', defaultValue: '' },
      { key: 'slots', label: 'Emplacements', type: 'slots', defaultValue: [] },
    ],
  },
  {
    type: 'SelectRole',
    label: 'Un rôle',
    category: 'data',
    description: 'Un rôle choisi parmi ceux du serveur.',
    inputs: [],
    outputs: [{ id: 'role', label: 'Rôle', type: 'Role' }],
    config: [{ key: 'roleId', label: 'Rôle', type: 'role' }],
  },
  {
    type: 'SelectChannel',
    label: 'Un salon',
    category: 'data',
    description: 'Un salon choisi parmi ceux du serveur.',
    inputs: [],
    outputs: [{ id: 'channel', label: 'Salon', type: 'Channel' }],
    config: [{ key: 'channelId', label: 'Salon', type: 'channel' }],
  },
  {
    type: 'MemberInfo',
    label: 'Infos du membre',
    category: 'data',
    description: 'Expose les propriétés d\'un membre.',
    inputs: [{ id: 'member', label: 'Membre', type: 'Member' }],
    outputs: [
      { id: 'displayName', label: 'Pseudo', type: 'String' },
      { id: 'tag', label: 'Tag', type: 'String' },
      { id: 'id', label: 'Identifiant', type: 'String' },
      { id: 'accountAgeDays', label: 'Âge du compte (j)', type: 'Number' },
      { id: 'joinedDaysAgo', label: 'Arrivé il y a (j)', type: 'Number' },
      { id: 'isBot', label: 'Est un bot', type: 'Boolean' },
      { id: 'roles', label: 'Rôles', type: 'List', itemType: 'Role' },
    ],
  },
  {
    type: 'MessageInfo',
    label: 'Infos du message',
    category: 'data',
    description: 'Expose les propriétés d\'un message.',
    inputs: [{ id: 'message', label: 'Message', type: 'Message' }],
    outputs: [
      { id: 'content', label: 'Contenu', type: 'String' },
      { id: 'author', label: 'Auteur', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'length', label: 'Longueur', type: 'Number' },
    ],
  },
  {
    type: 'ChannelInfo',
    label: 'Infos du salon',
    category: 'data',
    description: 'Expose les propriétés d\'un salon.',
    inputs: [{ id: 'channel', label: 'Salon', type: 'Channel' }],
    outputs: [
      { id: 'name', label: 'Nom', type: 'String' },
      { id: 'id', label: 'Identifiant', type: 'String' },
      { id: 'categoryName', label: 'Catégorie', type: 'String' },
    ],
  },
  {
    /**
     * Valeurs calculées au déclenchement et transportées avec l'exécution : une
     * reprise après « Attendre » relit les mêmes, sans recompter.
     */
    type: 'RunInfo',
    label: 'Fréquence du membre',
    category: 'data',
    description: 'Nombre de déclenchements de cette automatisation pour le membre du déclencheur, celui en cours compris. Vaut 0 sans membre.',
    inputs: [],
    outputs: [
      { id: 'memberToday', label: 'Déclenchements aujourd\'hui', type: 'Number' },
      { id: 'memberThisHour', label: 'Déclenchements cette heure-ci', type: 'Number' },
    ],
  },
  {
    type: 'GuildInfo',
    label: 'Infos du serveur',
    category: 'data',
    description: 'Expose les propriétés du serveur.',
    inputs: [],
    outputs: [
      { id: 'name', label: 'Nom', type: 'String' },
      { id: 'memberCount', label: 'Nombre de membres', type: 'Number' },
    ],
  },
];

// ============================================================================
// LOGIQUE - opérateurs et conditions
// ============================================================================

const LOGIC: NodeDef[] = [
  {
    type: 'HasRole',
    label: 'Possède le rôle',
    category: 'logic',
    description: 'Vrai si le membre possède le rôle indiqué.',
    inputs: [
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
  },
  {
    type: 'ChannelEquals',
    label: 'Salon est',
    category: 'logic',
    description: 'Vrai si les deux salons sont le même.',
    inputs: [
      { id: 'a', label: 'Salon', type: 'Channel' },
      { id: 'b', label: 'Comparé à', type: 'Channel' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
  },
  {
    type: 'TextContains',
    label: 'Texte contient',
    category: 'logic',
    description: 'Vrai si le texte contient le fragment recherché.',
    inputs: [
      { id: 'text', label: 'Texte', type: 'String' },
      { id: 'search', label: 'Recherche', type: 'String' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
    config: [{ key: 'caseSensitive', label: 'Sensible à la casse', type: 'boolean', defaultValue: false }],
  },
  {
    type: 'TextEquals',
    label: 'Texte est égal à',
    category: 'logic',
    description: 'Vrai si les deux textes sont identiques.',
    inputs: [
      { id: 'a', label: 'Texte', type: 'String' },
      { id: 'b', label: 'Comparé à', type: 'String' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
    config: [{ key: 'caseSensitive', label: 'Sensible à la casse', type: 'boolean', defaultValue: false }],
  },
  {
    type: 'Compare',
    label: 'Comparer',
    category: 'logic',
    description: 'Compare deux nombres.',
    inputs: [
      { id: 'a', label: 'A', type: 'Number' },
      { id: 'b', label: 'B', type: 'Number' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
    config: [{
      key: 'operator',
      label: 'Opérateur',
      type: 'select',
      defaultValue: 'gt',
      options: [
        { value: 'gt', label: 'A > B' },
        { value: 'gte', label: 'A ≥ B' },
        { value: 'lt', label: 'A < B' },
        { value: 'lte', label: 'A ≤ B' },
        { value: 'eq', label: 'A = B' },
        { value: 'neq', label: 'A ≠ B' },
      ],
    }],
  },
  {
    type: 'Logic',
    label: 'ET / OU',
    category: 'logic',
    description: 'Combine deux booléens.',
    inputs: [
      { id: 'a', label: 'A', type: 'Boolean' },
      { id: 'b', label: 'B', type: 'Boolean' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
    config: [{
      key: 'operator',
      label: 'Opérateur',
      type: 'select',
      defaultValue: 'and',
      options: [{ value: 'and', label: 'ET' }, { value: 'or', label: 'OU' }],
    }],
  },
  {
    type: 'Not',
    label: 'NON',
    category: 'logic',
    description: 'Inverse un booléen.',
    inputs: [{ id: 'value', label: 'Valeur', type: 'Boolean' }],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
  },
  {
    type: 'Concat',
    label: 'Concaténer',
    category: 'logic',
    description: 'Assemble deux textes.',
    inputs: [
      { id: 'a', label: 'A', type: 'String' },
      { id: 'b', label: 'B', type: 'String' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'String' }],
    config: [{ key: 'separator', label: 'Séparateur', type: 'text', defaultValue: '' }],
  },
  {
    type: 'TextLength',
    label: 'Longueur du texte',
    category: 'logic',
    description: 'Nombre de caractères d\'un texte.',
    inputs: [{ id: 'text', label: 'Texte', type: 'String' }],
    outputs: [{ id: 'result', label: 'Longueur', type: 'Number' }],
  },
  {
    type: 'Math',
    label: 'Calcul',
    category: 'logic',
    description: 'Opération arithmétique entre deux nombres.',
    inputs: [
      { id: 'a', label: 'A', type: 'Number' },
      { id: 'b', label: 'B', type: 'Number' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Number' }],
    config: [{
      key: 'operator',
      label: 'Opération',
      type: 'select',
      defaultValue: 'add',
      options: [
        { value: 'add', label: 'A + B' },
        { value: 'sub', label: 'A − B' },
        { value: 'mul', label: 'A × B' },
        { value: 'div', label: 'A ÷ B' },
      ],
    }],
  },
  {
    type: 'ListLength',
    label: 'Taille de la liste',
    category: 'logic',
    description: 'Nombre d\'éléments d\'une liste.',
    inputs: [{ id: 'list', label: 'Liste', type: 'List' }],
    outputs: [{ id: 'result', label: 'Taille', type: 'Number' }],
  },
];

// ============================================================================
// REGISTRE
// ============================================================================

/**
 * Salons retenus par le filtre du déclencheur d'un graphe. Vide quand le
 * déclencheur n'en propose pas : une valeur restée dans la configuration après
 * un changement de déclencheur ne filtre rien.
 */
export function readTriggerChannelFilter(graph: WorkflowGraph): string[] {
  const trigger = graph.nodes.find((node) => getNodeDef(node.type)?.category === 'trigger');
  if (!trigger) return [];
  if (!getNodeDef(trigger.type)?.config?.some((field) => field.key === TRIGGER_CHANNEL_FILTER_KEY)) return [];

  const raw = trigger.config?.[TRIGGER_CHANNEL_FILTER_KEY];
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}

/**
 * Rôles retenus par le filtre du déclencheur d'un graphe, avec les mêmes
 * garde-fous que le filtre de salons.
 */
export function readTriggerRoleFilter(graph: WorkflowGraph): string[] {
  const trigger = graph.nodes.find((node) => getNodeDef(node.type)?.category === 'trigger');
  if (!trigger) return [];
  if (!getNodeDef(trigger.type)?.config?.some((field) => field.key === TRIGGER_ROLE_FILTER_KEY)) return [];

  const raw = trigger.config?.[TRIGGER_ROLE_FILTER_KEY];
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}

/** Texte d'un filtre du déclencheur, vide quand le déclencheur ne le propose pas. */
function readTriggerTextFilter(graph: WorkflowGraph, key: string): string {
  const trigger = graph.nodes.find((node) => getNodeDef(node.type)?.category === 'trigger');
  if (!trigger) return '';
  if (!getNodeDef(trigger.type)?.config?.some((field) => field.key === key)) return '';

  const raw = trigger.config?.[key];
  return typeof raw === 'string' ? raw : '';
}

const SNOWFLAKE = /\d{17,20}/g;

/**
 * Identifiants de messages d'un filtre saisi à la main. Un lien de message
 * contient aussi le serveur et le salon : seul le dernier identifiant de
 * chaque lien est le message.
 */
export function parseMessageFilter(text: string): string[] {
  const ids = text
    .split(/[\s,;]+/)
    .map((token) => token.match(SNOWFLAKE)?.at(-1))
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

/**
 * Forme comparable d'un émoji. Discord ne transmet que le nom d'un émoji
 * personnalisé, alors que l'admin colle souvent `<:kekw:123>` ou tape
 * `:kekw:`. Le sélecteur de variante (U+FE0F) est retiré des deux côtés :
 * un cœur collé depuis un clavier le porte souvent, celui renvoyé par
 * Discord non, et ils ne se différencient que par lui.
 */
export function normalizeEmoji(raw: string): string {
  const trimmed = raw.trim();
  const custom = trimmed.match(/^<a?:(\w+):\d+>$/) ?? trimmed.match(/^:(\w+):$/);
  return (custom ? custom[1] : trimmed).replace(/\uFE0F/g, '');
}

/**
 * Émojis d'un filtre saisi à la main. Des émojis Unicode collés sans espace
 * sont découpés en caractères visibles ; un nom sans deux-points
 * désigne un émoji personnalisé.
 */
export function parseEmojiFilter(text: string): string[] {
  const spaced = text.replace(/<a?:\w+:\d+>/g, (custom) => ` ${custom} `);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const emojis: string[] = [];

  for (const token of spaced.split(/[\s,;]+/)) {
    if (!token) continue;
    if (/^<a?:\w+:\d+>$/.test(token) || /^:?\w+:?$/.test(token)) {
      emojis.push(normalizeEmoji(token.replace(/^:?(\w+):?$/, ':$1:')));
      continue;
    }
    for (const { segment } of segmenter.segment(token)) emojis.push(normalizeEmoji(segment));
  }

  return [...new Set(emojis.filter(Boolean))];
}

export function readTriggerMessageFilter(graph: WorkflowGraph): string[] {
  return parseMessageFilter(readTriggerTextFilter(graph, TRIGGER_MESSAGE_FILTER_KEY));
}

export function readTriggerEmojiFilter(graph: WorkflowGraph): string[] {
  return parseEmojiFilter(readTriggerTextFilter(graph, TRIGGER_EMOJI_FILTER_KEY));
}

export const NODE_CATALOG: NodeDef[] = [...TRIGGERS, ...FLOW, ...ACTIONS, ...DATA, ...LOGIC];

const BY_TYPE = new Map(NODE_CATALOG.map((def) => [def.type, def]));

export function getNodeDef(type: string): NodeDef | undefined {
  return BY_TYPE.get(type);
}

export function isTriggerNode(type: string): boolean {
  return getNodeDef(type)?.category === 'trigger';
}

/** Types d'événements du bus effectivement utilisés par au moins un déclencheur. */
export function triggerEventNames(): string[] {
  return [...new Set(TRIGGERS.map((def) => def.event).filter((e): e is string => Boolean(e)))];
}

/**
 * Sorties d'exécution d'un nœud, configuration comprise.
 *
 * Le nœud Switch fait exception : ses sorties dépendent des cas saisis par
 * l'utilisateur, elles ne peuvent donc pas être déclarées statiquement.
 */
export function resolveExecOutputs(type: string, config?: Record<string, unknown>): PortDef[] {
  const def = getNodeDef(type);
  if (!def) return [];

  if (type === 'Switch') {
    const cases = Array.isArray(config?.cases) ? (config.cases as unknown[]) : [];
    const caseOutputs: PortDef[] = cases
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value, index) => ({ id: `case-${index}`, label: value, type: 'Exec' as const }));
    return [...caseOutputs, { id: 'default', label: 'Sinon', type: 'Exec' }];
  }

  return def.outputs.filter((port) => port.type === 'Exec');
}

/**
 * Ports d'entrée effectifs d'un nœud, une fois sa configuration prise en compte.
 *
 * Seul `FormatText` a des entrées variables : une par emplacement de son texte.
 * L'éditeur, la validation et le moteur doivent passer par ici plutôt que par
 * `def.inputs`, sinon un texte composé apparaîtrait sans aucune entrée.
 */
export function resolveNodeInputs(node: WorkflowNode): PortDef[] {
  const def = getNodeDef(node.type);
  if (!def) return [];

  if (node.type === 'FormatText') {
    const slots = Array.isArray(node.config?.slots) ? (node.config.slots as TextSlot[]) : [];
    return [
      ...def.inputs,
      ...slots
        .filter((slot) => slot && typeof slot.id === 'string')
        .map((slot) => ({ id: slot.id, label: slot.label || slot.id, type: 'String' as const })),
    ];
  }

  return def.inputs;
}

/**
 * Type effectif du port « Élément » d'un ForEach, déduit de la liste branchée
 * sur son entrée.
 *
 * Sans cette résolution, itérer sur les rôles d'un membre ne servirait à rien :
 * l'élément sortirait en texte et ne pourrait pas alimenter un « Retirer un
 * rôle ». On remonte donc le fil jusqu'au port source pour lire son `itemType`.
 */
function resolveForEachItemType(node: WorkflowNode, graph: WorkflowGraph): PortDataType {
  const listEdge = graph.edges.find((e) => e.target === node.id && e.targetHandle === 'list');
  if (!listEdge) return 'String';

  const sourceNode = graph.nodes.find((n) => n.id === listEdge.source);
  const sourceDef = sourceNode ? getNodeDef(sourceNode.type) : undefined;
  const sourcePort = sourceDef?.outputs.find((p) => p.id === listEdge.sourceHandle);

  return sourcePort?.itemType ?? 'String';
}

/**
 * Ports de sortie effectifs d'un nœud, une fois sa configuration et son
 * câblage pris en compte. C'est cette fonction que doivent utiliser l'éditeur
 * et la validation, jamais `def.outputs` directement.
 */
export function resolveNodeOutputs(node: WorkflowNode, graph?: WorkflowGraph): PortDef[] {
  const def = getNodeDef(node.type);
  if (!def) return [];

  if (node.type === 'Switch') {
    return [
      ...def.outputs.filter((port) => port.type !== 'Exec'),
      ...resolveExecOutputs(node.type, node.config),
    ];
  }

  if (node.type === 'ForEach' && graph) {
    const itemType = resolveForEachItemType(node, graph);
    return def.outputs.map((port) => (port.id === 'item' ? { ...port, type: itemType } : port));
  }

  return def.outputs;
}

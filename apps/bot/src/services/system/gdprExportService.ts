import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getGuildName } from '../../api/shared.js';
import { projectGiveaway, projectMcpApiKey, projectMemberReport, type GdprProjection } from './gdprProjections.js';

/**
 * Service d'export RGPD (droit d'accès / portabilité).
 *
 * Rassemble, pour un identifiant Discord donné, l'ensemble des données que Kotbo
 * conserve à son sujet en base, tous serveurs confondus. Chaque source est
 * interrogée de manière défensive : une table absente ou en erreur n'interrompt
 * pas la collecte, elle est simplement signalée dans les métadonnées.
 */

export interface GdprTable {
  key: string;
  label: string;
  count: number;
  records: unknown[];
}

export interface GdprCategory {
  key: string;
  label: string;
  description: string;
  tables: GdprTable[];
  count: number;
}

export interface GdprExport {
  meta: {
    userId: string;
    username: string | null;
    globalName: string | null;
    generatedAt: string;
    totalRecords: number;
    guildCount: number;
    errors: string[];
  };
  identity: {
    discordUser: Record<string, unknown> | null;
    guilds: { id: string; name: string }[];
    staffMemberIds: string[];
  };
  categories: GdprCategory[];
}

type PrismaModel = { findMany: (args: unknown) => Promise<unknown[]> };

interface SourceDescriptor {
  category: string;
  key: string;
  label: string;
  /** Nom d'accès du modèle sur le client Prisma. */
  model: string;
  /** Construit la clause `where` à partir des identifiants recherchés. */
  where: (ids: { discordId: string; staffIds: string[] }) => Record<string, unknown>;
  /** Retire d'une ligne ce qui concerne d'autres membres (voir `gdprProjections`). */
  project?: GdprProjection;
}

const CATEGORY_META: Record<string, { label: string; description: string }> = {
  identity: {
    label: 'Identité & profil',
    description: "Profils membre, niveaux, statistiques d'activité, préférences dashboard et notifications, carte de rang et statut administrateur.",
  },
  verification: {
    label: 'Vérifications de sécurité',
    description: "Données collectées lors des vérifications d'accès (email, connexions, appareils, détection de doublons).",
  },
  moderation: {
    label: 'Modération & sécurité',
    description: 'Sanctions, rapports, signalements, convocations, comptes liés, appels de bannissement, listes noires et détections.',
  },
  messages: {
    label: 'Messages',
    description: 'Journaux de messages conservés par les modules de logs.',
  },
  content: {
    label: 'Contributions & contenus',
    description: 'Suggestions, votes de réputation, formulaires, candidatures, articles, confessions, fils, contenus du site et partenariats.',
  },
  economy: {
    label: 'Économie & marketplace',
    description: 'Profils RPG, combats, pêche, guildes, tour, drops, boutique, paris de clan, annonces, transactions et facturation.',
  },
  engagement: {
    label: 'Engagement',
    description: 'Événements, quêtes, concours, clans, classement, invitations, votes, abonnements aux widgets et flux.',
  },
  tickets: {
    label: 'Tickets & support',
    description: 'Tickets ouverts et retours de satisfaction.',
  },
  staff: {
    label: 'Staff',
    description: "Données liées au statut de membre du staff : activité, évaluations, avertissements, tâches, etc.",
  },
  system: {
    label: 'Système',
    description: 'Tâches planifiées, cibles de notifications, salons vocaux temporaires, instances white-label, clés MCP et workflows.',
  },
};

/** Toutes les sources de données interrogées, regroupées par catégorie. */
const SOURCES: SourceDescriptor[] = [
  // ── Identité & profil ──────────────────────────────────────────
  { category: 'identity', key: 'memberProfile', label: 'Profils membre', model: 'memberProfile', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'memberLevel', label: 'Niveaux', model: 'memberLevel', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'seasonSnapshot', label: 'Instantanés de saison', model: 'seasonSnapshot', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'memberDailyStat', label: 'Statistiques quotidiennes', model: 'memberDailyStat', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'dashboardCommandUsage', label: 'Usage des commandes dashboard', model: 'dashboardCommandUsage', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'dashboardUserSettings', label: 'Préférences dashboard', model: 'dashboardUserSettings', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'rankCardPreference', label: 'Personnalisation de la carte de rang', model: 'rankCardPreference', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'userAchievement', label: 'Succès de la carte de rang', model: 'userAchievement', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'rankCardSupporter', label: 'Ancienneté de soutien', model: 'rankCardSupporter', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'dashboardLayoutPreset', label: 'Presets de mise en page', model: 'dashboardLayoutPreset', where: ({ discordId }) => ({ creatorId: discordId }) },
  { category: 'identity', key: 'notification', label: 'Notifications', model: 'notification', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'globalAdmin', label: 'Statut administrateur global', model: 'globalAdmin', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'memberInteractionDailyStat', label: "Statistiques d'interactions", model: 'memberInteractionDailyStat', where: ({ discordId }) => ({ OR: [{ userId: discordId }, { targetUserId: discordId }] }) },
  { category: 'identity', key: 'messageContentDailyStat', label: 'Statistiques de contenu des messages', model: 'messageContentDailyStat', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'contentItemDailyStat', label: 'Statistiques des contenus partagés', model: 'contentItemDailyStat', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'commandUsageDailyStat', label: 'Usage des commandes', model: 'commandUsageDailyStat', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'analyticsSavedView', label: 'Vues Analytics enregistrées', model: 'analyticsSavedView', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'notificationPreference', label: 'Préférences de notification', model: 'notificationPreference', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'notificationDm', label: 'Notifications reçues en message privé', model: 'notificationDm', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'identity', key: 'siteMemberSettings', label: 'Préférences sur le site communautaire', model: 'siteMemberSettings', where: ({ discordId }) => ({ userId: discordId }) },

  // ── Vérifications de sécurité ──────────────────────────────────
  { category: 'verification', key: 'securityVerification', label: 'Vérifications', model: 'securityVerification', where: ({ discordId }) => ({ OR: [{ userId: discordId }, { verifiedDiscordId: discordId }, { duplicateUserId: discordId }] }) },
  { category: 'verification', key: 'captchaSession', label: 'Sessions de captcha', model: 'captchaSession', where: ({ discordId }) => ({ userId: discordId }) },

  // ── Modération & sécurité ──────────────────────────────────────
  { category: 'moderation', key: 'sanction', label: 'Sanctions', model: 'sanction', where: ({ discordId }) => ({ OR: [{ targetUserId: discordId }, { moderatorUserId: discordId }] }) },
  { category: 'moderation', key: 'sanctionReport', label: 'Rapports de sanction', model: 'sanctionReport', where: ({ discordId }) => ({ createdByUserId: discordId }) },
  { category: 'moderation', key: 'sanctionEvidenceFile', label: 'Preuves de sanction déposées', model: 'sanctionEvidenceFile', where: ({ discordId }) => ({ uploadedByUserId: discordId }) },
  { category: 'moderation', key: 'linkedAccount', label: 'Comptes liés', model: 'linkedAccount', where: ({ discordId }) => ({ OR: [{ user1Id: discordId }, { user2Id: discordId }, { linkedByUserId: discordId }] }) },
  { category: 'moderation', key: 'globalBlacklist', label: 'Liste noire globale', model: 'globalBlacklist', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'banAppeal', label: 'Appels de bannissement', model: 'banAppeal', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'banAppealBlacklist', label: "Liste noire d'appels", model: 'banAppealBlacklist', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'dcVoiceSession', label: 'Sessions vocales (détection)', model: 'dcVoiceSession', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'dcDetectionSample', label: 'Échantillons de détection', model: 'dcDetectionSample', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'suspendedInviter', label: 'Inviteur suspendu', model: 'suspendedInviter', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'memberRoleSnapshot', label: 'Rôles mémorisés au départ', model: 'memberRoleSnapshot', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'aegisDetection', label: 'Détections Aegis', model: 'aegisDetection', where: ({ discordId }) => ({ OR: [{ authorId: discordId }, { targetUserId: discordId }] }) },
  { category: 'moderation', key: 'aegisMemberDailyStat', label: 'Statistiques Aegis', model: 'aegisMemberDailyStat', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'banHygieneRecord', label: 'Suivi des bannissements', model: 'banHygieneRecord', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'memberJail', label: "Mises à l'isolement", model: 'memberJail', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'visionReview', label: "Analyses d'images", model: 'visionReview', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'moderation', key: 'inviteApprovalRequest', label: "Demandes d'approbation d'invitation", model: 'inviteApprovalRequest', where: ({ discordId }) => ({ creatorId: discordId }) },
  { category: 'moderation', key: 'memberReport', label: 'Signalements', model: 'memberReport', where: ({ discordId }) => ({ OR: [{ reporterId: discordId }, { targetId: discordId }] }), project: projectMemberReport },
  { category: 'moderation', key: 'spamDetectionSample', label: 'Échantillons de détection de spam', model: 'spamDetectionSample', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'moderation', key: 'convocation', label: 'Convocations', model: 'convocation', where: ({ discordId }) => ({ userId: discordId }) },

  // ── Messages ───────────────────────────────────────────────────
  { category: 'messages', key: 'messageLog', label: 'Journaux de messages', model: 'messageLog', where: ({ discordId }) => ({ authorId: discordId }) },

  // ── Contributions & contenus ───────────────────────────────────
  { category: 'content', key: 'suggestion', label: 'Suggestions', model: 'suggestion', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'content', key: 'reputationVote', label: 'Votes de réputation', model: 'reputationVote', where: ({ discordId }) => ({ OR: [{ giverId: discordId }, { receiverId: discordId }] }) },
  { category: 'content', key: 'customFormSubmission', label: 'Soumissions de formulaires', model: 'customFormSubmission', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'content', key: 'dailyAlgoSubmission', label: "Soumissions Daily Algo", model: 'dailyAlgoSubmission', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'partnershipApplication', label: 'Candidatures de partenariat', model: 'partnershipApplication', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'content', key: 'recruitmentCandidature', label: 'Candidatures de recrutement', model: 'recruitmentCandidature', where: ({ discordId }) => ({ discordId }) },
  { category: 'content', key: 'newsArticle', label: 'Articles rédigés', model: 'newsArticle', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'analyticsAnnotation', label: 'Repères Analytics', model: 'analyticsAnnotation', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'autoThreadCreated', label: 'Fils créés automatiquement', model: 'autoThreadCreated', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'panelThread', label: 'Fils ouverts depuis un panneau', model: 'panelThread', where: ({ discordId }) => ({ ownerId: discordId }) },
  { category: 'content', key: 'confession', label: 'Confessions', model: 'confession', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'starboardEntry', label: 'Messages mis en avant (starboard)', model: 'starboardEntry', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'siteForumTopic', label: 'Sujets du forum du site', model: 'siteForumTopic', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'siteForumPost', label: 'Messages du forum du site', model: 'siteForumPost', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'sitePage', label: 'Pages du site rédigées', model: 'sitePage', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'sitePageRevision', label: 'Révisions de pages du site', model: 'sitePageRevision', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'siteComment', label: 'Commentaires sur le site', model: 'siteComment', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'content', key: 'partnerContact', label: 'Contacts de partenariat', model: 'partnerContact', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'content', key: 'partnershipReferral', label: 'Parrainages de partenariat', model: 'partnershipReferral', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'content', key: 'partnership', label: 'Partenariats gérés', model: 'partnership', where: ({ discordId }) => ({ ownerUserId: discordId }) },
  { category: 'content', key: 'partnerApplication', label: 'Candidatures de partenaire', model: 'partnerApplication', where: ({ discordId }) => ({ applicantUserId: discordId }) },

  // ── Économie & marketplace ─────────────────────────────────────
  { category: 'economy', key: 'rpgProfile', label: 'Profils RPG', model: 'rpgProfile', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgBattle', label: 'Combats RPG', model: 'rpgBattle', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgFishCatch', label: 'Prises de pêche', model: 'rpgFishCatch', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgGuild', label: 'Guildes RPG possédées', model: 'rpgGuild', where: ({ discordId }) => ({ ownerId: discordId }) },
  { category: 'economy', key: 'marketplaceListing', label: 'Annonces marketplace', model: 'marketplaceListing', where: ({ discordId }) => ({ sellerId: discordId }) },
  { category: 'economy', key: 'marketplaceTransaction', label: 'Transactions marketplace', model: 'marketplaceTransaction', where: ({ discordId }) => ({ OR: [{ sellerId: discordId }, { buyerId: discordId }] }) },
  { category: 'economy', key: 'ticketSatisfaction', label: 'Retours de satisfaction', model: 'ticketSatisfaction', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'dropClaim', label: 'Drops ramassés', model: 'dropClaim', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgDrop', label: 'Drops RPG réclamés', model: 'rpgDrop', where: ({ discordId }) => ({ claimedBy: discordId }) },
  { category: 'economy', key: 'rpgBlackMarketOffer', label: 'Offres du marché noir', model: 'rpgBlackMarketOffer', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgMonsterFirstKill', label: 'Premières victoires sur un monstre', model: 'rpgMonsterFirstKill', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgQuestProgress', label: 'Progression des quêtes RPG', model: 'rpgQuestProgress', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgCampaignProgress', label: 'Progression de campagne RPG', model: 'rpgCampaignProgress', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgRaidBonus', label: 'Bonus de raid', model: 'rpgRaidBonus', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgRaidAssault', label: 'Assauts de raid', model: 'rpgRaidAssault', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgArenaRecord', label: "Bilan d'arène", model: 'rpgArenaRecord', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgArenaMatch', label: "Combats d'arène", model: 'rpgArenaMatch', where: ({ discordId }) => ({ OR: [{ challengerId: discordId }, { opponentId: discordId }, { winnerId: discordId }] }) },
  { category: 'economy', key: 'rpgFishBookClaim', label: 'Récompenses du carnet de pêche', model: 'rpgFishBookClaim', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgDungeonRun', label: 'Expéditions en donjon', model: 'rpgDungeonRun', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgTowerProfile', label: 'Profil de la tour', model: 'rpgTowerProfile', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgTowerRun', label: 'Ascensions de la tour', model: 'rpgTowerRun', where: ({ discordId }) => ({ OR: [{ userId: discordId }, { ghostClaimedBy: discordId }] }) },
  { category: 'economy', key: 'rpgClanTowerConquest', label: 'Conquêtes de la tour de clan', model: 'rpgClanTowerConquest', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'rpgClanTowerRoom', label: 'Salles de la tour de clan', model: 'rpgClanTowerRoom', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'shopOrder', label: 'Commandes en boutique', model: 'shopOrder', where: ({ discordId }) => ({ buyerId: discordId }) },
  { category: 'economy', key: 'shopRoleGrant', label: 'Rôles obtenus en boutique', model: 'shopRoleGrant', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'shopSubscription', label: 'Abonnements en boutique', model: 'shopSubscription', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'siteRewardLog', label: 'Récompenses du site', model: 'siteRewardLog', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'clanBet', label: 'Paris de clan proposés', model: 'clanBet', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'economy', key: 'clanBetParticipant', label: 'Participations aux paris de clan', model: 'clanBetParticipant', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'economy', key: 'billingTrial', label: "Périodes d'essai", model: 'billingTrial', where: ({ discordId }) => ({ discordUserId: discordId }) },
  { category: 'economy', key: 'billingConsent', label: 'Consentements de facturation', model: 'billingConsent', where: ({ discordId }) => ({ discordUserId: discordId }) },
  { category: 'economy', key: 'billingGift', label: 'Abonnements offerts', model: 'billingGift', where: ({ discordId }) => ({ OR: [{ purchasedById: discordId }, { redeemedById: discordId }] }) },
  { category: 'economy', key: 'referralCode', label: 'Codes de parrainage', model: 'referralCode', where: ({ discordId }) => ({ discordUserId: discordId }) },

  // ── Engagement ─────────────────────────────────────────────────
  { category: 'engagement', key: 'customEventRegistration', label: "Inscriptions à des événements", model: 'customEventRegistration', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'eventParticipant', label: 'Participations aux événements', model: 'eventParticipant', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'questProgress', label: 'Progression des quêtes', model: 'questProgress', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'memberInvite', label: 'Invitations (membre)', model: 'memberInvite', where: ({ discordId }) => ({ OR: [{ userId: discordId }, { inviterId: discordId }] }) },
  { category: 'engagement', key: 'guildInvite', label: 'Invitations créées', model: 'guildInvite', where: ({ discordId }) => ({ inviterId: discordId }) },
  { category: 'engagement', key: 'feedSubscriber', label: 'Abonnements aux flux', model: 'feedSubscriber', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'widgetSubscription', label: 'Abonnements aux widgets', model: 'widgetSubscription', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'giveaway', label: 'Participations aux concours', model: 'giveaway', where: ({ discordId }) => ({ OR: [{ participants: { has: discordId } }, { winners: { has: discordId } }, { pendingWinners: { has: discordId } }] }), project: projectGiveaway },
  { category: 'engagement', key: 'clanMemberContribution', label: 'Contributions au clan', model: 'clanMemberContribution', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'clanContributionEvent', label: 'Historique des points de clan', model: 'clanContributionEvent', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'clanDebtSnapshot', label: 'Relevés de dette de clan', model: 'clanDebtSnapshot', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'clanPointDebt', label: 'Dettes de points de clan', model: 'clanPointDebt', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'rankedMember', label: 'Profil classé', model: 'rankedMember', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'rankedRpLog', label: 'Historique des points classés', model: 'rankedRpLog', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'rankedSeasonEntry', label: 'Saisons classées', model: 'rankedSeasonEntry', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'funCountingPlayer', label: 'Jeu du comptage', model: 'funCountingPlayer', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'broadcastPollVote', label: 'Votes aux sondages diffusés', model: 'broadcastPollVote', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'dailyAlgoWeeklyReward', label: 'Récompenses hebdomadaires Daily Algo', model: 'dailyAlgoWeeklyReward', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'dailyAlgoBonusPoint', label: 'Points bonus Daily Algo', model: 'dailyAlgoBonusPoint', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'eventQuizResponse', label: 'Réponses aux quiz', model: 'eventQuizResponse', where: ({ discordId }) => ({ participant: { userId: discordId } }) },
  { category: 'engagement', key: 'eventCtfSolve', label: 'Épreuves CTF résolues', model: 'eventCtfSolve', where: ({ discordId }) => ({ participant: { userId: discordId } }) },
  { category: 'engagement', key: 'siteVote', label: 'Votes sur le site', model: 'siteVote', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'engagement', key: 'welcomeExperimentAssignment', label: "Groupes d'expérience d'accueil", model: 'welcomeExperimentAssignment', where: ({ discordId }) => ({ userId: discordId }) },

  // ── Tickets & support ──────────────────────────────────────────
  { category: 'tickets', key: 'ticket', label: 'Tickets', model: 'ticket', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'tickets', key: 'ticketBlacklist', label: 'Exclusions des tickets', model: 'ticketBlacklist', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'tickets', key: 'siteTicketLink', label: 'Tickets ouverts depuis le site', model: 'siteTicketLink', where: ({ discordId }) => ({ userId: discordId }) },

  // ── Staff ──────────────────────────────────────────────────────
  // Les tables staff référencent selon les cas l'ID Discord ou l'ID cuid du
  // StaffMember. On interroge donc l'ensemble des identifiants connus.
  { category: 'staff', key: 'staffMember', label: 'Fiches staff', model: 'staffMember', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'staff', key: 'staffActivity', label: 'Activité staff', model: 'staffActivity', where: ({ staffIds }) => ({ staffUserId: { in: staffIds } }) },
  { category: 'staff', key: 'staffVoiceSession', label: 'Sessions vocales staff', model: 'staffVoiceSession', where: ({ staffIds }) => ({ staffUserId: { in: staffIds } }) },
  { category: 'staff', key: 'staffEvaluation', label: 'Évaluations', model: 'staffEvaluation', where: ({ discordId, staffIds }) => ({ OR: [{ staffUserId: { in: staffIds } }, { evaluatorId: discordId }] }) },
  { category: 'staff', key: 'staffWarning', label: 'Avertissements staff', model: 'staffWarning', where: ({ discordId, staffIds }) => ({ OR: [{ staffUserId: { in: staffIds } }, { issuedByUserId: discordId }] }) },
  { category: 'staff', key: 'staffBlacklist', label: 'Liste noire staff', model: 'staffBlacklist', where: ({ discordId, staffIds }) => ({ OR: [{ staffUserId: { in: staffIds } }, { issuedByUserId: discordId }] }) },
  { category: 'staff', key: 'staffResignation', label: 'Démissions', model: 'staffResignation', where: ({ discordId, staffIds }) => ({ OR: [{ staffUserId: { in: staffIds } }, { decisionByUserId: discordId }] }) },
  { category: 'staff', key: 'staffTask', label: 'Tâches staff', model: 'staffTask', where: ({ staffIds }) => ({ OR: [{ assigneeId: { in: staffIds } }, { creatorId: { in: staffIds } }] }) },
  { category: 'staff', key: 'staffCall', label: 'Appels staff créés', model: 'staffCall', where: ({ staffIds }) => ({ creatorId: { in: staffIds } }) },
  { category: 'staff', key: 'staffCallInvitee', label: 'Invitations à des appels', model: 'staffCallInvitee', where: ({ staffIds }) => ({ staffUserId: { in: staffIds } }) },
  { category: 'staff', key: 'staffReminder', label: 'Rappels personnels', model: 'staffReminder', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'staff', key: 'staffHierarchy', label: 'Hiérarchies (responsable)', model: 'staffHierarchy', where: ({ discordId }) => ({ responsableUserId: discordId }) },
  { category: 'staff', key: 'staffMemberHierarchyGrade', label: 'Grades hiérarchiques', model: 'staffMemberHierarchyGrade', where: ({ staffIds }) => ({ staffMemberId: { in: staffIds } }) },
  { category: 'staff', key: 'aPIKey', label: "Clés API staff", model: 'aPIKey', where: ({ staffIds }) => ({ createdByUserId: { in: staffIds } }) },
  { category: 'staff', key: 'mentorReport', label: 'Rapports de mentorat', model: 'mentorReport', where: ({ discordId }) => ({ authorId: discordId }) },
  { category: 'staff', key: 'testingPeriod', label: "Périodes d'essai (mentor)", model: 'testingPeriod', where: ({ discordId }) => ({ mentorId: discordId }) },
  { category: 'staff', key: 'tutoringChecklistProgress', label: 'Progression de tutorat', model: 'tutoringChecklistProgress', where: ({ discordId }) => ({ completedByUserId: discordId }) },
  { category: 'staff', key: 'staffServerLink', label: 'Liens de serveur staff', model: 'staffServerLink', where: ({ discordId }) => ({ createdByUserId: discordId }) },
  { category: 'staff', key: 'ticketStaffSignature', label: 'Signatures de tickets', model: 'ticketStaffSignature', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'staff', key: 'siteStaffProfile', label: 'Profil staff sur le site', model: 'siteStaffProfile', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'staff', key: 'staffAbsence', label: 'Absences', model: 'staffAbsence', where: ({ staffIds }) => ({ staffUserId: { in: staffIds } }) },
  { category: 'staff', key: 'staffMeetingPresence', label: 'Présences aux réunions', model: 'staffMeetingPresence', where: ({ staffIds }) => ({ staffUserId: { in: staffIds } }) },
  { category: 'staff', key: 'staffManagerNote', label: 'Notes de suivi', model: 'staffManagerNote', where: ({ staffIds }) => ({ staffUserId: { in: staffIds } }) },
  { category: 'staff', key: 'staffPollVote', label: 'Votes aux sondages staff', model: 'staffPollVote', where: ({ staffIds }) => ({ staffUserId: { in: staffIds } }) },
  { category: 'staff', key: 'staffProcedureRead', label: 'Lectures de procédures', model: 'staffProcedureRead', where: ({ staffIds }) => ({ staffUserId: { in: staffIds } }) },

  // ── Système ────────────────────────────────────────────────────
  { category: 'system', key: 'scheduledTask', label: 'Tâches planifiées', model: 'scheduledTask', where: ({ discordId }) => ({ targetId: discordId }) },
  { category: 'system', key: 'notificationTarget', label: 'Cibles de notification', model: 'notificationTarget', where: ({ discordId }) => ({ targetId: discordId }) },
  { category: 'system', key: 'tempVoiceChannel', label: 'Salons vocaux temporaires', model: 'tempVoiceChannel', where: ({ discordId }) => ({ creatorId: discordId }) },
  { category: 'system', key: 'whiteLabelInstance', label: 'Instances white-label', model: 'whiteLabelInstance', where: ({ discordId }) => ({ ownerId: discordId }) },
  { category: 'system', key: 'mcpApiKey', label: 'Clés MCP', model: 'mcpApiKey', where: ({ discordId }) => ({ ownerId: discordId }), project: projectMcpApiKey },
  { category: 'system', key: 'workflowTemporaryRole', label: 'Rôles temporaires des workflows', model: 'workflowTemporaryRole', where: ({ discordId }) => ({ userId: discordId }) },
  { category: 'system', key: 'workflowMemberRun', label: 'Passages dans les workflows', model: 'workflowMemberRun', where: ({ discordId }) => ({ userId: discordId }) },
];

/** Collecte l'ensemble des données Kotbo relatives à un identifiant Discord. */
export async function collectUserData(client: Client, userId: string): Promise<GdprExport> {
  const errors: string[] = [];

  // 1. Identité Discord (best-effort).
  const discordUser = await client.users.fetch(userId).catch(() => null);

  // 2. Résolution des fiches staff (userId Discord → id cuid) pour interroger
  //    les tables staff qui référencent le StaffMember par sa clé primaire.
  let staffMemberIds: string[] = [];
  try {
    const staffMembers = await (prisma as unknown as Record<string, PrismaModel>).staffMember.findMany({
      where: { userId },
      select: { id: true },
    }) as { id: string }[];
    staffMemberIds = staffMembers.map((s) => s.id);
  } catch (err) {
    logger.warn('GDPR', `Résolution des fiches staff impossible: ${(err as Error).message}`);
  }
  const staffIds = Array.from(new Set([userId, ...staffMemberIds]));

  // 3. Interrogation de chaque source.
  const byCategory = new Map<string, GdprTable[]>();
  const guildIds = new Set<string>();
  let totalRecords = 0;

  for (const source of SOURCES) {
    const model = (prisma as unknown as Record<string, PrismaModel>)[source.model];
    if (!model || typeof model.findMany !== 'function') {
      errors.push(`Modèle introuvable: ${source.model}`);
      continue;
    }
    try {
      const records = await model.findMany({ where: source.where({ discordId: userId, staffIds }) });
      if (!records.length) continue;

      for (const rec of records as Record<string, unknown>[]) {
        const gid = rec.guildId;
        if (typeof gid === 'string') guildIds.add(gid);
      }

      totalRecords += records.length;
      const list = byCategory.get(source.category) ?? [];
      const project = source.project;
      list.push({
        key: source.key,
        label: source.label,
        count: records.length,
        records: project ? (records as Record<string, unknown>[]).map((record) => project(record, userId)) : records,
      });
      byCategory.set(source.category, list);
    } catch (err) {
      // Le message brut (requête Prisma) reste dans les journaux.
      errors.push(`${source.label} : données indisponibles pour le moment`);
      logger.warn('GDPR', `Erreur sur ${source.model}: ${(err as Error).message}`);
    }
  }

  // 4. Résolution des noms de serveurs concernés.
  const guilds = Array.from(guildIds).map((id) => ({ id, name: getGuildName(client, id) }));

  // 5. Assemblage des catégories dans l'ordre déclaré.
  const categories: GdprCategory[] = [];
  for (const key of Object.keys(CATEGORY_META)) {
    const tables = byCategory.get(key);
    if (!tables || !tables.length) continue;
    const meta = CATEGORY_META[key];
    categories.push({
      key,
      label: meta.label,
      description: meta.description,
      tables,
      count: tables.reduce((acc, t) => acc + t.count, 0),
    });
  }

  return {
    meta: {
      userId,
      username: discordUser?.username ?? null,
      globalName: (discordUser as { globalName?: string | null } | null)?.globalName ?? null,
      generatedAt: new Date().toISOString(),
      totalRecords,
      guildCount: guilds.length,
      errors,
    },
    identity: {
      discordUser: discordUser
        ? {
            id: discordUser.id,
            username: discordUser.username,
            globalName: (discordUser as { globalName?: string | null }).globalName ?? null,
            bot: discordUser.bot,
            createdAt: discordUser.createdAt?.toISOString?.() ?? null,
            avatarURL: discordUser.displayAvatarURL?.() ?? null,
          }
        : null,
      guilds,
      staffMemberIds,
    },
    categories,
  };
}

/**
 * Réseau de serveurs : un serveur de données unique.
 *
 * Les serveurs d'un réseau partagent les mêmes données (sanctions, tickets,
 * niveaux, RPG, formulaires, événements, hiérarchie staff...). Plutôt que de
 * copier ces tables d'un serveur à l'autre, tout ce qui est écrit ou lu au nom
 * d'un sous-serveur est redirigé vers le `guildId` du serveur principal, dans
 * une extension Prisma (voir `utils/db.ts`).
 *
 * Règle : un modèle indexé par `guildId` est PARTAGÉ par défaut. C'est ce qui
 * fait que les fonctionnalités futures se synchronisent sans qu'on y retouche.
 * Un modèle ne reste propre à chaque serveur que s'il figure dans `LOCAL_MODELS`,
 * c'est-à-dire s'il contient des identifiants Discord (salons, rôles, messages)
 * qui n'ont aucun sens sur un autre serveur, ou des mesures propres au serveur.
 *
 * shortcut: seules les égalités `guildId: "<id>"` sont redirigées (y compris dans
 * les clés composées et les AND/OR/NOT). Un filtre `guildId: { in: [...] }` et
 * les requêtes SQL brutes ne le sont pas ; à revoir si un appelant en a besoin.
 */

/** Modèles qui restent propres à chaque serveur du réseau. */
export const LOCAL_MODELS: ReadonlySet<string> = new Set([
  // Réseau, offre et facturation : par serveur, jamais fusionnés.
  'GuildNetworkMember', 'CustomBotConfig', 'BillingConsent', 'BillingEvent', 'BillingInvoice',
  'BillingTrial', 'TestingPeriod', 'GuildLifecycle', 'FeaturedGuild', 'APIKey', 'McpApiKey',
  'McpKeyFeatureAccess', 'AdminPermissionRequest',
  // Accès et réglages du dashboard : liés aux rôles Discord de chaque serveur.
  'DashboardSettings', 'DashboardFeatureConfig', 'DashboardFeatureRoleAccess',
  'DashboardRoleAccess', 'DashboardLayoutPreset', 'DashboardUserSettings', 'DashboardAuditLog',
  'DashboardCommandUsage', 'DashboardTelemetryDailyStat', 'DashboardTelemetryVisitor',
  // Mesures et journaux : chaque serveur garde les siens.
  'AcquisitionEvent', 'AnalyticsAlertEvent', 'AnalyticsAlertRule', 'AnalyticsAnnotation',
  'AnalyticsReportSchedule', 'AnalyticsSavedView', 'AuditEvent', 'ChannelDailyStat',
  'ChannelLinkGroupDailyStat', 'ChannelResponseDailyStat', 'CommandUsageDailyStat',
  'ContentItemDailyStat', 'GuildBoostSnapshot', 'GuildDailyStat', 'GuildHourlyStat',
  'GuildWordStat', 'MemberDailyStat', 'MemberInteractionDailyStat', 'MessageContentDailyStat',
  'MessageLog', 'ModuleActivationStat', 'ModulePerformanceStat', 'ModuleUsageStat',
  'PulseSnapshot', 'ReactionRoleDailyStat', 'SeasonSnapshot', 'SiteDailyStat', 'BoostEvent',
  'AegisHourlyStat', 'AegisMemberDailyStat', 'AegisDetection', 'DiscordAutoModEvent',
  'SecurityVerification', 'ServerBackup', 'GuildLogEventConfig', 'AuditLoggerConfig',
  // État Discord éphémère : salons, messages, invitations et panneaux d'un serveur.
  'TempVoiceChannel', 'TempVoiceAccessRequestConfig', 'TempVoiceModPermissionsConfig',
  'ChannelLockdown', 'CaptchaSession', 'GuildInvite', 'MemberInvite', 'InviteApprovalRequest',
  'SuspendedInviter', 'ChannelLinkGroupMember', 'ChannelLinkInvite', 'PanelThread',
  'ThreadPanel', 'StickyMessage', 'AutoThreadConfig', 'AutoThreadCreated', 'BumpState',
  'ReactionRoleMenu', 'StarboardConfig', 'StarboardEntry', 'WelcomeConfig',
  'WelcomeThreadConfig', 'WelcomeThreadCreated', 'WelcomeThreadStep', 'WelcomeMenuPage',
  'WelcomeExperiment', 'WelcomeExperimentAssignment', 'StaffListPanel', 'RecruitmentPanel',
  'Notification', 'NotificationDm', 'NotificationTarget', 'BroadcastDelivery',
  'BroadcastFeedback', 'BroadcastPollVote', 'OutgoingWebhook', 'OutgoingWebhookDelivery',
  'WidgetSubscription', 'ScheduledTask', 'Feed', 'GithubRepoFollow', 'HuggingFaceFollow',
  'TwitchChannelFollow', 'YoutubeChannelFollow', 'AutoLeaderboard', 'GhostPruneRun',
  'GhostAnalyzerConfig', 'MemberRoleSnapshot', 'DiscordExternalGuild',
  // Configurations qui pointent des salons ou rôles Discord propres au serveur.
  'AutoModConfig', 'RaidProtectionConfig', 'SpamDetectionConfig', 'TagAutomodConfig',
  'CallPermissionConfig', 'ChannelHealthConfig', 'LevelConfig', 'LevelRoleReward',
  'RankedTierRole', 'SuggestionConfig', 'GiveawayConfig', 'DropConfig', 'BanAppealConfig',
  'WellbeingConfig', 'RpgClanTowerConfig', 'RpgTowerConfig', 'ShopRoleGrant',
  'WellbeingBreakGlassLog', 'CommunitySite', 'SiteAsset',
  // Dossiers confidentiels : seule la cellule de leur serveur les lit. Leurs
  // notes suivent par `caseId`, sans `guildId` à rediriger.
  'WellbeingCase',
]);

export function isSynced(model: string): boolean {
  return !LOCAL_MODELS.has(model);
}

type Resolve = (guildId: string) => Promise<string>;

function isPlainObject(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== 'object') return false;
  const proto = Object.getPrototypeOf(node);
  return proto === Object.prototype || proto === null;
}

function collect(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'guildId' && typeof value === 'string') out.add(value);
    else collect(value, out);
  }
}

function apply(node: unknown, map: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((n) => apply(n, map));
  if (!isPlainObject(node)) return node;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] = key === 'guildId' && typeof value === 'string'
      ? (map.get(value) ?? value)
      : apply(value, map);
  }
  return copy;
}

/** Renvoie une copie des arguments Prisma où chaque `guildId` pointe le serveur de données. */
export async function redirectGuildIds<T>(args: T, resolve: Resolve): Promise<T> {
  const ids = new Set<string>();
  collect(args, ids);
  if (ids.size === 0) return args;
  const map = new Map<string, string>();
  await Promise.all([...ids].map(async (id) => map.set(id, await resolve(id))));
  return apply(args, map) as T;
}

const TTL_MS = 30_000;
const cache = new Map<string, { to: string; at: number }>();

/**
 * Serveur de données d'un serveur : lui-même s'il est hors réseau ou principal,
 * sinon le principal de son réseau. Un échec de lecture retombe sur le serveur
 * lui-même (sans le mettre en cache) pour ne jamais bloquer une requête.
 */
export async function resolveDataGuild(
  guildId: string,
  lookupPrimary: (guildId: string) => Promise<string | null>,
): Promise<string> {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.to;
  try {
    const to = (await lookupPrimary(guildId)) ?? guildId;
    cache.set(guildId, { to, at: Date.now() });
    return to;
  } catch {
    return guildId;
  }
}

/** À appeler quand un serveur rejoint ou quitte un réseau. */
export function invalidateNetworkScope(): void {
  cache.clear();
}

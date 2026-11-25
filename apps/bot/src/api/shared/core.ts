import { type IncomingMessage, ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';


import { type Client, TextChannel, Collection, GuildMember, Guild } from 'discord.js';
import { SanctionType } from '@prisma/client';
import jwt from 'jsonwebtoken';
import prisma from '../../utils/db.js';
import { upsertRetryingRace } from '../../utils/upsertRetry.js';
import { cache } from '../../utils/cache.js';
import { scopedGuildId } from '../../services/system/customDomain.js';
import { logger } from '../../utils/logger.js';
import { fetchExternal } from '../../utils/http.js';
import { guildNameCache } from '../../services/core/serverTagService.js';

// Contrat partage avec le dashboard : la definition vit dans @kotbo/contracts,
// on la re-expose ici pour que le reste du bot continue d'importer depuis
// `api/shared.js` sans changement.
export type {
  DashboardSanctionType,
  DashboardSanctionStatus,
  DashboardRole,
  SanctionItem,
  SanctionReportItem,
  MemberCaseQuickAction,
  MemberCaseLogEntry,
  MemberCaseChannelMessage,
  MemberCaseChannelSummary,
  MemberCaseInviteInfo,
  MemberCaseProfile,
  LinkedAccountItem,
  MemberCaseInteractionNode,
  MemberCaseInteractionEdge,
  MemberCaseInteractionGraph,
  MemberCaseResponse,
} from '@kotbo/contracts';
import type {
  DashboardSanctionType,
  PlanKey,
  DashboardRole,
  SanctionItem,
  SanctionReportItem,
  
  
  
  MemberCaseInviteInfo,
  
  
  
  
  
  
} from '@kotbo/contracts';
export { COLORS, successEmbed } from '../../utils/embeds.js';

export {
  registerBanSanction,
  registerKickSanction,
  registerTimeoutSanction,
  registerWarnSanction,
  runGuildBan,
  formatDurationFr,
} from '../../services/moderation/sanctionService.js';
import {
  COMMAND_CATALOG,
  normalizeCommandRestrictions,
  type CommandRestrictionRule,
} from '../../utils/commandAccess.js';

import { hashAPIKey, verifyAPIKey } from '../../services/staff/staffManagementService.js';
export {
  getPublicProfileSnapshot,
  getStaffProfileSnapshot,
} from '../../services/progression/profileService.js';



import crypto from 'node:crypto';
import { fetchAllMembers } from '../../utils/discord.js';
import { getCurrentInstance } from '../../utils/instanceContext.js';

const FALLBACK_JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  logger.warn('DashboardAPI', 'JWT_SECRET variable is not set. Generating one ephemeral fallback secret for this process.');
}

// Instance-aware getters - resolve from white-label context when available
export function getDiscordClientId(): string {
  try { return getCurrentInstance().discordClientId; } catch { return process.env.DISCORD_CLIENT_ID || ''; }
}
export function getDiscordClientSecret(): string {
  try { return getCurrentInstance().discordClientSecret; } catch { return process.env.DISCORD_CLIENT_SECRET || ''; }
}
export function getDiscordRedirectUri(): string {
  try { return getCurrentInstance().discordRedirectUri || process.env.DISCORD_REDIRECT_URI || ''; } catch { return process.env.DISCORD_REDIRECT_URI || ''; }
}
export function getJwtSecret(): string {
  try { return getCurrentInstance().jwtSecret; } catch { return FALLBACK_JWT_SECRET; }
}
export function getDashboardUrl(): string {
  try { return getCurrentInstance().dashboardUrl; } catch { return process.env.DASHBOARD_URL || 'http://localhost:5173'; }
}
export function getApiUrl(): string {
  const redirectUri = getDiscordRedirectUri();
  if (redirectUri) {
    try {
      const url = new URL(redirectUri);
      return url.origin;
    } catch {
      // ignore
    }
  }
  return (process.env.VITE_API_URL || 'http://localhost:8787').replace(/\/$/, '');
}
export function getDashboardOrigin(): string {
  try { return getCurrentInstance().dashboardOrigin; } catch {
    const url = process.env.DASHBOARD_URL || 'http://localhost:5173';
    try { return new URL(url).origin; } catch { return url.replace(/\/$/, ''); }
  }
}

// Backward-compatible aliases (read from getters)
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
export const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
export const JWT_SECRET: string = FALLBACK_JWT_SECRET;
export const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:5173';
export const DASHBOARD_ORIGIN = (() => {
  try { return new URL(DASHBOARD_URL).origin; } catch { return DASHBOARD_URL.replace(/\/$/, ''); }
})();
export const CORS_EXTRA_ORIGINS: string[] = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => { try { return new URL(s.trim()).origin; } catch { return s.trim().replace(/\/$/, ''); } })
  .filter(Boolean);

/** Landing kotbo.fr, dashboard dash.kotbo.fr et autres sous-domaines *.kotbo.fr */
export function isKotboPublicOrigin(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
    return parsed.hostname === 'kotbo.fr' || parsed.hostname.endsWith('.kotbo.fr');
  } catch {
    return false;
  }
}

export const DEFAULT_TRANSLATION_TARGET_LANG = 'FR';
export const DISCORD_CLIENT_OWNER_ID = process.env.DISCORD_CLIENT_OWNER_ID;

export const getMissingOAuthConfig = ({ includeSecret = false }: { includeSecret?: boolean } = {}) => {
  const clientId = getDiscordClientId();
  const redirectUri = getDiscordRedirectUri();
  const clientSecret = getDiscordClientSecret();
  const missing: string[] = [];
  if (!clientId?.trim()) missing.push('DISCORD_CLIENT_ID');
  if (!redirectUri?.trim()) missing.push('DISCORD_REDIRECT_URI');
  if (includeSecret && !clientSecret?.trim()) missing.push('DISCORD_CLIENT_SECRET');
  return missing;
};

export const getClientIp = (req: IncomingMessage): string => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    } else if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0].trim();
    }
  }
  return req.socket.remoteAddress || '127.0.0.1';
};

export {
  configRateLimiter,
  errorReportRateLimiter,
  feedbackReportRateLimiter,
  dashboardWriteRateLimiter,
  dashboardSensitiveRateLimiter,
  rankCardPreviewRateLimiter,
} from '../limiters.js';

export const checkRateLimit = (limiterMap: Map<string, number[]>, ip: string, limit: number, windowMs: number): boolean => {
  const now = Date.now();
  const timestamps = limiterMap.get(ip) || [];
  const validTimestamps = timestamps.filter(t => now - t < windowMs);
  if (validTimestamps.length >= limit) {
    return false;
  }
  validTimestamps.push(now);
  limiterMap.set(ip, validTimestamps);
  return true;
};

export type ModuleStatus = 'active' | 'inactive' | 'error';
export type { SeverityLevel } from '@kotbo/contracts';
import type { SeverityLevel } from '@kotbo/contracts';
export type DashboardPresetKey = 'general' | 'gaming' | 'dev';
export type CommandAccessLevel = 'tout_le_monde' | 'modération' | 'administration';
export type ShardingMode = 'auto' | 'fixed';

export type ShardSnapshot = {
  shardId: number;
  status: 'online' | 'offline' | 'starting' | 'restarting';
  guildCount: number;
  memberCount: number;
  ping: number;
  uptime: number;
  readyAt: string | null;
  memoryUsage: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
};

export type ShardingConfig = {
  mode: ShardingMode;
  shardCount: number | null;
};

export type ModuleItem = {
  id: string;
  name: string;
  description: string;
  status: ModuleStatus;
  uptime: number;
  interactions: number;
  lastSync: string;
  errorMessage?: string;
  isFixed?: boolean;
  /** Rubrique du registre, pour le regroupement de la page Modules. */
  category?: string;
  /** Icône Papicon déclarée par le registre. */
  icon?: string;
  /** Modules que celui-ci exige, déjà ramenés à leur clé canonique. */
  requires?: string[];
  /** Modules qui cesseraient de fonctionner si celui-ci était éteint. */
  dependents?: string[];
  /**
   * Éteint uniquement parce qu'une de ses dépendances l'est : la page l'affiche
   * autrement qu'un module coupé volontairement.
   */
  blockedBy?: string[];
  /** Route du dashboard vers la configuration détaillée, si elle existe. */
  settingsPath?: string;
  /**
   * Éteint parce que l'offre du serveur ne le comprend pas, et non par choix
   * d'un administrateur. La page affiche un cadenas et un lien vers l'offre
   * plutôt qu'un interrupteur qui ne servirait à rien.
   */
  lockedByPlan?: boolean;
  /** Offre la plus basse qui débloque ce module, quand il est verrouillé. */
  requiredPlan?: string | null;
};

export type NotificationSettings = {
  discordChannel: string;
  email: string;
  emailEnabled: boolean;
  cloudBackup: boolean;
  debugLog: boolean;
  killSwitchEnabled: boolean;
  severityByModule: Array<{ module: string; level: SeverityLevel }>;
};

export type { AuditEntry, SanctionTable, SanctionTableTier } from '@kotbo/contracts';
import type { AuditEntry } from '@kotbo/contracts';

export const PRESET_LABELS: Record<DashboardPresetKey, string> = {
  general: 'Communauté générale',
  gaming: 'Gaming/Esport',
  dev: 'Dev/Tech',
};

export const PRESET_COMMAND_OVERRIDES: Record<DashboardPresetKey, Partial<Record<string, CommandAccessLevel>>> = {
  general: {},
  gaming: {},
  dev: {},
};

export type RoleDisplay = {
  id: string;
  name: string;
};

export type PrimaryRoleDisplay = RoleDisplay | null;

export interface CachedMembers {
  members: Collection<string, GuildMember>;
  timestamp: number;
}

export const guildMembersCache = new Map<string, CachedMembers>();
export const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

export async function getGuildMembers(discordGuild: Guild): Promise<Collection<string, GuildMember>> {
  const guildId = discordGuild.id;
  const cached = guildMembersCache.get(guildId);
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    return cached.members;
  }

  try {
    const allMembers = await fetchAllMembers(discordGuild);
    guildMembersCache.set(guildId, {
      members: allMembers,
      timestamp: Date.now(),
    });
    return allMembers;
  } catch (fetchErr) {
    logger.warn('AnalyticsAPI', `Error fetching guild members for guild ${guildId}: ${String(fetchErr)}`);
    if (cached) {
      logger.info('AnalyticsAPI', `Using stale member cache for guild ${guildId} due to fetch error.`);
      return cached.members;
    }
    logger.info('AnalyticsAPI', `Falling back to members cache for guild ${guildId}.`);
    return discordGuild.members.cache;
  }
}

export function isDisplayableRoleName(name: string): boolean {
  const trimmedName = name.trim();
  return trimmedName.length > 0 && trimmedName !== '@everyone' && !/^[\W_]+$/u.test(trimmedName);
}

export async function resolveProfileRoleDisplay(client: Client, guildId: string, roleIds: string[]): Promise<{
  roles: RoleDisplay[];
  primaryRole: PrimaryRoleDisplay;
}> {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);

  if (!guild) {
    return { roles: [], primaryRole: null };
  }

  const resolvedRoles = roleIds
    .map((roleId) => guild.roles.cache.get(roleId) ?? guild.roles.cache.find((role) => role.name === roleId) ?? null)
    .filter((role): role is NonNullable<typeof role> => !!role && role.name !== '@everyone')
    .sort((left, right) => right.position - left.position || left.id.localeCompare(right.id));

  const primaryRole = resolvedRoles.find((role) => isDisplayableRoleName(role.name)) ?? resolvedRoles[0] ?? null;

  return {
    roles: resolvedRoles.map((role) => ({
      id: role.id,
      name: role.name,
    })),
    primaryRole: primaryRole
      ? {
          id: primaryRole.id,
          name: primaryRole.name,
        }
      : null,
  };
}

export const buildModuleUpdatesForPreset = (presetKey: DashboardPresetKey) => {
  if (presetKey === 'dev') {
    return {
      codePoliceEnabled: true,
      translationEnabled: false,
    };
  }

  return {
    codePoliceEnabled: false,
    translationEnabled: true,
  };
};

export const buildCommandRestrictionsForPreset = (
  presetKey: DashboardPresetKey,
  options: {
    moderatorRoleId?: string | null;
    adminRoleIds: string[];
    fallbackUserId: string;
    modRoleIds: string[];
  },
): CommandRestrictionRule[] => {
  const accessByCommand: Record<string, CommandAccessLevel> = Object.create(null);
  for (const command of COMMAND_CATALOG) {
    accessByCommand[command.name] = command.defaultAccess;
  }

  const overrides = PRESET_COMMAND_OVERRIDES[presetKey] ?? {};
  for (const [commandName, access] of Object.entries(overrides)) {
    if (access) {
      accessByCommand[commandName] = access;
    }
  }

  return Object.entries(accessByCommand)
    .filter(([, access]) => access !== 'tout_le_monde')
    .map(([commandName, access]) => {
      const allowedRoleIds = access === 'administration'
        ? options.adminRoleIds
        : (options.moderatorRoleId ? [options.moderatorRoleId] : options.modRoleIds);
      const allowedUserIds = allowedRoleIds.length > 0 ? [] : [options.fallbackUserId];

      return {
        commandName,
        enabled: true,
        allowedChannelIds: [],
        blockedChannelIds: [],
        allowedRoleIds,
        blockedRoleIds: [],
        allowedUserIds,
        blockedUserIds: [],
      };
    });
};


// Ces formes sont ce que l'API envoie au dashboard : elles vivent dans
// @kotbo/contracts, que les deux cotes lisent. La reexportation garde les
// imports des modules du bot inchanges.
export type {
  RegulationRuleItem,
  DashboardChannel,
  CommandCatalogEntry,
} from '@kotbo/contracts';

/** Series d'activite du serveur. Nom historique cote bot. */
export type { GuildAnalyticsData as AnalyticsData } from '@kotbo/contracts';

// Une reexportation n'introduit pas les noms dans la portee du fichier : ce
// module s'en sert aussi pour decrire GuildStateResponse juste en dessous.
import type {
  RegulationRuleItem,
  DashboardChannel,
  CommandCatalogEntry,
  SanctionTable,
  GuildAnalyticsData as AnalyticsData,
} from '@kotbo/contracts';

export type CommandRestrictionState = CommandRestrictionRule;

export type DashboardAccessLevel = 'none' | 'moderator' | 'admin';

export type DashboardAccess = {
  level: DashboardAccessLevel;
  canViewDashboard: boolean;
  canModerateContent: boolean;
  canManageSettings: boolean;
  canManageTutoring: boolean;
  /** Acces obtenu uniquement parce que l'utilisateur est admin global Kotbo : ses ecritures sont journalisees. */
  viaGlobalAdmin?: boolean;
};

export type FeatureAccess = {
  canView: boolean;
  canModerate: boolean;
  canConfigure: boolean;
  canDelete: boolean;
};

export type FeatureAccessMap = Record<string, FeatureAccess>;

export type DashboardState = {
  guildName: string;
  /** Offre du serveur, telle que `moduleGate` l'applique. */
  plan: PlanKey;
  /**
   * Fin de l'essai gratuit en cours (ISO), null hors essai. Le temps qui reste
   * s'affiche dans le dashboard : un essai dont on ne voit pas la fin se
   * repousse au dernier jour.
   */
  trialEndsAt: string | null;
  /**
   * Le serveur n'a pas fini son parcours : il n'a pas de tableau de bord, il a
   * un tunnel de configuration. Calcule cote serveur (voir `guildState.ts`), et
   * sur le seul etat du serveur - ni l'offre, ni le navigateur, ni le statut de
   * la personne connectee n'y changent quoi que ce soit.
   */
  onboardingRequired: boolean;
  /**
   * Le dernier ecran du tunnel peut se conclure sans passer par Stripe :
   * instance sans facturation, ou serveur dont l'acces a deja ete accorde.
   */
  onboardingCanFinishWithoutPayment: boolean;
  configChannelId: string;
  logChannelId: string;
  /** Salons exclus des logs Discord. Renvoye par `getGuildState` et lu par
   *  la page Logs, mais jamais declare ici : le typecheck echouait. */
  logIgnoredChannelIds: string[];
  regulationChannelId: string;
  regulationMessageId: string | null;
  regulationVerificationEnabled: boolean;
  regulationRoleId: string | null;
  regulationLockEnabled: boolean;
  meetingAnnouncementChannelId: string;
  meetingVoiceChannelId: string;
  publicChannelId: string;
  newsChannelId: string;
  digestChannelId: string;
  baseStaffRoleId: string;
  testStaffRoleId: string;
  propagateSanctions: boolean;
  crossServerSanctionsEnabled: boolean;
  translationEnabled: boolean;
  codePoliceEnabled: boolean;
  /** Collecte des statistiques d'activité. À false, plus rien n'est enregistré. */
  analyticsEnabled: boolean;
  githubReleasesEnabled: boolean;
  digestEnabled: boolean;
  youtubeEnabled: boolean;
  twitchEnabled: boolean;
  socialNetworksEnabled: boolean;
  autoThreadEnabled: boolean;
  autoThreadChannels: string[];
  autoThreadBotsEnabled: boolean;
  funEnabled: boolean;
  economyEnabled: boolean;
  levelingEnabled: boolean;
  adminLockEnabled: boolean;
  isStaffServer: boolean;
  funCountingChannelId: string;
  funOneWordStoryChannelId: string;
  funGuessNumberChannelId: string;
  funWordChainChannelId: string;
  funEmojiRiddleChannelId: string;
  funNeverSayChannelId: string;
  funEmojiOnlyChannelId: string;
  funImageOfDayChannelId: string;
  funConfessionChannelId: string;
  funConfessionLogChannelId: string;
  funPunitiveMode: boolean;
  recruitmentCategoryId: string;
  recruitmentLogChannelId: string;
  recruitmentAutoRejectEnabled: boolean;
  modules: ModuleItem[];
  /** Etat brut de chaque module, pour le filtrage de la navigation. */
  moduleStates: Record<string, boolean>;
  discordChannels: DashboardChannel[];
  discordVoiceChannels: DashboardChannel[];
  discordCategories: DashboardChannel[];
  discordRoles: DashboardRole[];
  /** Roles Discord rattaches a la hierarchie staff, role moderateur inclus. */
  staffRoleIds: string[];
  moderatorRoleId: string;
  sanctionAlertChannelId: string;
  commandRestrictions: CommandRestrictionState[];
  sidebarFavorites: string[];
  commandCatalog: CommandCatalogEntry[];
  access: {
    level: Exclude<DashboardAccessLevel, 'none'>;
    canModerateContent: boolean;
    canManageSettings: boolean;
  };
  featureAccess: FeatureAccessMap;
  notifications: NotificationSettings;
  auditTrail: AuditEntry[];
  sanctions: SanctionItem[];
  sanctionReports: SanctionReportItem[];
  sanctionTables: SanctionTable[];
  sanctionReportEnabled: boolean;
  sanctionReportSkipBots: boolean;
  regulationRules: RegulationRuleItem[];
  messageTemplate: string;
  analytics: AnalyticsData;
  member: null | {
    id: string;
    nickname: string | null;
    roles: Array<{
      id: string;
      name: string;
      position: number;
      managed: boolean;
    }>;
    isTutor?: boolean;
  };
};

export type RuntimeState = {
  email: string;
  emailEnabled: boolean;
  cloudBackup: boolean;
  debugLog: boolean;
  killSwitchEnabled: boolean;
  severityByModule: Array<{ module: string; level: SeverityLevel }>;
  commandRestrictions: CommandRestrictionState[];
  sidebarFavorites: string[];
  messageTemplate: string;
};

export const MODULE_DESCRIPTIONS: Record<string, string> = {
  codepolice: 'Vérification de la syntaxe et bonnes pratiques sur les snippets.',
  traduction: 'Traduction instantanée vers la langue configurée.',
  regulation: 'Configuration et publication du règlement du serveur.',
  staff_management: 'Gestion complète du personnel, recrutements et absences.',
  sanctions: 'Historique et gestion des sanctions (warns, mutes, bans).',
  members: 'Gestion avancée des membres et détection de doubles comptes.',
  logs: "Journaux d'événements Discord (messages, salons, membres).",
  nickname_moderation: 'Détection et modération automatique des pseudos inappropriés.',
  activity: "Suivi détaillé de l'activité utilisateur sur le dashboard.",
  auto_thread: 'Gestion des salons : fils automatiques, message sticky, salons statistiques, vocaux temporaires et honeypot.',
  analytics: "Statistiques de croissance et d'engagement du serveur.",
  profile: 'Gestion du profil utilisateur et paramètres personnels.',
  fun: 'Salons de jeux et divertissement (comptage, one word story, nombre mystère, chaîne de mots, rébus emoji, ni oui ni non, emoji uniquement).',
  recruitment: 'Suivi des candidatures et intégration du personnel.',
  tickets: "Système complet de tickets d'assistance et de support configurable.",
  youtube: 'Intégration YouTube pour les notifications de nouvelles vidéos.',
  twitch: 'Intégration Twitch pour les notifications de lives.',
  social_networks: 'Configuration des flux YouTube et Twitch suivis.',
  digest: 'Génération de résumés automatiques et flux RSS.',
  tutoring: "Gestion des périodes d'essai et formation des nouveaux staff.",
  meetings: "Planification et suivi des réunions d'équipe.",
  absences: 'Gestion des congés et disponibilités du personnel.',
  double_accounts: 'Détection et gestion des comptes multiples pour la sécurité.',
  events: "Organisation et gestion d'événements communautaires et quiz.",
  economy: "Système complet d'économie et d'aventures RPG textuelles.",
  leveling: "Système complet d'XP, niveaux, saisons compétitives et rôles de récompense.",
};

export const DEFAULT_SEVERITY_BY_MODULE: Array<{ module: string; level: SeverityLevel }> = [
  { module: 'Auto-Modération', level: 'attention' },
];

export const DEFAULT_MESSAGE_TEMPLATE =
  '🔔 {titre}\n\n{resume}\n\nSource: {source}\nAuteur: {auteur}\n\nPublié automatiquement par Kotbo.';

export const recruitmentAutoRejectEnabledByGuild = new Map<string, boolean>();

export const isRecruitmentAutoRejectEnabled = (guildId: string) => {
  return recruitmentAutoRejectEnabledByGuild.get(guildId) ?? true;
};

export const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
export const nowIso = () => new Date().toISOString();

export function normalizeLangCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return null;
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

export function isDashboardSanctionType(value: string): value is DashboardSanctionType {
  return value === 'WARN' || value === 'KICK' || value === 'TIMEOUT' || value === 'TEMP_BAN' || value === 'BAN' || value === 'SOFTBAN';
}

export function toSanctionType(value: DashboardSanctionType): SanctionType {
  return value as SanctionType;
}

export function normalizeBrokenRulesPayload(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return trimmed;
    }

    const normalized = parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;

        const snapshot = entry as Record<string, unknown>;
        const id = typeof snapshot.id === 'string' ? snapshot.id.trim() : '';
        if (!id) return null;

        const title = typeof snapshot.title === 'string'
          ? snapshot.title.trim()
          : typeof snapshot.label === 'string'
            ? snapshot.label.trim()
            : '';

        const description = typeof snapshot.description === 'string'
          ? snapshot.description.trim()
          : typeof snapshot.details === 'string'
            ? snapshot.details.trim()
            : '';

        if (!title || !description) return null;

        const emoji = typeof snapshot.emoji === 'string' && snapshot.emoji.trim() ? snapshot.emoji.trim() : null;
        const sortOrder = typeof snapshot.sortOrder === 'number' && Number.isFinite(snapshot.sortOrder) ? snapshot.sortOrder : 0;

        return {
          id,
          title,
          description,
          emoji,
          sortOrder,
        };
      })
      .filter((entry): entry is { id: string; title: string; description: string; emoji: string | null; sortOrder: number } => !!entry);

    return normalized.length > 0 ? JSON.stringify(normalized) : trimmed;
  } catch {
    return trimmed;
  }
}

export const toRuntimeState = (settings: {
  email: string;
  emailEnabled: boolean;
  cloudBackup: boolean;
  debugLog: boolean;
  killSwitchEnabled: boolean;
  severityByModule: unknown;
  commandRestrictions: unknown;
  sidebarFavorites: unknown;
  messageTemplate: string;
}): RuntimeState => {
  const rawSeverity = Array.isArray(settings.severityByModule)
    ? settings.severityByModule
    : DEFAULT_SEVERITY_BY_MODULE;

  const severityByModule = rawSeverity
    .map((item) => {
      if (!item || typeof item !== 'object') return null;

      const module = (item as Record<string, unknown>).module;
      const level = (item as Record<string, unknown>).level;
      const allowedLevels: SeverityLevel[] = ['off', 'info', 'attention', 'critique'];

      if (typeof module !== 'string' || typeof level !== 'string' || !allowedLevels.includes(level as SeverityLevel)) {
        return null;
      }

      return { module, level: level as SeverityLevel };
    })
    .filter((entry): entry is { module: string; level: SeverityLevel } => !!entry);

  return {
    email: settings.email,
    emailEnabled: settings.emailEnabled,
    cloudBackup: settings.cloudBackup,
    debugLog: settings.debugLog,
    killSwitchEnabled: settings.killSwitchEnabled,
    severityByModule: severityByModule.length > 0 ? severityByModule : DEFAULT_SEVERITY_BY_MODULE,
    commandRestrictions: normalizeCommandRestrictions(settings.commandRestrictions),
    sidebarFavorites: Array.isArray(settings.sidebarFavorites)
      ? settings.sidebarFavorites.filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('/'))
      : [],
    messageTemplate: settings.messageTemplate || DEFAULT_MESSAGE_TEMPLATE
  };
};

/**
 * Le tableau de bord est une application monopage : chaque retour en arrière,
 * chaque changement d'onglet redemande les mêmes listes, et la réponse était
 * retransmise en entier même lorsque rien n'avait bougé. Sur les vues les plus
 * lourdes — membres, journaux, analytique — cela représentait des centaines de
 * kilo-octets à retransférer puis à reparser pour un contenu identique.
 *
 * On signe donc chaque réponse de lecture et on répond 304 quand le client
 * détient déjà la bonne version. La requête en base a bien lieu : ce qui est
 * économisé, c'est le transfert et l'analyse côté navigateur, soit la part
 * dominante du délai ressenti sur une liste volumineuse.
 */
function applyConditionalGet(res: ServerResponse, statusCode: number, body: string): boolean {
  if (statusCode !== 200) return false;

  const method = res.req?.method;
  if (method !== 'GET' && method !== 'HEAD') return false;

  const etag = weakEtag(body);
  if (!res.headersSent) {
    res.setHeader('ETag', etag);
    // Sans directive de cache, un navigateur ne conserve pas une réponse
    // inter-origines et ne revalide donc jamais : l'ETag ne servirait à rien.
    // `no-cache` ne veut pas dire « ne pas stocker » mais « stocker et
    // revalider systématiquement », ce qui est exactement le comportement
    // voulu — l'autorisation est réverifiée à chaque appel, et une réponse
    // devenue obsolète est remplacée puisque son empreinte aura changé.
    if (!res.hasHeader('Cache-Control')) {
      res.setHeader('Cache-Control', 'private, no-cache');
    }
  }

  // `If-None-Match` peut lister plusieurs entités séparées par des virgules.
  return etagMatches(res.req.headers['if-none-match'], etag);
}

export function weakEtag(body: string): string {
  return `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
}

/** `If-None-Match` peut lister plusieurs entités séparées par des virgules. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const candidates = ifNoneMatch.split(',').map((value) => value.trim());
  return candidates.includes(etag) || candidates.includes('*');
}

export const json = (res: ServerResponse, statusCode: number, data: unknown) => {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }

  if (statusCode === 204) {
    res.statusCode = statusCode;
    res.end();
    return;
  }

  const body = JSON.stringify(data);

  if (applyConditionalGet(res, statusCode, body)) {
    res.statusCode = 304;
    // Une 304 ne porte pas de corps : laisser Content-Type amène certains
    // intermédiaires à annoncer une longueur qui ne suivra jamais.
    if (!res.headersSent) res.removeHeader('Content-Type');
    res.end();
    return;
  }

  res.statusCode = statusCode;
  res.end(body);
};

export type AuthClaims = {
  userId: string;
  username?: string;
  avatar?: string;
  discordToken?: string;
  /** Ouverture de la session (ms) : la cellule bien-être exige une connexion récente. */
  sessionCreatedAt?: number;
};

function legacyBearerAuthEnabled(): boolean {
  const raw = process.env.AUTH_LEGACY_BEARER_UNTIL;
  if (!raw) return false;
  const cutoff = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(cutoff) && Date.now() < cutoff;
}

export const verifyAuth = async (req: IncomingMessage): Promise<AuthClaims | null> => {
  const cookie = req.headers.cookie;
  return verifyAuthHeaders(req.headers.authorization, Array.isArray(cookie) ? cookie[0] : cookie);
};

/** Même contrôle que `verifyAuth`, à partir des seuls en-têtes (routes Hono). */
export const verifyAuthHeaders = async (
  authHeader: string | undefined,
  cookieHeader: string | undefined,
): Promise<AuthClaims | null> => {
  if (legacyBearerAuthEnabled() && authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const claims = jwt.verify(token, getJwtSecret()) as AuthClaims & { iat?: number };
      return { ...claims, sessionCreatedAt: typeof claims.iat === 'number' ? claims.iat * 1000 : undefined };
    } catch {
      // Continue with the cookie session. Frontends may still send a harmless
      // compatibility marker in the Authorization header during migration.
    }
  }

  const { getDashboardSession, sessionIdFromCookieHeader } = await import('../auth/sessionStore.js');
  const session = await getDashboardSession(sessionIdFromCookieHeader(cookieHeader));
  if (!session) return null;
  return {
    userId: session.userId,
    username: session.username,
    avatar: session.avatar ?? undefined,
    discordToken: session.discordAccessToken,
    sessionCreatedAt: session.createdAt,
  };
};

export type RecruitmentWebhookAuthResult = {
  auth: AuthClaims | null;
  reason: 'ok_jwt' | 'ok_api_key' | 'missing_credentials' | 'invalid_jwt' | 'invalid_api_key' | 'insufficient_permissions';
};

export const verifyRecruitmentWebhookAuth = async (req: Pick<IncomingMessage, 'headers'>, guildId: string): Promise<RecruitmentWebhookAuthResult> => {
  const authHeader = req.headers.authorization;
  let bearerToken: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const claims = jwt.verify(token, getJwtSecret()) as AuthClaims & Record<string, unknown>;
      // Les jetons MCP (OAuth ou lien direct) sont signés avec le même secret quand aucun secret
      // dédié n'est configuré : ils portent un émetteur, une audience ou un `guildId`, qu'un jeton
      // de session n'a jamais. Les accepter ici ouvrirait la route à toute clé MCP, sur tout serveur.
      const isMcpShaped = Boolean(claims.iss || claims.aud || claims.scope || claims.typ || claims.guildId);
      if (isMcpShaped) return { auth: null, reason: 'invalid_jwt' };
      return {
        auth: claims,
        reason: 'ok_jwt',
      };
    } catch {
      // ignore, might be a raw API key passed in Authorization header
      bearerToken = token;
    }
  }

  const apiKey = req.headers['x-kotbo-api-key'] ?? req.headers['x-api-key'] ?? bearerToken;
  const apiKeyValue = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (!apiKeyValue || typeof apiKeyValue !== 'string') {
    return { auth: null, reason: 'missing_credentials' };
  }

  // Try the new recruitment form API key system first
  const { verifyAPIKey: verifyRecruitmentAPIKey } = await import('../../services/staff/recruitmentFormService.js');
  const isValidRecruitmentKey = await verifyRecruitmentAPIKey(apiKeyValue.trim(), guildId);
  
  if (isValidRecruitmentKey) {
    // For recruitment forms, we don't need a specific user - the form itself is authenticated
    return {
      auth: {
        userId: 'recruitment_form',
        username: 'Recruitment Form Webhook',
      },
      reason: 'ok_api_key',
    };
  }

  // Fallback to the old API key system
  const key = await verifyAPIKey(hashAPIKey(apiKeyValue.trim()), guildId);
  if (!key) return { auth: null, reason: 'invalid_api_key' };

  if (!key.permissions || (!key.permissions.includes('recruitment:forms') && !key.permissions.includes('recruitment:manage'))) {
    return { auth: null, reason: 'insufficient_permissions' };
  }

  return {
    auth: {
      userId: key.createdByUserId,
      username: key.name,
    },
    reason: 'ok_api_key',
  };
};

export const getAuditActor = (auth: AuthClaims) => {
  const username = auth.username?.trim();
  if (username) return username;
  return `Utilisateur ${auth.userId.slice(0, 8)}`;
};

export const DISCORD_PERMISSION_ADMINISTRATOR = BigInt(0x8);
export const DISCORD_PERMISSION_MANAGE_GUILD = BigInt(0x20);

export const hasDashboardAdminPermission = (permissions: bigint) => {
  return (permissions & DISCORD_PERMISSION_ADMINISTRATOR) === DISCORD_PERMISSION_ADMINISTRATOR
    || (permissions & DISCORD_PERMISSION_MANAGE_GUILD) === DISCORD_PERMISSION_MANAGE_GUILD;
};

export const DASHBOARD_ACCESS_NONE: DashboardAccess = {
  level: 'none',
  canViewDashboard: false,
  canModerateContent: false,
  canManageSettings: false,
  canManageTutoring: false,
};

export const DASHBOARD_ACCESS_MODERATOR: DashboardAccess = {
  level: 'moderator',
  canViewDashboard: true,
  canModerateContent: true,
  canManageSettings: false,
  canManageTutoring: false,
};

export const DASHBOARD_ACCESS_STAFF_VIEWER: DashboardAccess = {
  level: 'moderator',
  canViewDashboard: true,
  canModerateContent: false,
  canManageSettings: false,
  canManageTutoring: false,
};

export const DASHBOARD_ACCESS_ADMIN: DashboardAccess = {
  level: 'admin',
  canViewDashboard: true,
  canModerateContent: true,
  canManageSettings: true,
  canManageTutoring: true,
};

/**
 * Admin global Kotbo sur un serveur ou il n'est pas deja admin : acces
 * complet, y compris sans etre membre. En contrepartie, chaque ecriture faite
 * avec cet acces part au journal d'audit admin (voir dashboard.ts).
 */
export const DASHBOARD_ACCESS_GLOBAL_ADMIN: DashboardAccess = {
  ...DASHBOARD_ACCESS_ADMIN,
  viaGlobalAdmin: true,
};

/**
 * Duree de vie des droits d'acces en cache.
 *
 * Volontairement courte : un membre retrograde ou exclu conserve ses droits
 * pendant au plus cette duree. En echange, on evite de refaire a chaque requete
 * un `members.fetch()` Discord (aller-retour reseau) plus deux requetes SQL -
 * ce que la liste des serveurs faisait pour CHAQUE guild de l'utilisateur.
 */
const DASHBOARD_ACCESS_TTL_SECONDS = 60;

export const resolveDashboardAccess = async (
  client: Client,
  guildId: string,
  userId: string,
  knownPermissions?: bigint | null,
): Promise<DashboardAccess> => {
  // Requete arrivee par le domaine perso d'un serveur : aucun autre serveur, meme pour un admin global.
  const scoped = scopedGuildId();
  if (scoped && scoped !== guildId) {
    return { level: 'none', canViewDashboard: false, canModerateContent: false, canManageSettings: false, canManageTutoring: false };
  }

  // Le cache n'est utilise que sur le chemin nominal. Quand des permissions
  // sont fournies par l'appelant, le resultat depend d'un parametre supplementaire :
  // on recalcule plutot que de risquer de servir une reponse calculee avec
  // d'autres permissions.
  if (knownPermissions !== null && knownPermissions !== undefined) {
    return computeDashboardAccess(client, guildId, userId, knownPermissions);
  }

  // Prefixe `guild:` afin que `cache.invalidateGuild(guildId)` purge aussi ces
  // entrees.
  const cacheKey = `guild:${guildId}:dashboard-access:${userId}`;

  const cached = await cache.get<DashboardAccess>(cacheKey);
  if (cached) return cached;

  const access = await computeDashboardAccess(client, guildId, userId, knownPermissions);
  await cache.set(cacheKey, access, DASHBOARD_ACCESS_TTL_SECONDS);
  return access;
};

const computeDashboardAccess = async (
  client: Client,
  guildId: string,
  userId: string,
  knownPermissions?: bigint | null,
): Promise<DashboardAccess> => {
  const memberAccess = await computeMemberDashboardAccess(client, guildId, userId, knownPermissions);
  if (memberAccess.level === 'admin') return memberAccess;

  if (await resolveAdminAccess(client, userId)) return DASHBOARD_ACCESS_GLOBAL_ADMIN;

  return memberAccess;
};

const computeMemberDashboardAccess = async (
  client: Client,
  guildId: string,
  userId: string,
  knownPermissions?: bigint | null,
): Promise<DashboardAccess> => {
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { moderatorRoleId: true }
  });

  if (!guildConfig) return DASHBOARD_ACCESS_NONE;

  if (knownPermissions !== null && knownPermissions !== undefined && hasDashboardAdminPermission(knownPermissions)) {
    return DASHBOARD_ACCESS_ADMIN;
  }

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return DASHBOARD_ACCESS_NONE;

  const member = await discordGuild.members.fetch(userId).catch(() => null);
  if (!member) return DASHBOARD_ACCESS_NONE;

  if (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) {
    return DASHBOARD_ACCESS_ADMIN;
  }

  if (guildConfig.moderatorRoleId && member.roles.cache.has(guildConfig.moderatorRoleId)) {
    return DASHBOARD_ACCESS_MODERATOR;
  }

  const staffProfile = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { id: true, isTutor: true },
  });

  if (!staffProfile) {
    return DASHBOARD_ACCESS_NONE;
  }

  if (staffProfile.isTutor) {
    return {
      ...DASHBOARD_ACCESS_MODERATOR,
      canManageTutoring: true,
    };
  }

  return DASHBOARD_ACCESS_STAFF_VIEWER;
};

export async function resolveAdminAccess(client: Client, userId: string): Promise<boolean> {
  if (userId === DISCORD_CLIENT_OWNER_ID) return true;

  // Appele au moins une fois par resolution d'acces, donc une fois par guild
  // lors du listage des serveurs. Meme TTL court que les droits de dashboard.
  const cacheKey = `global:admin-access:${userId}`;

  const cached = await cache.get<boolean>(cacheKey);
  if (cached !== null) return cached;

  const admin = await prisma.globalAdmin.findUnique({
    where: { userId }
  });

  const isAdmin = !!admin;
  await cache.set(cacheKey, isAdmin, DASHBOARD_ACCESS_TTL_SECONDS);
  return isAdmin;
}

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }

  /** Un refus (4xx) est rédigé pour l'utilisateur ; une panne (5xx), non. */
  get expose(): boolean {
    return this.statusCode < 500;
  }
}

// Type par defaut volontaire : sans lui, les appels `readJsonBody(req)` sans
// argument de type renvoyaient `unknown`, et toute lecture de champ devenait
// impossible. Les appelants concernes valident deja chaque champ un a un, donc
// un dictionnaire non type decrit exactement le contrat.
export const readJsonBody = async <T = Record<string, unknown>>(req: IncomingMessage): Promise<T | null> => {
  const contentType = req.headers['content-type'];

  if (!contentType || !contentType.includes('application/json')) {
    throw new HttpError(415, 'Content-Type doit être application/json');
  }

  if (req.bodyText !== undefined) {
    const text = req.bodyText.trim();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      logger.error('readJsonBody', `JSON parse error for URL ${req.url}:`, err);
      throw new HttpError(400, 'Format JSON invalide');
    }
  }

  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const text = buffer.toString('utf-8').trim();
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text) as T);
      } catch (err) {
        reject(new HttpError(400, 'Format JSON invalide'));
      }
    });
    req.on('error', (err) => reject(err));
  });
};


export const truncate = (value?: string | null, length = 160) => {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
};

export const describeUnknownError = (err: unknown) => {
  if (err instanceof Error) {
    return err.message;
  }

  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }

  if (err && typeof err === 'object') {
    const maybeMessage = typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message.trim()
      : '';
    const maybeCode = typeof (err as { code?: unknown }).code === 'string'
      ? ` [${(err as { code: string }).code}]`
      : '';
    const maybeMeta = (err as { meta?: unknown }).meta;
    if (maybeMessage) {
      return `${maybeMessage}${maybeCode}`;
    }
    if (maybeMeta !== undefined) {
      try {
        return `${maybeCode || 'Erreur inconnue'} ${JSON.stringify(maybeMeta)}`.trim();
      } catch {
        return maybeCode || 'Erreur inconnue';
      }
    }
  }

  return 'Erreur lors de la mise à jour de la hiérarchie staff';
};

export const DASHBOARD_CONTENT_EXCERPT_LENGTH = 160;

export const prepareDescriptionForTranslation = (value?: string | null) => {
  if (!value) return '';
  return truncate(value.trim(), DASHBOARD_CONTENT_EXCERPT_LENGTH);
};

export const deleteValidationQueueMessage = async (client: Client, guildId: string, queueMessageId: string | null) => {
  if (!queueMessageId) return;

  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { configChannelId: true }
  });

  if (!guild?.configChannelId) return;

  const channel = await client.channels.fetch(guild.configChannelId).catch(() => null) as TextChannel | null;
  if (!channel) return;

  await channel.messages.delete(queueMessageId).catch(() => null);
};

const DEFAULT_RUNTIME_STATE: RuntimeState = {
  email: '',
  emailEnabled: false,
  cloudBackup: true,
  debugLog: false,
  killSwitchEnabled: false,
  severityByModule: DEFAULT_SEVERITY_BY_MODULE,
  commandRestrictions: [],
  sidebarFavorites: [],
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
};

export const getOrCreateRuntime = async (guildId: string): Promise<RuntimeState> => {
  const { ensureDashboardSchemaPatches } = await import('../../utils/schemaPatches.js');
  await ensureDashboardSchemaPatches();

  try {
    const settings = await upsertRetryingRace(() => prisma.dashboardSettings.upsert({
      where: { guildId },
      update: {},
      create: {
        guildId,
        email: '',
        emailEnabled: false,
        cloudBackup: true,
        debugLog: false,
        killSwitchEnabled: false,
        severityByModule: DEFAULT_SEVERITY_BY_MODULE,
        commandRestrictions: [],
        sidebarFavorites: [],
        messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
      },
    }));

    return toRuntimeState(settings);
  } catch (error) {
    logger.error('Runtime', `getOrCreateRuntime failed for ${guildId}:`, error);
    return { ...DEFAULT_RUNTIME_STATE };
  }
};

/**
 * Personne connectée au dashboard pour la requête en cours. Les routes écrivent
 * le seul pseudo dans le journal : `pushAudit` y joint l'identifiant pour que la
 * page des actions staff affiche le profil complet, comme pour une action Discord.
 */
export const auditActorStore = new AsyncLocalStorage<{ userId: string; username: string | null }>();

const auditUserWithId = (user: string): string => {
  const actor = auditActorStore.getStore();
  return actor && user === (actor.username ?? `User${actor.userId}`) ? `${user} (${actor.userId})` : user;
};

export const pushAudit = async (guildId: string, entry: Omit<AuditEntry, 'id' | 'dateIso' | 'source'>) => {
  await prisma.dashboardAuditLog.create({
    data: {
      guildId,
      channelId: entry.channelId,
      user: auditUserWithId(entry.user),
      action: entry.action,
      context: entry.context,
      module: entry.module,
      eventType: entry.eventType,
      details: entry.details,
      dateIso: new Date()
    }
  });
};

export const safePushAudit = async (guildId: string, entry: Omit<AuditEntry, 'id' | 'dateIso' | 'source'>, context: string) => {
  try {
    await pushAudit(guildId, entry);
  } catch (err) {
    logger.warn('StaffAPI', `Audit log failed during ${context}:`, err);
  }
};

export const GLOBAL_BANNED_WORD_CATEGORIES = new Set([
  'custom',
  'racism',
  'threat',
  'sexual',
  'lgbtphobia',
  'hate',
  'insult',
]);

export const normalizeGlobalBannedWordCategory = (value: unknown): string => {
  if (typeof value !== 'string') return 'custom';
  return GLOBAL_BANNED_WORD_CATEGORIES.has(value) ? value : 'custom';
};

export const normalizeGlobalBannedWord = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().slice(0, 100);
};

export const normalizeGlobalBannedWordKey = (value: string): string => {
  return normalizeGlobalBannedWord(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
};

export const cleanupGlobalBannedWords = async () => {
  const words = await prisma.bannedWord.findMany({
    where: { guildId: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const seen = new Map<string, (typeof words)[number]>();
  const duplicates: string[] = [];

  for (const word of words) {
    const key = normalizeGlobalBannedWordKey(word.word);
    if (!key) continue;

    if (seen.has(key)) {
      duplicates.push(word.id);
      continue;
    }

    seen.set(key, {
      ...word,
      word: normalizeGlobalBannedWord(word.word),
    });
  }

  const updates = Array.from(seen.values()).map((word) => {
    return prisma.bannedWord.update({
      where: { id: word.id },
      data: {
        word: word.word,
      },
    });
  });

  if (duplicates.length > 0) {
    await prisma.bannedWord.deleteMany({ where: { id: { in: duplicates } } });
  }

  await Promise.all(updates);

  return {
    cleanedCount: seen.size,
    duplicateCount: duplicates.length,
    words: await prisma.bannedWord.findMany({
      where: { guildId: null },
      orderBy: [{ word: 'asc' }],
      select: { id: true, word: true, category: true, enabled: true, guildId: true },
    }),
  };
};

export function extractMessageId(details: string): string | null {
  return parseCaseField(details, 'ID');
}

export function extractDiscordSnowflake(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/[^0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

export function parseCaseField(details: string, label: string): string | null {
  const safeLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = details.match(new RegExp(`${safeLabel}:\\s*([^\\n|]+)`, 'i'));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

export function parseInviteFromDetails(details: string): MemberCaseInviteInfo | null {
  const inviteCode = parseCaseField(details, 'Invite utilisée') ?? parseCaseField(details, "Invite d'arrivée");
  const inviter = parseCaseField(details, "Créateur de l'invite");
  const inviterId = parseCaseField(details, 'ID créateur');

  if (!inviteCode && !inviter && !inviterId) return null;

  const inviterMentionMatch = inviter?.match(/<@!?([0-9]+)>/);
  const normalizedInviter = inviter?.replace(/\s*\(<@!?[0-9]+>\)\s*$/, '').trim() || null;

  return {
    code: inviteCode,
    inviterId: inviterId ?? inviterMentionMatch?.[1] ?? null,
    inviterTag: normalizedInviter,
    inviterAvatarUrl: null,
    joinedAt: null,
  };
}

export function extractMessagePreview(details: string): string | null {
  const content = parseCaseField(details, 'Contenu');
  if (!content) return null;
  return content === '_vide_' ? '' : content;
}

export function mapGuildRolePermissions(role: { id: string; name: string; hexColor?: string; permissions?: { toArray: () => string[] } | string[] }, mention: string): DashboardRole {
  const permissions = Array.isArray(role.permissions)
    ? role.permissions
    : typeof role.permissions?.toArray === 'function'
      ? role.permissions.toArray()
      : [];

  return {
    id: role.id,
    name: role.name,
    mention,
    permissions,
    color: role.hexColor,
  };
}

export async function fetchMemberConnections(discordToken?: string | null): Promise<{ connections: Array<{ name: string; type: string; visible: boolean }>; note: string }> {
  if (!discordToken) {
    return {
      connections: [],
      note: 'Connexions indisponibles sans jeton OAuth.',
    };
  }

  try {
    const response = await fetchExternal('https://discord.com/api/users/@me/connections', {
      headers: { Authorization: `Bearer ${discordToken}` },
    });

    if (!response.ok) {
      return {
        connections: [],
        note: 'Connexions non exposées par le jeton OAuth actuel.',
      };
    }

    const payload = await response.json() as Array<{ name?: string; type?: string; visibility?: number }>;
    return {
      connections: Array.isArray(payload)
        ? payload.map((connection) => ({
            name: connection.name ?? 'Inconnue',
            type: connection.type ?? 'inconnue',
            visible: connection.visibility === 1,
          }))
        : [],
      note: 'Connexions récupérées via le scope OAuth connections.',
    };
  } catch {
    return {
      connections: [],
      note: 'Impossible de récupérer les connexions depuis Discord.',
    };
  }
}

export function safeIsoDate(value: unknown, fallback: string | null = null): string | null {
  if (!value) return fallback;
  try {
    const date = value instanceof Date ? value : new Date(typeof value === 'string' || typeof value === 'number' ? value : String(value));
    if (isNaN(date.getTime())) return fallback;
    return date.toISOString();
  } catch {
    return fallback;
  }
}

export const getGuildName = (client: Client, guildId: string) =>
  client.guilds.cache.get(guildId)?.name ?? guildNameCache.get(guildId) ?? `Serveur ${guildId}`;

export const splitPath = (pathname: string) => pathname.split('/').filter(Boolean);

/**
 * Ce qui attend le staff, pour la page d'accueil.
 *
 * Chaque sujet est une file (appels de ban, tickets, candidatures...) ou un
 * defaut de configuration (permission manquante, salon supprime). Le calcul
 * se fait en deux temps :
 *
 * - la partie commune au serveur, identique pour tous les lecteurs, est mise
 *   en cache par serveur. Le repartiteur vide ce cache apres chaque ecriture
 *   du dashboard : trancher un appel le retire de l'accueil aussitot ;
 * - la partie propre au lecteur (ses sanctions sans rapport, ses taches, les
 *   sondages ou il n'a pas vote) est calculee a part, en cache par membre.
 *
 * Le filtrage par droit vient ensuite : un module eteint ne produit rien, et un
 * lecteur ne voit que les sujets des sections qu'il peut ouvrir.
 */
import { PermissionFlagsBits, type Client, type Guild as DiscordGuild } from 'discord.js';
import {
  HOME_TASK_ACCESS,
  MODULE_REGISTRY,
  compareHomeTasks,
  type HomeSetupGap,
  type HomeTask,
  type HomeTaskKey,
  type HomeTaskPreviewItem,
  type HomeTasksData,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { getModuleStates, type ModuleStates } from './moduleGate.js';
import { computeSetupJourney } from './setupJourney.js';

const GUILD_TTL_SECONDS = 30;
const VIEWER_TTL_SECONDS = 30;
const PREVIEW_SIZE = 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Au-dela, un rapport manquant est escalade aux responsables par le bot. */
const REPORT_ESCALATION_MS = 7 * DAY_MS;
/** Sanctions plus anciennes : ignorees, le rattrapage n'a plus de sens. */
const REPORT_WINDOW_MS = 30 * DAY_MS;
const MEETING_HORIZON_MS = 2 * DAY_MS;
const WORKFLOW_FAILURE_WINDOW_MS = DAY_MS;

export type HomeTasksViewer = {
  userId: string;
  canManageSettings: boolean;
  /** Droit de lecture sur une section du dashboard. */
  canView: (featureKey: string) => boolean;
};

// ─────────────────────────── Permissions du bot ───────────────────────────

/**
 * Permissions sans lesquelles des modules echouent sans bruit : une sanction
 * qui ne s'applique pas, un salon de ticket jamais cree, un journal vide.
 */
const REQUIRED_BOT_PERMISSIONS: Array<[bigint, string]> = [
  [PermissionFlagsBits.ViewChannel, 'Voir les salons'],
  [PermissionFlagsBits.SendMessages, 'Envoyer des messages'],
  [PermissionFlagsBits.EmbedLinks, 'Intégrer des liens'],
  [PermissionFlagsBits.AttachFiles, 'Joindre des fichiers'],
  [PermissionFlagsBits.ReadMessageHistory, "Voir l'historique des messages"],
  [PermissionFlagsBits.ManageMessages, 'Gérer les messages'],
  [PermissionFlagsBits.ManageChannels, 'Gérer les salons'],
  [PermissionFlagsBits.ManageRoles, 'Gérer les rôles'],
  [PermissionFlagsBits.ManageNicknames, 'Gérer les pseudos'],
  [PermissionFlagsBits.ManageWebhooks, 'Gérer les webhooks'],
  [PermissionFlagsBits.ViewAuditLog, 'Voir les logs du serveur'],
  [PermissionFlagsBits.KickMembers, 'Expulser des membres'],
  [PermissionFlagsBits.BanMembers, 'Bannir des membres'],
  [PermissionFlagsBits.ModerateMembers, 'Exclure temporairement des membres'],
];

/** Libelles des permissions absentes du champ de bits donne. */
export function missingBotPermissions(bits: bigint): string[] {
  if ((bits & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) return [];
  return REQUIRED_BOT_PERMISSIONS.filter(([flag]) => (bits & flag) !== flag).map(([, label]) => label);
}

// ─────────────────────── Salons et roles supprimes ───────────────────────

type ReferenceKind = 'channel' | 'role';

/**
 * Colonnes de `Guild` qui designent un salon ou un role Discord. Liste tenue a
 * la main : `youtubeChannelId` porte une chaine YouTube, pas un salon, et
 * d'autres colonnes ne servent plus.
 */
const GUILD_REFERENCES = [
  { field: 'logChannelId', kind: 'channel', label: 'Salon de logs', href: '/logs/config' },
  { field: 'sanctionAlertChannelId', kind: 'channel', label: 'Salon des alertes de sanction', href: '/security/sanctions/settings' },
  { field: 'moderatorRoleId', kind: 'role', label: 'Rôle modérateur', href: '/security/sanctions/settings' },
  { field: 'baseStaffRoleId', kind: 'role', label: 'Rôle staff de base', href: '/management/salons' },
  { field: 'chiefStaffRoleId', kind: 'role', label: 'Rôle chef du staff', href: '/management/salons' },
  { field: 'regulationChannelId', kind: 'channel', label: 'Salon du règlement', href: '/regulation' },
  { field: 'regulationRoleId', kind: 'role', label: 'Rôle du règlement', href: '/regulation' },
  { field: 'publicChannelId', kind: 'channel', label: "Salon d'accueil", href: '/announcement/welcome' },
  { field: 'configChannelId', kind: 'channel', label: 'Salon de configuration', href: '/management/salons' },
  { field: 'staffAnnouncementChannelId', kind: 'channel', label: 'Salon des annonces staff', href: '/management/salons' },
  { field: 'meetingAnnouncementChannelId', kind: 'channel', label: 'Salon des annonces de réunion', href: '/planning/meeting' },
  { field: 'meetingVoiceChannelId', kind: 'channel', label: 'Salon vocal des réunions', href: '/planning/meeting' },
  { field: 'eventAnnouncementChannelId', kind: 'channel', label: 'Salon des annonces d’événements', href: '/events' },
  { field: 'newsChannelId', kind: 'channel', label: 'Salon des actualités', href: '/news/configs' },
  { field: 'digestChannelId', kind: 'channel', label: 'Salon du résumé', href: '/management/salons' },
  { field: 'ticketCategoryId', kind: 'channel', label: 'Catégorie des tickets', href: '/tickets/config' },
  { field: 'ticketChannelId', kind: 'channel', label: 'Salon du panneau de tickets', href: '/tickets/config' },
  { field: 'ticketStaffRoleId', kind: 'role', label: 'Rôle staff des tickets', href: '/tickets/config' },
  { field: 'ticketLogChannelId', kind: 'channel', label: 'Salon de logs des tickets', href: '/tickets/config' },
  { field: 'ticketApprovalChannelId', kind: 'channel', label: 'Salon de validation des tickets', href: '/tickets/config' },
  { field: 'ticketArchiveCategoryId', kind: 'channel', label: "Catégorie d'archive des tickets", href: '/tickets/config' },
  { field: 'recruitmentCategoryId', kind: 'channel', label: 'Catégorie du recrutement', href: '/recruitment' },
  { field: 'recruitmentLogChannelId', kind: 'channel', label: 'Salon de logs du recrutement', href: '/recruitment' },
  { field: 'verificationChannelId', kind: 'channel', label: 'Salon de vérification', href: '/security/accounts/verification' },
  { field: 'verificationRoleId', kind: 'role', label: 'Rôle vérifié', href: '/security/accounts/verification' },
  { field: 'verificationLogChannelId', kind: 'channel', label: 'Salon de logs de vérification', href: '/security/accounts/verification' },
  { field: 'tempVoiceChannelId', kind: 'channel', label: 'Salon des vocaux temporaires', href: '/channels-management' },
  { field: 'tempVoiceCategoryId', kind: 'channel', label: 'Catégorie des vocaux temporaires', href: '/channels-management' },
  { field: 'economyChannelId', kind: 'channel', label: "Salon de l'économie", href: '/economy/config' },
  { field: 'dropChannelId', kind: 'channel', label: 'Salon des drops', href: '/drops' },
] as const satisfies ReadonlyArray<{ field: string; kind: ReferenceKind; label: string; href: string }>;

type GuildReferenceField = (typeof GUILD_REFERENCES)[number]['field'];

export type BrokenReference = { id: string; label: string; href: string };

type ReferenceCandidate = { key: string; kind: ReferenceKind; value: string | null | undefined; label: string; href: string };

/** References dont la cible n'existe plus sur le serveur. */
export function findBrokenReferences(
  candidates: ReferenceCandidate[],
  exists: (kind: ReferenceKind, id: string) => boolean,
): BrokenReference[] {
  return candidates
    .filter((candidate) => typeof candidate.value === 'string' && candidate.value.length > 0)
    .filter((candidate) => !exists(candidate.kind, candidate.value as string))
    .map((candidate) => ({ id: candidate.key, label: candidate.label, href: candidate.href }));
}

const GUILD_REFERENCE_SELECT = Object.fromEntries(
  GUILD_REFERENCES.map((reference) => [reference.field, true]),
) as Record<GuildReferenceField, true>;

async function collectBrokenReferences(guildId: string, discordGuild: DiscordGuild, modules: ModuleStates) {
  const [guildRow, featureConfigs] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId }, select: GUILD_REFERENCE_SELECT }),
    prisma.dashboardFeatureConfig.findMany({
      where: { guildId, enabled: true },
      select: {
        featureKey: true,
        channelId: true,
        secondaryChannelId: true,
        requiredRoleId: true,
        notificationRoleId: true,
      },
    }),
  ]);

  const candidates: ReferenceCandidate[] = [];
  if (guildRow) {
    for (const reference of GUILD_REFERENCES) {
      candidates.push({
        key: reference.field,
        kind: reference.kind,
        value: guildRow[reference.field],
        label: reference.label,
        href: reference.href,
      });
    }
  }

  // Les modules eteints gardent leur ligne : un salon supprime depuis ne gene
  // personne tant que le module ne tourne pas.
  const moduleNames = new Map(MODULE_REGISTRY.map((mod) => [mod.key, mod]));
  for (const config of featureConfigs) {
    if (modules[config.featureKey] === false) continue;
    const mod = moduleNames.get(config.featureKey);
    const name = mod?.name ?? config.featureKey;
    const href = `/management/salons`;
    candidates.push(
      { key: `${config.featureKey}:channel`, kind: 'channel', value: config.channelId, label: `${name} · salon`, href },
      { key: `${config.featureKey}:secondary`, kind: 'channel', value: config.secondaryChannelId, label: `${name} · salon secondaire`, href },
      { key: `${config.featureKey}:role`, kind: 'role', value: config.requiredRoleId, label: `${name} · rôle requis`, href },
      { key: `${config.featureKey}:notify`, kind: 'role', value: config.notificationRoleId, label: `${name} · rôle prévenu`, href },
    );
  }

  return findBrokenReferences(candidates, (kind, id) =>
    kind === 'channel' ? discordGuild.channels.cache.has(id) : discordGuild.roles.cache.has(id),
  );
}

// ─────────────────────────────── Files ───────────────────────────────

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function truncate(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function ageMs(oldestAt: string | null | undefined, now: number): number {
  return oldestAt ? now - new Date(oldestAt).getTime() : 0;
}

type Queue = { count: number; oldestAt: string | null; preview: HomeTaskPreviewItem[] };

/** Une file vide ne produit pas de tache : on ne liste que ce qui attend. */
function task(
  key: HomeTaskKey,
  queue: Queue,
  href: string,
  severity: HomeTask['severity'],
): HomeTask | null {
  if (queue.count <= 0) return null;
  return { key, severity, count: queue.count, oldestAt: queue.oldestAt, href, preview: queue.preview };
}

type GuildTaskBuilder = (ctx: { guildId: string; now: number }) => Promise<HomeTask | null>;

const GUILD_TASK_BUILDERS: Partial<Record<HomeTaskKey, GuildTaskBuilder>> = {
  async tickets_pending_validation({ guildId, now }) {
    const where = { guildId, status: 'PENDING' as const };
    const [count, rows] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, username: true, reason: true, createdAt: true },
      }),
    ]);
    const oldestAt = iso(rows[0]?.createdAt);
    return task('tickets_pending_validation', {
      count,
      oldestAt,
      preview: rows.map((row) => ({ id: row.id, label: `${row.username} · ${truncate(row.reason, 40)}`, at: iso(row.createdAt) })),
    }, '/tickets', ageMs(oldestAt, now) > DAY_MS ? 'critical' : 'warning');
  },

  async tickets_unclaimed({ guildId, now }) {
    const where = { guildId, status: 'OPEN' as const, claimedById: null };
    const [count, rows] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, username: true, reason: true, ticketTypeLabel: true, createdAt: true },
      }),
    ]);
    const oldestAt = iso(rows[0]?.createdAt);
    return task('tickets_unclaimed', {
      count,
      oldestAt,
      preview: rows.map((row) => ({
        id: row.id,
        label: `${row.username} · ${truncate(row.ticketTypeLabel || row.reason, 40)}`,
        at: iso(row.createdAt),
      })),
    }, '/tickets', ageMs(oldestAt, now) > DAY_MS ? 'critical' : 'warning');
  },

  async ban_appeals_pending({ guildId, now }) {
    // Un appel en « besoin d'infos » attend le membre, pas le staff - sauf
    // quand le membre a deja repondu.
    const where = {
      guildId,
      OR: [
        { status: 'PENDING' as const },
        { status: 'NEEDS_INFO' as const, infoResponse: { not: null } },
      ],
    };
    const [count, rows] = await Promise.all([
      prisma.banAppeal.count({ where }),
      prisma.banAppeal.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, userId: true, userTag: true, createdAt: true },
      }),
    ]);
    const oldestAt = iso(rows[0]?.createdAt);
    return task('ban_appeals_pending', {
      count,
      oldestAt,
      preview: rows.map((row) => ({ id: row.id, label: row.userTag || row.userId, at: iso(row.createdAt) })),
    }, '/security/sanctions/appeals', ageMs(oldestAt, now) > 7 * DAY_MS ? 'critical' : 'warning');
  },

  async sanction_reports_missing({ guildId, now }) {
    const where = {
      guildId,
      type: { in: ['BAN', 'TEMP_BAN', 'KICK', 'TIMEOUT'] as Array<'BAN' | 'TEMP_BAN' | 'KICK' | 'TIMEOUT'> },
      status: { not: 'FAILED' as const },
      archivedAt: null,
      createdAt: { gte: new Date(now - REPORT_WINDOW_MS) },
      reports: { none: {} },
    };
    const [count, rows] = await Promise.all([
      prisma.sanction.count({ where }),
      prisma.sanction.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, type: true, targetTag: true, targetUserId: true, moderatorTag: true, createdAt: true },
      }),
    ]);
    const oldestAt = iso(rows[0]?.createdAt);
    return task('sanction_reports_missing', {
      count,
      oldestAt,
      preview: rows.map((row) => ({
        id: row.id,
        label: `${row.type} · ${row.targetTag || row.targetUserId}${row.moderatorTag ? ` (par ${row.moderatorTag})` : ''}`,
        at: iso(row.createdAt),
      })),
    }, '/security/sanctions', ageMs(oldestAt, now) > REPORT_ESCALATION_MS ? 'critical' : 'warning');
  },

  async admin_requests_pending({ guildId }) {
    const where = { guildId, status: 'PENDING' as const };
    const [count, rows] = await Promise.all([
      prisma.adminPermissionRequest.count({ where }),
      prisma.adminPermissionRequest.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, requestedByTag: true, requestedByUserId: true, targetRoleName: true, createdAt: true },
      }),
    ]);
    return task('admin_requests_pending', {
      count,
      oldestAt: iso(rows[0]?.createdAt),
      preview: rows.map((row) => ({
        id: row.id,
        label: `${row.requestedByTag || row.requestedByUserId}${row.targetRoleName ? ` · ${row.targetRoleName}` : ''}`,
        at: iso(row.createdAt),
      })),
    }, '/security/sanctions/admin-approval', 'critical');
  },

  async alt_detections({ guildId }) {
    // Un suspect parti du serveur ne demande plus de decision.
    const where = { guildId, isSuspectedDC: true, guildLeftAt: null };
    const [count, rows] = await Promise.all([
      prisma.memberProfile.count({ where }),
      prisma.memberProfile.findMany({
        where,
        orderBy: { lastDcAlertAt: 'desc' },
        take: PREVIEW_SIZE,
        select: { userId: true, username: true, displayName: true, lastDcAlertAt: true },
      }),
    ]);
    return task('alt_detections', {
      count,
      oldestAt: null,
      preview: rows.map((row) => ({
        id: row.userId,
        label: row.displayName || row.username || row.userId,
        at: iso(row.lastDcAlertAt),
      })),
    }, '/security/accounts/detections', 'warning');
  },

  async alt_links_pending({ guildId }) {
    const where = { guildId, status: 'PENDING' as const };
    const [count, oldest] = await Promise.all([
      prisma.linkedAccount.count({ where }),
      prisma.linkedAccount.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return task('alt_links_pending', { count, oldestAt: iso(oldest?.createdAt), preview: [] }, '/security/accounts/links', 'warning');
  },

  async absences_pending({ guildId }) {
    const where = { guildId, status: 'PENDING' as const, isVoid: false };
    const [count, rows] = await Promise.all([
      prisma.staffAbsence.count({ where }),
      prisma.staffAbsence.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: {
          id: true,
          startDate: true,
          createdAt: true,
          staffMember: { select: { displayName: true, username: true, userId: true } },
        },
      }),
    ]);
    return task('absences_pending', {
      count,
      oldestAt: iso(rows[0]?.createdAt),
      preview: rows.map((row) => ({
        id: row.id,
        label: row.staffMember.displayName || row.staffMember.username || row.staffMember.userId,
        at: iso(row.startDate),
      })),
    }, '/planning/absence', 'warning');
  },

  async meetings_upcoming({ guildId, now }) {
    const where = {
      guildId,
      status: 'SCHEDULED' as const,
      scheduledAt: { gte: new Date(now), lte: new Date(now + MEETING_HORIZON_MS) },
    };
    const [count, rows] = await Promise.all([
      prisma.staffMeeting.count({ where }),
      prisma.staffMeeting.findMany({
        where,
        orderBy: { scheduledAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, title: true, scheduledAt: true },
      }),
    ]);
    // Pas d'anciennete ici : c'est une echeance, pas une attente.
    return task('meetings_upcoming', {
      count,
      oldestAt: null,
      preview: rows.map((row) => ({ id: row.id, label: truncate(row.title), at: iso(row.scheduledAt) })),
    }, '/planning/meeting', rows.some((row) => row.scheduledAt.getTime() - now < 2 * HOUR_MS) ? 'warning' : 'info');
  },

  async recruitment_pending({ guildId, now }) {
    const where = { guildId, status: 'PENDING' as const };
    const [count, rows] = await Promise.all([
      prisma.recruitmentCandidature.count({ where }),
      prisma.recruitmentCandidature.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, username: true, discordId: true, createdAt: true },
      }),
    ]);
    const oldestAt = iso(rows[0]?.createdAt);
    return task('recruitment_pending', {
      count,
      oldestAt,
      preview: rows.map((row) => ({ id: row.id, label: row.username || row.discordId || '—', at: iso(row.createdAt) })),
    }, '/recruitment', ageMs(oldestAt, now) > 3 * DAY_MS ? 'warning' : 'info');
  },

  async suggestions_pending({ guildId }) {
    const where = { guildId, status: 'PENDING' };
    const [count, rows] = await Promise.all([
      prisma.suggestion.count({ where }),
      prisma.suggestion.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, content: true, createdAt: true },
      }),
    ]);
    return task('suggestions_pending', {
      count,
      oldestAt: iso(rows[0]?.createdAt),
      preview: rows.map((row) => ({ id: row.id, label: truncate(row.content), at: iso(row.createdAt) })),
    }, '/suggestions', 'info');
  },

  async channel_health_alerts({ guildId }) {
    const where = { guildId, status: 'PENDING' as const };
    const [count, rows] = await Promise.all([
      prisma.channelHealthAlert.count({ where }),
      prisma.channelHealthAlert.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: PREVIEW_SIZE,
        select: { id: true, channelId: true, channelName: true, createdAt: true },
      }),
    ]);
    return task('channel_health_alerts', {
      count,
      oldestAt: iso(rows[0]?.createdAt),
      preview: rows.map((row) => ({ id: row.id, label: `#${row.channelName || row.channelId}`, at: iso(row.createdAt) })),
    }, '/channel-health/alerts', 'info');
  },

  async workflow_failures({ guildId, now }) {
    const where = { guildId, status: 'FAILED', startedAt: { gte: new Date(now - WORKFLOW_FAILURE_WINDOW_MS) } };
    const [count, rows] = await Promise.all([
      prisma.workflowExecution.count({ where }),
      prisma.workflowExecution.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: PREVIEW_SIZE,
        select: { id: true, startedAt: true, workflow: { select: { name: true } } },
      }),
    ]);
    return task('workflow_failures', {
      count,
      oldestAt: null,
      preview: rows.map((row) => ({ id: row.id, label: truncate(row.workflow.name), at: iso(row.startedAt) })),
    }, '/workflows', 'warning');
  },
};

type GuildSnapshot = {
  tasks: HomeTask[];
  setup: HomeTasksData['setup'];
};

async function buildGuildSnapshot(client: Client, guildId: string, modules: ModuleStates): Promise<GuildSnapshot> {
  const now = Date.now();
  const builders = (Object.entries(GUILD_TASK_BUILDERS) as Array<[HomeTaskKey, GuildTaskBuilder]>)
    .filter(([key]) => {
      const moduleKey = HOME_TASK_ACCESS[key].module;
      return !moduleKey || modules[moduleKey] !== false;
    });

  const discordGuild = client.guilds.cache.get(guildId) ?? null;

  const [queueResults, broken, journey] = await Promise.all([
    Promise.allSettled(builders.map(([, build]) => build({ guildId, now }))),
    discordGuild ? collectBrokenReferences(guildId, discordGuild, modules).catch((err) => {
      logger.error('HomeTasks', `Verification des references impossible pour ${guildId}:`, err);
      return [] as BrokenReference[];
    }) : Promise.resolve([] as BrokenReference[]),
    computeSetupJourney(guildId).catch((err) => {
      logger.error('HomeTasks', `Parcours de configuration indisponible pour ${guildId}:`, err);
      return null;
    }),
  ]);

  const tasks: HomeTask[] = [];

  // Une file qui echoue ne doit pas vider l'accueil : les autres restent.
  queueResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value) tasks.push(result.value);
    } else {
      logger.error('HomeTasks', `Sujet ${builders[index][0]} indisponible:`, result.reason);
    }
  });

  if (discordGuild?.members.me) {
    const missing = missingBotPermissions(discordGuild.members.me.permissions.bitfield);
    if (missing.length > 0) {
      tasks.push({
        key: 'bot_permissions',
        severity: 'critical',
        count: missing.length,
        href: '/security',
        preview: missing.map((label) => ({ id: label, label })),
      });
    }
  }

  if (broken.length > 0) {
    tasks.push({
      key: 'broken_references',
      severity: 'critical',
      count: broken.length,
      href: broken[0].href,
      preview: broken.map((reference) => ({ id: reference.id, label: reference.label })),
    });
  }

  // Le fuseau a une valeur par defaut : il n'est jamais un trou reel.
  const setup = journey
    ? {
        done: journey.progress.done,
        total: journey.progress.total,
        missing: journey.steps
          .filter((step) => !step.done && step.key !== 'timezone')
          .map<HomeSetupGap>((step) => ({ key: step.key, label: step.label, href: step.href, detail: step.detail, why: step.why })),
      }
    : null;

  return { tasks, setup };
}

// ─────────────────────────── Part du lecteur ───────────────────────────

type ViewerExtras = {
  /** Sanctions du lecteur encore sans rapport. */
  reportsMine: number;
  tasks: HomeTask[];
};

async function buildViewerExtras(guildId: string, userId: string, modules: ModuleStates): Promise<ViewerExtras> {
  const now = Date.now();
  const staffMember = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { id: true },
  });

  const [reportsMine, openTasks, unvotedPolls] = await Promise.all([
    modules.sanctions === false
      ? Promise.resolve(0)
      : prisma.sanction.count({
          where: {
            guildId,
            moderatorUserId: userId,
            type: { in: ['BAN', 'TEMP_BAN', 'KICK', 'TIMEOUT'] },
            status: { not: 'FAILED' },
            archivedAt: null,
            createdAt: { gte: new Date(now - REPORT_WINDOW_MS) },
            reports: { none: {} },
          },
        }),
    staffMember && modules.absences !== false
      ? prisma.staffTask.findMany({
          where: { guildId, assigneeId: staffMember.id, status: { not: 'COMPLETED' } },
          // Les taches datees d'abord, de la plus pressante a la moins pressante.
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
          take: 50,
          select: { id: true, title: true, dueDate: true },
        })
      : Promise.resolve([]),
    staffMember && modules.polls !== false
      ? prisma.staffPoll.findMany({
          where: { guildId, status: 'OPEN', votes: { none: { staffUserId: staffMember.id } } },
          orderBy: [{ closesAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
          take: 20,
          select: { id: true, title: true, closesAt: true },
        })
      : Promise.resolve([]),
  ]);

  const tasks: HomeTask[] = [];

  if (openTasks.length > 0) {
    const overdue = openTasks.some((row) => row.dueDate && row.dueDate.getTime() < now);
    tasks.push({
      key: 'staff_tasks_mine',
      severity: overdue ? 'warning' : 'info',
      count: openTasks.length,
      mine: openTasks.length,
      href: '/planning/task',
      preview: openTasks.slice(0, PREVIEW_SIZE).map((row) => ({ id: row.id, label: truncate(row.title), at: iso(row.dueDate) })),
    });
  }

  if (unvotedPolls.length > 0) {
    tasks.push({
      key: 'polls_unvoted',
      severity: 'info',
      count: unvotedPolls.length,
      mine: unvotedPolls.length,
      href: '/staff-management/polls',
      preview: unvotedPolls.slice(0, PREVIEW_SIZE).map((row) => ({ id: row.id, label: truncate(row.title), at: iso(row.closesAt) })),
    });
  }

  return { reportsMine, tasks };
}

// ───────────────────────────── Assemblage ─────────────────────────────

export function isTaskVisible(key: HomeTaskKey, viewer: HomeTasksViewer): boolean {
  const rule = HOME_TASK_ACCESS[key];
  if (rule.adminOnly) return viewer.canManageSettings;
  if (!rule.module || viewer.canManageSettings) return true;
  return viewer.canView(rule.module);
}

export async function buildHomeTasks(client: Client, guildId: string, viewer: HomeTasksViewer): Promise<HomeTasksData> {
  const modules = await getModuleStates(guildId);

  const [snapshot, extras] = await Promise.all([
    cache.wrap(`guild:${guildId}:home-tasks`, GUILD_TTL_SECONDS, () => buildGuildSnapshot(client, guildId, modules)),
    cache.wrap(`guild:${guildId}:home-tasks:${viewer.userId}`, VIEWER_TTL_SECONDS, () =>
      buildViewerExtras(guildId, viewer.userId, modules),
    ),
  ]);

  const tasks = [...snapshot.tasks, ...extras.tasks]
    .filter((item) => isTaskVisible(item.key, viewer))
    .map((item) => (item.key === 'sanction_reports_missing' && extras.reportsMine > 0 ? { ...item, mine: extras.reportsMine } : item))
    .sort(compareHomeTasks);

  return {
    tasks,
    setup: viewer.canManageSettings && snapshot.setup && snapshot.setup.missing.length > 0 ? snapshot.setup : null,
    generatedAt: new Date().toISOString(),
  };
}

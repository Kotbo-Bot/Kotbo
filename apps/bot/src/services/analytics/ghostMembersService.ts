import { Client, Guild, GuildMember, PermissionsBitField } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { UserFacingError } from '../../utils/userFacingError.js';

/**
 * Ghost Members Analyzer - audit de présence silencieuse.
 *
 * Distingue les comptes réellement abandonnés des « membres spectateurs » qui
 * lisent, écoutent en vocal ou réagissent sans jamais écrire, afin qu'un
 * nettoyage du serveur n'expulse pas une audience fidèle mais discrète.
 */

export type GhostStatus = 'ACTIVE' | 'SPECTATOR' | 'INACTIVE' | 'NEW';

export const GHOST_STATUSES: readonly GhostStatus[] = ['ACTIVE', 'SPECTATOR', 'INACTIVE', 'NEW'] as const;

/** Statuts qu'un prunage peut légitimement viser. */
export const PRUNABLE_STATUSES: readonly GhostStatus[] = ['INACTIVE', 'SPECTATOR'] as const;

export interface GhostConfig {
  guildId: string;
  enabled: boolean;
  inactiveDays: number;
  spectatorWindowDays: number;
  gracePeriodDays: number;
  protectStaff: boolean;
  protectBoosters: boolean;
  protectedRoleIds: string[];
  maxPruneBatch: number;
  pruneReason: string;
  lastComputedAt: Date | null;
}

export const DEFAULT_GHOST_CONFIG: Omit<GhostConfig, 'guildId' | 'lastComputedAt'> = {
  enabled: false,
  inactiveDays: 60,
  spectatorWindowDays: 30,
  gracePeriodDays: 30,
  protectStaff: true,
  protectBoosters: true,
  protectedRoleIds: [],
  maxPruneBatch: 50,
  pruneReason: 'Nettoyage des membres inactifs',
};

/** Bornes de sécurité sur les seuils réglables depuis le dashboard. */
const CONFIG_BOUNDS = {
  inactiveDays: { min: 7, max: 730 },
  spectatorWindowDays: { min: 1, max: 365 },
  gracePeriodDays: { min: 0, max: 365 },
  maxPruneBatch: { min: 1, max: 500 },
} as const;

/** Plafond dur sur le nombre de candidats analysés en une passe de prévisualisation. */
const PREVIEW_HARD_CAP = 1_000;

/** Délai entre deux expulsions, pour rester loin des limites de débit Discord. */
const KICK_DELAY_MS = 350;

const MS_PER_DAY = 86_400_000;

// ============================================================================
// CLASSIFICATION (logique pure, testable sans base ni Discord)
// ============================================================================

/** Signaux d'activité bruts nécessaires à la classification d'un membre. */
export interface GhostActivityInput {
  guildJoinedAt?: Date | null;
  firstSeenAt?: Date | null;
  lastMessageAt?: Date | null;
  voiceLastJoinedAt?: Date | null;
  voiceLastLeftAt?: Date | null;
  lastReactionAt?: Date | null;
  lastDashboardLoginAt?: Date | null;
}

export type GhostThresholds = Pick<
  GhostConfig,
  'inactiveDays' | 'spectatorWindowDays' | 'gracePeriodDays'
>;

function latest(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (!date) continue;
    const time = date.getTime();
    if (Number.isNaN(time)) continue;
    if (!best || time > best.getTime()) best = date;
  }
  return best;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

/**
 * Dernière activité « silencieuse » : vocal, réaction ou connexion au
 * dashboard. C'est ce signal qui sépare un spectateur d'un compte abandonné.
 */
export function resolveLastSilentActivity(input: GhostActivityInput): Date | null {
  return latest(
    input.voiceLastJoinedAt,
    input.voiceLastLeftAt,
    input.lastReactionAt,
    input.lastDashboardLoginAt,
  );
}

/** Dernière activité tous canaux confondus, texte inclus. */
export function resolveLastAnyActivity(input: GhostActivityInput): Date | null {
  return latest(input.lastMessageAt, resolveLastSilentActivity(input));
}

/**
 * Attribue un statut d'invisibilité à un membre.
 *
 * L'ordre d'évaluation est volontairement strict :
 *  1. `NEW`       - arrivé pendant la période de grâce, jamais expulsable.
 *  2. `ACTIVE`    - a écrit récemment.
 *  3. `SPECTATOR` - muet, mais présent en vocal / en réactions récemment.
 *  4. `INACTIVE`  - aucun signal, sur aucun canal.
 */
export function classifyGhostStatus(
  input: GhostActivityInput,
  thresholds: GhostThresholds,
  now: Date = new Date(),
): GhostStatus {
  const joinedAt = input.guildJoinedAt ?? input.firstSeenAt ?? null;
  if (joinedAt && daysBetween(joinedAt, now) < thresholds.gracePeriodDays) {
    return 'NEW';
  }

  if (input.lastMessageAt && daysBetween(input.lastMessageAt, now) <= thresholds.inactiveDays) {
    return 'ACTIVE';
  }

  const lastSilent = resolveLastSilentActivity(input);
  if (lastSilent && daysBetween(lastSilent, now) <= thresholds.spectatorWindowDays) {
    return 'SPECTATOR';
  }

  return 'INACTIVE';
}

/**
 * Score d'invisibilité 0-100 : 0 = pleinement actif, 100 = aucune trace.
 * Sert uniquement au tri et aux graphiques ; la décision d'expulsion repose
 * sur le statut, pas sur ce score.
 */
export function computeGhostScore(
  input: GhostActivityInput,
  thresholds: GhostThresholds,
  now: Date = new Date(),
): number {
  const lastAny = resolveLastAnyActivity(input);
  if (!lastAny) return 100;

  const idleDays = Math.max(0, daysBetween(lastAny, now));
  const ratio = idleDays / Math.max(1, thresholds.inactiveDays);
  return Math.round(Math.min(1, ratio) * 100);
}

// ============================================================================
// CONFIGURATION
// ============================================================================

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}

/**
 * Valide et borne un patch de configuration venant du dashboard.
 * Les champs absents ou de type invalide sont ignorés silencieusement.
 */
export function sanitizeGhostConfigPatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.protectStaff === 'boolean') patch.protectStaff = body.protectStaff;
  if (typeof body.protectBoosters === 'boolean') patch.protectBoosters = body.protectBoosters;

  for (const key of ['inactiveDays', 'spectatorWindowDays', 'gracePeriodDays', 'maxPruneBatch'] as const) {
    const raw = body[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      patch[key] = clamp(raw, CONFIG_BOUNDS[key]);
    }
  }

  if (Array.isArray(body.protectedRoleIds)) {
    patch.protectedRoleIds = body.protectedRoleIds
      .filter((id): id is string => typeof id === 'string' && /^\d{5,25}$/.test(id))
      .slice(0, 50);
  }

  if (typeof body.pruneReason === 'string') {
    const reason = body.pruneReason.trim().slice(0, 400);
    if (reason.length > 0) patch.pruneReason = reason;
  }

  return patch;
}

export async function getGhostConfig(guildId: string): Promise<GhostConfig> {
  const config = await prisma.ghostAnalyzerConfig.findUnique({ where: { guildId } });
  if (config) return config as GhostConfig;
  return { guildId, ...DEFAULT_GHOST_CONFIG, lastComputedAt: null };
}

export async function upsertGhostConfig(
  guildId: string,
  patch: Record<string, unknown>,
): Promise<GhostConfig> {
  const config = await prisma.ghostAnalyzerConfig.upsert({
    where: { guildId },
    create: { guildId, ...DEFAULT_GHOST_CONFIG, ...patch },
    update: patch,
  });
  return config as GhostConfig;
}

// ============================================================================
// GARDE-FOUS
// ============================================================================

export type ProtectionReason = 'STAFF' | 'BOOSTER' | 'PROTECTED_ROLE' | 'GRACE_PERIOD' | 'BOT';

export interface GuildProtectionContext {
  protectStaff: boolean;
  protectBoosters: boolean;
  /** Rôles protégés configurés + rôles Discord rattachés à la hiérarchie staff */
  protectedRoleIds: Set<string>;
  staffRoleIds: Set<string>;
  staffUserIds: Set<string>;
}

/**
 * Rassemble tout ce qui permet de dire « ce membre ne doit jamais apparaître
 * comme expulsable » : rôles staff déclarés, membres staff enregistrés et rôles
 * protégés choisis par l'administrateur.
 */
export async function buildProtectionContext(
  guildId: string,
  config: GhostConfig,
): Promise<GuildProtectionContext> {
  const [staffRoles, staffMembers] = await Promise.all([
    config.protectStaff
      ? prisma.staffRole.findMany({
        where: { guildId, enabled: true, discordRoleId: { not: null } },
        select: { discordRoleId: true },
      })
      : Promise.resolve([]),
    config.protectStaff
      ? prisma.staffMember.findMany({ where: { guildId }, select: { userId: true } })
      : Promise.resolve([]),
  ]);

  return {
    protectStaff: config.protectStaff,
    protectBoosters: config.protectBoosters,
    protectedRoleIds: new Set(config.protectedRoleIds),
    staffRoleIds: new Set(
      staffRoles.map((r) => r.discordRoleId).filter((id): id is string => Boolean(id)),
    ),
    staffUserIds: new Set(staffMembers.map((m) => m.userId)),
  };
}

/**
 * Retourne la liste des raisons pour lesquelles un membre est protégé.
 * Un tableau vide signifie qu'il peut être proposé à l'expulsion.
 */
export function resolveProtections(
  member: GuildMember,
  context: GuildProtectionContext,
): ProtectionReason[] {
  const reasons: ProtectionReason[] = [];

  if (member.user.bot) reasons.push('BOT');

  if (context.protectBoosters && member.premiumSince) {
    reasons.push('BOOSTER');
  }

  if (context.protectStaff) {
    const hasStaffRole = member.roles.cache.some((role) => context.staffRoleIds.has(role.id));
    const canModerate = member.permissions.has(PermissionsBitField.Flags.ModerateMembers)
      || member.permissions.has(PermissionsBitField.Flags.KickMembers)
      || member.permissions.has(PermissionsBitField.Flags.BanMembers)
      || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    if (hasStaffRole || canModerate || context.staffUserIds.has(member.id)) {
      reasons.push('STAFF');
    }
  }

  if (context.protectedRoleIds.size > 0
    && member.roles.cache.some((role) => context.protectedRoleIds.has(role.id))) {
    reasons.push('PROTECTED_ROLE');
  }

  return reasons;
}

// ============================================================================
// CALCUL & RESTITUTION
// ============================================================================

interface ProfileRow {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  guildJoinedAt: Date | null;
  firstSeenAt: Date | null;
  lastMessageAt: Date | null;
  voiceLastJoinedAt: Date | null;
  voiceLastLeftAt: Date | null;
  lastReactionAt: Date | null;
  lastDashboardLoginAt: Date | null;
  messageCount: number;
  voiceTimeSeconds: number;
  interactionCount: number;
  ghostStatus: string | null;
}

const PROFILE_SELECT = {
  userId: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  guildJoinedAt: true,
  firstSeenAt: true,
  lastMessageAt: true,
  voiceLastJoinedAt: true,
  voiceLastLeftAt: true,
  lastReactionAt: true,
  lastDashboardLoginAt: true,
  messageCount: true,
  voiceTimeSeconds: true,
  interactionCount: true,
  ghostStatus: true,
} as const;

/**
 * Recalcule et persiste le statut de tous les membres d'un serveur.
 * Les membres partageant le même statut sont regroupés en un seul `updateMany`.
 */
export async function recomputeGhostStatuses(guildId: string): Promise<Record<GhostStatus, number>> {
  const config = await getGhostConfig(guildId);
  const now = new Date();

  const profiles = await prisma.memberProfile.findMany({
    where: { guildId, isBot: false, guildLeftAt: null },
    select: PROFILE_SELECT,
  });

  const buckets: Record<GhostStatus, string[]> = { ACTIVE: [], SPECTATOR: [], INACTIVE: [], NEW: [] };
  for (const profile of profiles) {
    buckets[classifyGhostStatus(profile, config, now)].push(profile.userId);
  }

  for (const status of GHOST_STATUSES) {
    const userIds = buckets[status];
    if (userIds.length === 0) continue;
    // Découpage pour éviter des clauses IN démesurées sur les gros serveurs
    for (let i = 0; i < userIds.length; i += 1_000) {
      await prisma.memberProfile.updateMany({
        where: { guildId, userId: { in: userIds.slice(i, i + 1_000) } },
        data: { ghostStatus: status, ghostComputedAt: now },
      });
    }
  }

  await upsertGhostConfig(guildId, { lastComputedAt: now });

  const counts = {
    ACTIVE: buckets.ACTIVE.length,
    SPECTATOR: buckets.SPECTATOR.length,
    INACTIVE: buckets.INACTIVE.length,
    NEW: buckets.NEW.length,
  };
  logger.info('GhostAnalyzer', `Statuts recalculés pour ${guildId}: ${JSON.stringify(counts)}`);
  return counts;
}

export interface GhostMemberRow {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: GhostStatus;
  ghostScore: number;
  joinedAt: Date | null;
  lastMessageAt: Date | null;
  lastSilentActivityAt: Date | null;
  lastAnyActivityAt: Date | null;
  messageCount: number;
  voiceTimeSeconds: number;
  interactionCount: number;
  protections: ProtectionReason[];
  /** false si le membre a quitté le serveur ou n'est plus résolvable */
  stillInGuild: boolean;
}

function toRow(
  profile: ProfileRow,
  config: GhostConfig,
  now: Date,
  member: GuildMember | null,
  context: GuildProtectionContext,
): GhostMemberRow {
  const status = classifyGhostStatus(profile, config, now);
  const protections = member ? resolveProtections(member, context) : [];
  if (status === 'NEW' && !protections.includes('GRACE_PERIOD')) {
    protections.push('GRACE_PERIOD');
  }

  return {
    userId: profile.userId,
    username: profile.username ?? 'Inconnu',
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    status,
    ghostScore: computeGhostScore(profile, config, now),
    joinedAt: profile.guildJoinedAt ?? profile.firstSeenAt,
    lastMessageAt: profile.lastMessageAt,
    lastSilentActivityAt: resolveLastSilentActivity(profile),
    lastAnyActivityAt: resolveLastAnyActivity(profile),
    messageCount: profile.messageCount,
    voiceTimeSeconds: profile.voiceTimeSeconds,
    interactionCount: profile.interactionCount,
    protections,
    stillInGuild: Boolean(member),
  };
}

/**
 * Résout les membres Discord d'une page de résultats, en s'appuyant sur le
 * cache et en ne déclenchant un fetch que pour les absents.
 */
async function resolveMembers(guild: Guild, userIds: string[]): Promise<Map<string, GuildMember>> {
  const resolved = new Map<string, GuildMember>();
  const missing: string[] = [];

  for (const userId of userIds) {
    const cached = guild.members.cache.get(userId);
    if (cached) resolved.set(userId, cached);
    else missing.push(userId);
  }

  if (missing.length > 0) {
    try {
      const fetched = await guild.members.fetch({ user: missing });
      for (const [id, member] of fetched) resolved.set(id, member);
    } catch (error) {
      logger.debug('GhostAnalyzer', `Résolution partielle des membres de ${guild.id}: ${String(error)}`);
    }
  }

  return resolved;
}

export interface ListGhostMembersOptions {
  status?: GhostStatus;
  /** Masque les membres protégés (utile pour préparer un prunage) */
  onlyPrunable?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface ListGhostMembersResult {
  members: GhostMemberRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listGhostMembers(
  client: Client,
  guildId: string,
  options: ListGhostMembersOptions = {},
): Promise<ListGhostMembersResult> {
  const config = await getGhostConfig(guildId);
  const now = new Date();
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? 50)));

  const where: Record<string, unknown> = { guildId, isBot: false, guildLeftAt: null };
  if (options.status) where.ghostStatus = options.status;
  if (options.search) {
    const search = options.search.trim().slice(0, 100);
    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { userId: { contains: search } },
      ];
    }
  }

  const [profiles, total] = await Promise.all([
    prisma.memberProfile.findMany({
      where,
      select: PROFILE_SELECT,
      orderBy: [{ lastMessageAt: 'asc' }, { lastSeenAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.memberProfile.count({ where }),
  ]);

  const guild = client.guilds.cache.get(guildId) ?? null;
  const context = await buildProtectionContext(guildId, config);
  const members = guild
    ? await resolveMembers(guild, profiles.map((p) => p.userId))
    : new Map<string, GuildMember>();

  let rows = profiles.map((profile) =>
    toRow(profile, config, now, members.get(profile.userId) ?? null, context));

  if (options.onlyPrunable) {
    rows = rows.filter((row) => row.protections.length === 0 && row.stillInGuild);
  }

  return { members: rows, total, page, pageSize };
}

export interface GhostDistribution {
  counts: Record<GhostStatus, number>;
  total: number;
  lastComputedAt: Date | null;
}

/**
 * Répartition de la communauté par statut.
 *
 * Volontairement limitée à une agrégation SQL : le nombre de membres protégés
 * demanderait de résoudre chaque membre côté Discord, ce que seule la
 * prévisualisation de prunage fait, au moment où l'information sert vraiment.
 */
export async function getGhostDistribution(guildId: string): Promise<GhostDistribution> {
  const config = await getGhostConfig(guildId);

  const grouped = await prisma.memberProfile.groupBy({
    by: ['ghostStatus'],
    where: { guildId, isBot: false, guildLeftAt: null },
    _count: { _all: true },
  });

  const counts: Record<GhostStatus, number> = { ACTIVE: 0, SPECTATOR: 0, INACTIVE: 0, NEW: 0 };
  let total = 0;
  for (const row of grouped) {
    total += row._count._all;
    const status = row.ghostStatus as GhostStatus | null;
    if (status && status in counts) counts[status] += row._count._all;
  }

  return { counts, total, lastComputedAt: config.lastComputedAt };
}

// ============================================================================
// PRUNAGE
// ============================================================================

export interface PreviewGhostPruneOptions {
  statuses?: GhostStatus[];
}

export interface GhostPrunePreview {
  candidates: GhostMemberRow[];
  /** Membres du bon statut mais écartés par un garde-fou */
  protectedCount: number;
  /** Membres analysés, tous statuts visés confondus */
  analyzedCount: number;
  /** true si le plafond d'analyse a été atteint */
  truncated: boolean;
  maxPruneBatch: number;
  config: GhostConfig;
}

/**
 * Calcule la liste exacte des membres qui seraient expulsés, garde-fous
 * appliqués. Aucune écriture, aucune action Discord.
 */
export async function previewGhostPrune(
  client: Client,
  guildId: string,
  options: PreviewGhostPruneOptions = {},
): Promise<GhostPrunePreview> {
  const config = await getGhostConfig(guildId);
  const now = new Date();

  const statuses = (options.statuses ?? ['INACTIVE'])
    .filter((status): status is GhostStatus => PRUNABLE_STATUSES.includes(status));
  if (statuses.length === 0) {
    return {
      candidates: [],
      protectedCount: 0,
      analyzedCount: 0,
      truncated: false,
      maxPruneBatch: config.maxPruneBatch,
      config,
    };
  }

  const profiles = await prisma.memberProfile.findMany({
    where: { guildId, isBot: false, guildLeftAt: null, ghostStatus: { in: statuses } },
    select: PROFILE_SELECT,
    orderBy: [{ lastMessageAt: 'asc' }, { lastSeenAt: 'asc' }],
    take: PREVIEW_HARD_CAP + 1,
  });

  const truncated = profiles.length > PREVIEW_HARD_CAP;
  const analyzed = truncated ? profiles.slice(0, PREVIEW_HARD_CAP) : profiles;

  const guild = client.guilds.cache.get(guildId) ?? null;
  const context = await buildProtectionContext(guildId, config);
  const members = guild
    ? await resolveMembers(guild, analyzed.map((p) => p.userId))
    : new Map<string, GuildMember>();

  const rows = analyzed.map((profile) =>
    toRow(profile, config, now, members.get(profile.userId) ?? null, context));

  const eligible = rows.filter((row) => row.stillInGuild && row.protections.length === 0);

  return {
    candidates: eligible.slice(0, config.maxPruneBatch),
    protectedCount: rows.length - eligible.length,
    analyzedCount: rows.length,
    truncated,
    maxPruneBatch: config.maxPruneBatch,
    config,
  };
}

export interface ExecuteGhostPruneOptions {
  statuses?: GhostStatus[];
  /** Liste explicite validée par l'administrateur à l'étape de prévisualisation */
  userIds: string[];
  /** Doit égaler userIds.length : seconde étape de confirmation */
  confirmCount: number;
  reason?: string;
}

export interface GhostPruneResult {
  runId: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  totalTargeted: number;
  successCount: number;
  failureCount: number;
  failures: { userId: string; username: string; error: string }[];
}

export class GhostPruneValidationError extends UserFacingError {
  constructor(message: string) {
    super(message);
    this.name = 'GhostPruneValidationError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Expulse les membres explicitement confirmés par l'administrateur.
 *
 * La liste transmise est systématiquement recroisée avec une prévisualisation
 * fraîche : un membre redevenu actif, protégé entre-temps ou absent de la
 * prévisualisation ne peut pas être expulsé, même si son identifiant figure
 * dans la requête.
 */
export async function executeGhostPrune(
  client: Client,
  guildId: string,
  options: ExecuteGhostPruneOptions,
  executor: { userId: string; username: string },
): Promise<GhostPruneResult> {
  const requested = [...new Set(options.userIds ?? [])];

  if (requested.length === 0) {
    throw new GhostPruneValidationError('Aucun membre sélectionné.');
  }
  if (options.confirmCount !== requested.length) {
    throw new GhostPruneValidationError(
      `Confirmation invalide : ${options.confirmCount} attendu(s) contre ${requested.length} membre(s) sélectionné(s).`,
    );
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    throw new GhostPruneValidationError('Serveur introuvable.');
  }

  const config = await getGhostConfig(guildId);
  const preview = await previewGhostPrune(client, guildId, { statuses: options.statuses });
  const allowed = new Map(preview.candidates.map((c) => [c.userId, c]));

  const targets = requested.filter((userId) => allowed.has(userId));
  if (targets.length === 0) {
    throw new GhostPruneValidationError(
      'Aucun des membres sélectionnés n\'est encore éligible. La liste a probablement changé depuis la prévisualisation.',
    );
  }
  if (targets.length > config.maxPruneBatch) {
    throw new GhostPruneValidationError(
      `Limite de ${config.maxPruneBatch} membres par prunage dépassée (${targets.length} demandés).`,
    );
  }

  const reason = (options.reason?.trim() || config.pruneReason).slice(0, 400);

  const run = await prisma.ghostPruneRun.create({
    data: {
      guildId,
      executedById: executor.userId,
      executedByName: executor.username,
      status: 'RUNNING',
      targetStatuses: options.statuses ?? ['INACTIVE'],
      totalTargeted: targets.length,
      reason,
      criteria: {
        inactiveDays: config.inactiveDays,
        spectatorWindowDays: config.spectatorWindowDays,
        gracePeriodDays: config.gracePeriodDays,
        protectStaff: config.protectStaff,
        protectBoosters: config.protectBoosters,
        protectedRoleIds: config.protectedRoleIds,
      },
    },
  });

  const kicked: string[] = [];
  const failures: { userId: string; username: string; error: string }[] = [];

  for (const userId of targets) {
    const candidate = allowed.get(userId);
    const username = candidate?.username ?? userId;
    try {
      const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId);
      if (!member.kickable) {
        failures.push({ userId, username, error: 'Le bot ne peut pas expulser ce membre (hiérarchie des rôles).' });
        continue;
      }
      await member.kick(reason);
      kicked.push(userId);
    } catch (error) {
      failures.push({
        userId,
        username,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(KICK_DELAY_MS);
  }

  const status: GhostPruneResult['status'] = kicked.length === 0
    ? 'FAILED'
    : failures.length > 0 ? 'PARTIAL' : 'COMPLETED';

  await prisma.ghostPruneRun.update({
    where: { id: run.id },
    data: {
      status,
      successCount: kicked.length,
      failureCount: failures.length,
      kickedUserIds: kicked,
      failures: failures.length > 0 ? failures : undefined,
      completedAt: new Date(),
    },
  });

  if (kicked.length > 0) {
    await prisma.memberProfile.updateMany({
      where: { guildId, userId: { in: kicked } },
      data: { guildLeftAt: new Date() },
    });
  }

  logger.info(
    'GhostAnalyzer',
    `Prunage ${status} sur ${guildId} par ${executor.username}: ${kicked.length} expulsé(s), ${failures.length} échec(s).`,
  );

  return {
    runId: run.id,
    status,
    totalTargeted: targets.length,
    successCount: kicked.length,
    failureCount: failures.length,
    failures,
  };
}

export async function getGhostPruneRuns(guildId: string, take = 20) {
  return prisma.ghostPruneRun.findMany({
    where: { guildId },
    orderBy: { startedAt: 'desc' },
    take: Math.min(100, Math.max(1, take)),
  });
}

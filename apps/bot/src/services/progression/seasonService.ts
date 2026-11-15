/**
 * Saisons de leveling : un classement de l'XP gagnée sur une période.
 *
 * Rien n'est remis à zéro. À l'ouverture, l'XP de chaque membre est relevée
 * (`SeasonBaseline`) ; le classement de saison est l'XP actuelle moins ce
 * relevé. À la clôture, ce classement est figé (`SeasonSnapshot`) et les
 * récompenses sont données selon lui.
 */
import type { Client, Guild } from 'discord.js';
import type { Prisma } from '@prisma/client';
import {
  planSeasonRewards,
  readStoredSeasonRewards,
  validateSeasonRewards,
  validateSeasonSchedule,
  type PlannedSeasonReward,
  type SeasonReward,
  type SeasonRewardError,
  type SeasonScheduleError,
} from '@kotbo/shared';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { getOrCreateRpgProfile } from '../features/economyService.js';
import { toDateKey } from '../analytics/dateKeys.js';
import { getCachedGuild } from '../../utils/cache.js';
import { announceSeasonEnd, announceSeasonStart } from './seasonAnnouncements.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';

const LOG_TAG = 'Season';
/** Membres figés à la clôture, et donc récompensables. */
const ARCHIVE_LIMIT = 100;
const FINAL_LEADERBOARD_SIZE = 20;
const SNOWFLAKE_RE = /^\d{17,20}$/;
/** Raison du rafraîchissement en direct de la page Saisons. */
export const SEASONS_REALTIME_REASON = 'seasons_updated';

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'memberDailyStat'>;

export interface SeasonStanding {
  userId: string;
  rank: number;
  /** XP gagnée pendant la saison. */
  xp: number;
  level: number;
  messagesCount: number;
  voiceMinutes: number;
}

export type SeasonInputError = SeasonScheduleError | SeasonRewardError | 'BAD_TOP_ROLE' | 'BAD_ANNOUNCE_CHANNEL';
export type StartSeasonResult = 'started' | 'not_found' | 'another_active';

interface SeasonInput {
  name: string;
  startDate: Date;
  endDate: Date;
  rewards: SeasonReward[];
  topRoleId: string | null;
  announceChannelId: string | null;
}

function optionalSnowflake(value: unknown): string | null | false {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) return null;
  return SNOWFLAKE_RE.test(id) ? id : false;
}

/** Valide ce qu'envoient le dashboard et le MCP, avec les mêmes règles. */
export function parseSeasonInput(raw: Record<string, unknown>, now: Date = new Date()): { input: SeasonInput } | { error: SeasonInputError } {
  const schedule = validateSeasonSchedule({ name: raw.name, startDate: raw.startDate, endDate: raw.endDate }, now);
  if ('error' in schedule) return schedule;
  const rewards = validateSeasonRewards(raw.rewards ?? []);
  if ('error' in rewards) return rewards;
  const topRoleId = optionalSnowflake(raw.topRoleId);
  if (topRoleId === false) return { error: 'BAD_TOP_ROLE' };
  const announceChannelId = optionalSnowflake(raw.announceChannelId);
  if (announceChannelId === false) return { error: 'BAD_ANNOUNCE_CHANNEL' };
  return { input: { ...schedule.schedule, rewards: rewards.rewards, topRoleId, announceChannelId } };
}

export async function getActiveSeasons(guildId: string) {
  return prismaRead.levelingSeason.findMany({
    where: { guildId, status: 'ACTIVE' },
    orderBy: { number: 'desc' },
  });
}

export async function getAllSeasons(guildId: string) {
  return prismaRead.levelingSeason.findMany({
    where: { guildId },
    orderBy: { number: 'desc' },
    include: { _count: { select: { snapshots: true } } },
  });
}

/** Crée la saison ; un début déjà passé l'ouvre aussitôt, si aucune autre ne tourne. */
export async function createSeason(guildId: string, input: SeasonInput, client: Client | null) {
  const lastSeason = await prismaRead.levelingSeason.findFirst({
    where: { guildId },
    orderBy: { number: 'desc' },
    select: { number: true },
  });

  const season = await prisma.levelingSeason.create({
    data: {
      guildId,
      name: input.name,
      number: (lastSeason?.number ?? 0) + 1,
      startDate: input.startDate,
      endDate: input.endDate,
      rewards: input.rewards as unknown as Prisma.InputJsonValue,
      topRoleId: input.topRoleId,
      announceChannelId: input.announceChannelId,
      status: 'UPCOMING',
    },
  });

  if (input.startDate <= new Date() && await startSeason(guildId, season.id, client) === 'started') {
    return { ...season, status: 'ACTIVE' as const };
  }
  broadcastDashboardStateChange(guildId, SEASONS_REALTIME_REASON);
  return season;
}

/**
 * Modifie une saison à venir ou en cours. Un champ absent garde sa valeur.
 * Une saison en cours garde sa date de début : son relevé d'XP a été fait à
 * cette date-là.
 */
export async function updateSeason(
  guildId: string,
  seasonId: string,
  raw: Record<string, unknown>,
  client: Client | null,
): Promise<'updated' | 'not_found' | SeasonInputError> {
  const season = await prismaRead.levelingSeason.findFirst({ where: { id: seasonId, guildId } });
  if (!season || (season.status !== 'UPCOMING' && season.status !== 'ACTIVE')) return 'not_found';

  const active = season.status === 'ACTIVE';
  const kept = (key: string, current: unknown) => (key in raw ? raw[key] : current);
  const parsed = parseSeasonInput({
    name: kept('name', season.name),
    startDate: active ? season.startDate : kept('startDate', season.startDate),
    endDate: kept('endDate', season.endDate),
    rewards: kept('rewards', readStoredSeasonRewards(season.rewards)),
    topRoleId: kept('topRoleId', season.topRoleId),
    announceChannelId: kept('announceChannelId', season.announceChannelId),
  });
  if ('error' in parsed) return parsed.error;

  const { count } = await prisma.levelingSeason.updateMany({
    where: { id: seasonId, guildId, status: season.status },
    data: {
      name: parsed.input.name,
      endDate: parsed.input.endDate,
      rewards: parsed.input.rewards as unknown as Prisma.InputJsonValue,
      topRoleId: parsed.input.topRoleId,
      announceChannelId: parsed.input.announceChannelId,
      ...(active ? {} : { startDate: parsed.input.startDate }),
    },
  });
  if (count === 0) return 'not_found';

  // Même règle qu'à la création : un début avancé dans le passé ouvre la saison.
  if (!active && parsed.input.startDate <= new Date()) await startSeason(guildId, seasonId, client);
  broadcastDashboardStateChange(guildId, SEASONS_REALTIME_REASON);
  return 'updated';
}

/** Seule une saison à venir se supprime : les autres ont un classement. */
export async function deleteSeason(guildId: string, seasonId: string): Promise<boolean> {
  const { count } = await prisma.levelingSeason.deleteMany({ where: { id: seasonId, guildId, status: 'UPCOMING' } });
  if (count > 0) broadcastDashboardStateChange(guildId, SEASONS_REALTIME_REASON);
  return count > 0;
}

/**
 * Ouvre une saison à venir et relève l'XP de chacun dans la même transaction.
 * Une saison en cours n'est jamais clôturée en passant : elle perdrait son
 * classement et ses récompenses.
 */
export async function startSeason(guildId: string, seasonId: string, client: Client | null = null): Promise<StartSeasonResult> {
  const now = new Date();
  const started = await prisma.$transaction(async (tx) => {
    const active = await tx.levelingSeason.findFirst({ where: { guildId, status: 'ACTIVE' }, select: { id: true } });
    if (active) return 'another_active' as const;

    const season = await tx.levelingSeason.findFirst({ where: { id: seasonId, guildId, status: 'UPCOMING' } });
    if (!season) return 'not_found' as const;

    // La date de début devient celle du relevé : ouverte en avance, en retard
    // ou créée avec un début passé, la période affichée est celle classée.
    const { count } = await tx.levelingSeason.updateMany({
      where: { id: seasonId, guildId, status: 'UPCOMING' },
      data: { status: 'ACTIVE', startDate: now },
    });
    if (count === 0) return 'not_found' as const;

    await tx.$executeRaw`
      INSERT INTO "season_baselines" ("seasonId", "userId", "xp")
      SELECT ${seasonId}, "userId", "xp" FROM "member_levels" WHERE "guildId" = ${guildId} AND "xp" > 0
      ON CONFLICT DO NOTHING`;
    return season;
  }, { timeout: 30_000 });
  if (typeof started === 'string') return started;
  broadcastDashboardStateChange(guildId, SEASONS_REALTIME_REASON);

  if (client) {
    await announceSeasonStart(client, started, readStoredSeasonRewards(started.rewards), started.topRoleId).catch((err) => {
      logger.warn(LOG_TAG, `Annonce d'ouverture de la saison ${seasonId} impossible`, err);
    });
  }
  return 'started';
}

/**
 * Membres sur la liste noire de progression : sans classement ni récompense.
 * Sans serveur sous la main, seuls les membres listés un à un sont connus ;
 * avec lui, les porteurs des rôles listés (membres en cache) s'y ajoutent.
 */
async function excludedFromSeason(guildId: string, guild: Guild | null): Promise<string[]> {
  const config = await getCachedGuild(guildId).catch(() => null);
  const excluded = new Set(config?.progressionBlacklistUserIds ?? []);
  if (guild) {
    for (const roleId of config?.progressionBlacklistRoleIds ?? []) {
      for (const memberId of guild.roles.cache.get(roleId)?.members.keys() ?? []) excluded.add(memberId);
    }
  }
  return [...excluded];
}

/** Classement en cours : XP actuelle moins le relevé d'ouverture, 0 sans relevé. */
async function liveStandings(
  db: Db,
  guildId: string,
  seasonId: string,
  limit: number,
  period: { start: Date; end: Date },
  excluded: string[],
): Promise<SeasonStanding[]> {
  const rows = await db.$queryRaw<Array<{ userId: string; level: number; seasonXp: number }>>`
    SELECT ml."userId", ml."level", (ml."xp" - COALESCE(b."xp", 0))::int AS "seasonXp"
    FROM "member_levels" ml
    LEFT JOIN "season_baselines" b ON b."seasonId" = ${seasonId} AND b."userId" = ml."userId"
    WHERE ml."guildId" = ${guildId} AND ml."xp" > COALESCE(b."xp", 0)
      AND NOT (ml."userId" = ANY(${excluded}::text[]))
    ORDER BY "seasonXp" DESC, ml."userId" ASC
    LIMIT ${limit}`;

  const activity = await seasonActivity(db, guildId, rows.map((row) => row.userId), period.start, period.end);
  return rows.map((row, index) => ({
    userId: row.userId,
    rank: index + 1,
    xp: row.seasonXp,
    level: row.level,
    messagesCount: activity.get(row.userId)?.messagesCount ?? 0,
    voiceMinutes: activity.get(row.userId)?.voiceMinutes ?? 0,
  }));
}

/** Messages et minutes de voix sur les jours de la saison (jours UTC des statistiques). */
async function seasonActivity(db: Db, guildId: string, userIds: string[], start: Date, end: Date) {
  const activity = new Map<string, { messagesCount: number; voiceMinutes: number }>();
  if (userIds.length === 0) return activity;

  const rows = await db.memberDailyStat.groupBy({
    by: ['userId'],
    where: { guildId, userId: { in: userIds }, dateKey: { gte: toDateKey(start), lte: toDateKey(end) } },
    _sum: { messagesCount: true, voiceMinutes: true },
  });
  for (const row of rows) {
    activity.set(row.userId, { messagesCount: row._sum.messagesCount ?? 0, voiceMinutes: row._sum.voiceMinutes ?? 0 });
  }
  return activity;
}

export async function endSeason(client: Client, guildId: string, seasonId: string): Promise<boolean> {
  const season = await prismaRead.levelingSeason.findFirst({ where: { id: seasonId, guildId, status: 'ACTIVE' } });
  if (!season) return false;

  const now = new Date();
  const endDate = season.endDate < now ? season.endDate : now;
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  const excluded = await excludedFromSeason(guildId, guild);

  // Le passage à ENDED sert de verrou : deux clôtures simultanées (cron, bouton,
  // MCP) ne figent et ne récompensent qu'une fois.
  const standings = await prisma.$transaction(async (tx) => {
    const claim = await tx.levelingSeason.updateMany({
      where: { id: seasonId, guildId, status: 'ACTIVE' },
      data: { status: 'ENDED', endDate },
    });
    if (claim.count === 0) return null;

    const ranked = await liveStandings(tx, guildId, seasonId, ARCHIVE_LIMIT, { start: season.startDate, end: endDate }, excluded);
    if (ranked.length > 0) {
      await tx.seasonSnapshot.createMany({
        data: ranked.map((entry) => ({ guildId, seasonId, ...entry })),
        skipDuplicates: true,
      });
    }
    await tx.levelingSeason.update({
      where: { id: seasonId },
      data: {
        finalLeaderboard: ranked.slice(0, FINAL_LEADERBOARD_SIZE).map(({ userId, xp, level, rank }) => ({ userId, xp, level, rank })) as Prisma.InputJsonValue,
      },
    });
    await tx.seasonBaseline.deleteMany({ where: { seasonId } });
    return ranked;
  }, { timeout: 30_000 });
  if (!standings) return false;
  broadcastDashboardStateChange(guildId, SEASONS_REALTIME_REASON);

  const plan = planSeasonRewards(readStoredSeasonRewards(season.rewards), standings, season.topRoleId);
  await grantSeasonRewards(guild, guildId, plan, season.topRoleId);

  // Le classement RP se clôt avec la saison de leveling : le module Ranked se
  // greffe sur ce calendrier plutôt que d'en ouvrir un second. Les récompenses
  // suivent le seul classement de la saison : les passer aussi au RP les
  // donnait deux fois, à deux gagnants différents.
  const { closeRankedSeasonForLevelingSeason } = await import('./ranked/rankedSeasonService.js');
  await closeRankedSeasonForLevelingSeason(client, guildId, seasonId).catch(() => null);

  await announceSeasonEnd(client, season, standings, plan).catch((err) => {
    logger.warn(LOG_TAG, `Annonce de clôture de la saison ${seasonId} impossible`, err);
  });

  logger.info(LOG_TAG, `Saison #${season.number} terminée pour ${guildId} : ${standings.length} classés`);
  return true;
}

async function grantSeasonRewards(guild: Guild | null, guildId: string, plan: PlannedSeasonReward[], topRoleId: string | null): Promise<void> {
  if (plan.length === 0) return;

  // Les pièces appartiennent à l'économie : éteinte, seuls les rôles sont remis.
  const economyEnabled = await isModuleEnabled(guildId, 'economy');
  const reason = 'Récompense de fin de saison';

  const winner = plan.find((entry) => entry.rank === 1)?.userId;
  if (guild && topRoleId && winner) await releaseTopRole(guild, topRoleId, winner);

  for (const entry of plan) {
    if (entry.coins > 0 && economyEnabled) {
      try {
        const profile = await getOrCreateRpgProfile(guildId, entry.userId);
        await prisma.rpgProfile.update({ where: { id: profile.id }, data: { balance: { increment: entry.coins } } });
      } catch (err) {
        logger.warn(LOG_TAG, `Pièces de saison non versées à ${entry.userId} sur ${guildId}`, err);
      }
    }

    if (entry.roleId && guild) {
      const member = await guild.members.fetch(entry.userId).catch(() => null);
      if (!member) continue;
      await member.roles.add(entry.roleId, reason).catch((err: unknown) => {
        logger.warn(LOG_TAG, `Rôle de saison ${entry.roleId} non donné à ${entry.userId} sur ${guildId}`, err);
      });
    }
  }
}

/** Le rôle du premier n'a qu'un porteur : celui de la saison passée le rend. */
async function releaseTopRole(guild: Guild, roleId: string, winnerId: string): Promise<void> {
  const role = guild.roles.cache.get(roleId);
  if (!role) return;
  for (const [memberId, member] of role.members) {
    if (memberId === winnerId) continue;
    await member.roles.remove(roleId, 'Rôle du premier repris par la saison suivante').catch((err: unknown) => {
      logger.warn(LOG_TAG, `Rôle du premier non retiré à ${memberId} sur ${guild.id}`, err);
    });
  }
}

/** Saison en cours : calculé à la volée. Terminée : le classement figé. */
export async function getSeasonLeaderboard(guildId: string, seasonId: string, limit = 20): Promise<SeasonStanding[]> {
  const season = await prismaRead.levelingSeason.findFirst({
    where: { id: seasonId, guildId },
    select: { status: true, startDate: true, endDate: true },
  });
  if (!season) return [];

  if (season.status === 'ACTIVE') {
    return liveStandings(prismaRead, guildId, seasonId, limit, { start: season.startDate, end: new Date() }, await excludedFromSeason(guildId, null));
  }

  const snapshots = await prismaRead.seasonSnapshot.findMany({
    where: { guildId, seasonId },
    orderBy: { rank: 'asc' },
    take: limit,
  });
  return snapshots.map(({ userId, rank, xp, level, messagesCount, voiceMinutes }) => ({ userId, rank, xp, level, messagesCount, voiceMinutes }));
}

/** Participants (au moins 1 XP gagnée) et XP gagnée au total depuis l'ouverture. */
async function liveSeasonTotals(guildId: string, seasonId: string): Promise<{ participants: number; totalXp: number }> {
  const excluded = await excludedFromSeason(guildId, null);
  const [row] = await prismaRead.$queryRaw<Array<{ participants: number; totalXp: bigint | null }>>`
    SELECT COUNT(*)::int AS "participants", SUM(ml."xp" - COALESCE(b."xp", 0))::bigint AS "totalXp"
    FROM "member_levels" ml
    LEFT JOIN "season_baselines" b ON b."seasonId" = ${seasonId} AND b."userId" = ml."userId"
    WHERE ml."guildId" = ${guildId} AND ml."xp" > COALESCE(b."xp", 0)
      AND NOT (ml."userId" = ANY(${excluded}::text[]))`;
  return { participants: row?.participants ?? 0, totalXp: Number(row?.totalXp ?? 0) };
}

export async function checkAndProgressSeasons(client: Client): Promise<void> {
  const now = new Date();

  // Clôturer d'abord : la saison suivante d'un serveur peut démarrer le jour
  // même, et l'ouverture est refusée tant qu'une autre est en cours.
  const toEnd = await prismaRead.levelingSeason.findMany({
    where: { status: 'ACTIVE', endDate: { lte: now } },
  });
  for (const season of toEnd) {
    if (!(await isModuleEnabled(season.guildId, 'seasons'))) continue;
    await endSeason(client, season.guildId, season.id).catch((err) => {
      logger.error(LOG_TAG, `Clôture de la saison ${season.id} impossible sur ${season.guildId}`, err);
    });
  }

  const toStart = await prismaRead.levelingSeason.findMany({
    where: { status: 'UPCOMING', startDate: { lte: now } },
    orderBy: { startDate: 'asc' },
  });
  for (const season of toStart) {
    if (!(await isModuleEnabled(season.guildId, 'seasons'))) continue;
    const result = await startSeason(season.guildId, season.id, client).catch((err) => {
      logger.error(LOG_TAG, `Ouverture de la saison ${season.id} impossible sur ${season.guildId}`, err);
      return null;
    });
    if (result === 'started') logger.info(LOG_TAG, `Saison #${season.number} démarrée automatiquement pour ${season.guildId}`);
  }
}

export async function getSeasonsDashboardData(guildId: string) {
  const [seasons, activeSeason] = await Promise.all([
    getAllSeasons(guildId),
    prismaRead.levelingSeason.findFirst({ where: { guildId, status: 'ACTIVE' } }),
  ]);

  const [activeLeaderboard, activeTotals] = activeSeason
    ? await Promise.all([getSeasonLeaderboard(guildId, activeSeason.id, 20), liveSeasonTotals(guildId, activeSeason.id)])
    : [[], null];

  return {
    seasons: seasons.map((season) => ({ ...season, rewards: readStoredSeasonRewards(season.rewards) })),
    activeSeason: activeSeason ? { ...activeSeason, rewards: readStoredSeasonRewards(activeSeason.rewards) } : null,
    activeLeaderboard,
    activeTotals,
  };
}

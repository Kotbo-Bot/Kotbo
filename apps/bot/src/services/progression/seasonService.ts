/**
 * Saisons de leveling : un classement de l'XP gagnée sur une période.
 *
 * Rien n'est remis à zéro. À l'ouverture, l'XP de chaque membre est relevée
 * (`SeasonBaseline`) ; le classement de saison est l'XP actuelle moins ce
 * relevé. À la clôture, ce classement est figé (`SeasonSnapshot`), les
 * récompenses sont données selon lui et ce qui a été réellement remis est
 * consigné (`grantedRewards`), pour être montré et repris s'il le faut.
 */
import type { Client, Guild, GuildMember } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { kotboEventBus } from '@kotbo/core';
import {
  isRewardOutcomeComplete,
  planSeasonRewards,
  planSeasonTiers,
  readSeasonRewardOutcomes,
  readSeasonStats,
  readStoredSeasonRewards,
  readStoredSeasonTiers,
  renewedSeasonSchedule,
  rolesToTakeBack,
  seasonReminderDue,
  validateSeasonRewards,
  validateSeasonSchedule,
  validateSeasonTiers,
  SEASON_REMINDER_HOURS,
  type PlannedSeasonReward,
  type SeasonCoinsOutcome,
  type SeasonReward,
  type SeasonRewardError,
  type SeasonRewardOutcome,
  type SeasonRoleOutcome,
  type SeasonScheduleError,
  type SeasonStats,
  type SeasonTierError,
  type SeasonTierReward,
} from '@kotbo/shared';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { botMember, roleBlockerOf } from '../../utils/botRoleAccess.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { getOrCreateRpgProfile } from '../features/economyService.js';
import { toDateKey } from '../analytics/dateKeys.js';
import { getCachedGuild } from '../../utils/cache.js';
import { announceSeasonEnd, announceSeasonReminder, announceSeasonStart } from './seasonAnnouncements.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';

const LOG_TAG = 'Season';
/** Membres figés à la clôture, et donc récompensables. */
const ARCHIVE_LIMIT = 100;
const FINAL_LEADERBOARD_SIZE = 20;
const REMINDER_PODIUM = 3;
const HISTORY_LIMIT = 10;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const REWARD_REASON = 'Récompense de fin de saison';
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

export type SeasonInputError = SeasonScheduleError | SeasonRewardError | SeasonTierError | 'BAD_TOP_ROLE' | 'BAD_ANNOUNCE_CHANNEL';
export type StartSeasonResult = 'started' | 'not_found' | 'another_active';

interface SeasonInput {
  name: string;
  startDate: Date;
  endDate: Date;
  rewards: SeasonReward[];
  tiers: SeasonTierReward[];
  topRoleId: string | null;
  announceChannelId: string | null;
  autoRenew: boolean;
  remindBeforeEnd: boolean;
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
  const tiers = validateSeasonTiers(raw.tiers ?? []);
  if ('error' in tiers) return tiers;
  const topRoleId = optionalSnowflake(raw.topRoleId);
  if (topRoleId === false) return { error: 'BAD_TOP_ROLE' };
  const announceChannelId = optionalSnowflake(raw.announceChannelId);
  if (announceChannelId === false) return { error: 'BAD_ANNOUNCE_CHANNEL' };
  return {
    input: {
      ...schedule.schedule,
      rewards: rewards.rewards,
      tiers: tiers.tiers,
      topRoleId,
      announceChannelId,
      autoRenew: raw.autoRenew === true,
      remindBeforeEnd: raw.remindBeforeEnd === true,
    },
  };
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

/**
 * Crée la saison ; un début déjà passé l'ouvre aussitôt, si aucune autre ne
 * tourne. Les écritures lisent la base principale : un réplica en retard
 * donnerait un numéro déjà pris ou d'anciennes récompenses.
 */
export async function createSeason(guildId: string, input: SeasonInput, client: Client | null) {
  const lastSeason = await prisma.levelingSeason.findFirst({
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
      tiers: input.tiers as unknown as Prisma.InputJsonValue,
      topRoleId: input.topRoleId,
      announceChannelId: input.announceChannelId,
      autoRenew: input.autoRenew,
      remindBeforeEnd: input.remindBeforeEnd,
      status: 'UPCOMING',
    },
  });

  if (input.startDate <= new Date() && await startSeason(guildId, season.id, client) === 'started') {
    // L'ouverture a réécrit le statut et la date de début.
    return (await prisma.levelingSeason.findUnique({ where: { id: season.id } })) ?? season;
  }
  broadcastDashboardStateChange(guildId, SEASONS_REALTIME_REASON);
  return season;
}

/**
 * Modifie une saison à venir ou en cours. Un champ absent garde sa valeur.
 * Une saison en cours garde sa date de début : son relevé d'XP a été fait à
 * cette date-là. Une nouvelle date de fin réarme le rappel.
 */
export async function updateSeason(
  guildId: string,
  seasonId: string,
  raw: Record<string, unknown>,
  client: Client | null,
): Promise<'updated' | 'not_found' | SeasonInputError> {
  const season = await prisma.levelingSeason.findFirst({ where: { id: seasonId, guildId } });
  if (!season || (season.status !== 'UPCOMING' && season.status !== 'ACTIVE')) return 'not_found';

  const active = season.status === 'ACTIVE';
  const kept = (key: string, current: unknown) => (key in raw ? raw[key] : current);
  const parsed = parseSeasonInput({
    name: kept('name', season.name),
    startDate: active ? season.startDate : kept('startDate', season.startDate),
    endDate: kept('endDate', season.endDate),
    rewards: kept('rewards', readStoredSeasonRewards(season.rewards)),
    tiers: kept('tiers', readStoredSeasonTiers(season.tiers)),
    topRoleId: kept('topRoleId', season.topRoleId),
    announceChannelId: kept('announceChannelId', season.announceChannelId),
    autoRenew: kept('autoRenew', season.autoRenew),
    remindBeforeEnd: kept('remindBeforeEnd', season.remindBeforeEnd),
  });
  if ('error' in parsed) return parsed.error;

  const endMoved = parsed.input.endDate.getTime() !== season.endDate.getTime();
  const { count } = await prisma.levelingSeason.updateMany({
    where: { id: seasonId, guildId, status: season.status },
    data: {
      name: parsed.input.name,
      endDate: parsed.input.endDate,
      rewards: parsed.input.rewards as unknown as Prisma.InputJsonValue,
      tiers: parsed.input.tiers as unknown as Prisma.InputJsonValue,
      topRoleId: parsed.input.topRoleId,
      announceChannelId: parsed.input.announceChannelId,
      autoRenew: parsed.input.autoRenew,
      remindBeforeEnd: parsed.input.remindBeforeEnd,
      ...(endMoved ? { reminderSentAt: null } : {}),
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
  kotboEventBus.publish('season:started', {
    guildId,
    seasonId,
    number: started.number,
    name: started.name,
    endDate: started.endDate.toISOString(),
    timestamp: now.getTime(),
  });

  if (client) {
    await announceSeasonStart(client, started, readStoredSeasonRewards(started.rewards), started.topRoleId, readStoredSeasonTiers(started.tiers)).catch((err) => {
      logger.warn(LOG_TAG, `Annonce d'ouverture de la saison ${seasonId} impossible`, err);
    });
  }
  return 'started';
}

/**
 * Membres sur la liste noire de progression : sans classement ni récompense.
 * Sans serveur sous la main, seuls les membres listés un à un sont connus ;
 * avec lui, les porteurs des rôles listés s'y ajoutent. Ceux-là ne sont connus
 * que du cache, sauf `complete` : la clôture charge alors tous les membres,
 * pour ne récompenser personne qu'il aurait fallu écarter.
 */
async function excludedFromSeason(guildId: string, guild: Guild | null, complete = false): Promise<string[]> {
  const config = await getCachedGuild(guildId).catch(() => null);
  const excluded = new Set(config?.progressionBlacklistUserIds ?? []);
  const roleIds = config?.progressionBlacklistRoleIds ?? [];
  if (guild && roleIds.length > 0) {
    if (complete) await guild.members.fetch().catch((err: unknown) => logger.warn(LOG_TAG, `Membres de ${guildId} non chargés`, err));
    for (const roleId of roleIds) {
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
  // Base principale : les récompenses à donner sont celles enregistrées à l'instant.
  const season = await prisma.levelingSeason.findFirst({ where: { id: seasonId, guildId, status: 'ACTIVE' } });
  if (!season) return false;

  const now = new Date();
  const endDate = season.endDate < now ? season.endDate : now;
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  const excluded = await excludedFromSeason(guildId, guild, true);

  const tiers = readStoredSeasonTiers(season.tiers);

  // Le passage à ENDED sert de verrou : deux clôtures simultanées (cron, bouton,
  // MCP) ne figent et ne récompensent qu'une fois. Tout ce qui lit le relevé
  // d'XP se fait avant sa suppression, dans la même transaction.
  const frozen = await prisma.$transaction(async (tx) => {
    const claim = await tx.levelingSeason.updateMany({
      where: { id: seasonId, guildId, status: 'ACTIVE' },
      data: { status: 'ENDED', endDate },
    });
    if (claim.count === 0) return null;

    const ranked = await liveStandings(tx, guildId, seasonId, ARCHIVE_LIMIT, { start: season.startDate, end: endDate }, excluded);
    // Les paliers vont à tous ceux qui les atteignent, pas aux seuls 100 figés.
    const tierMembers = tiers.length > 0 ? await membersAbove(tx, guildId, seasonId, tiers[0].minXp, excluded) : [];
    const totals = await liveSeasonTotals(tx, guildId, seasonId, excluded);
    const stats: SeasonStats = { ...totals, topXp: ranked[0]?.xp ?? 0 };
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
        stats: stats as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.seasonBaseline.deleteMany({ where: { seasonId } });
    return { standings: ranked, tierMembers, stats };
  }, { timeout: 30_000 });
  if (!frozen) return false;
  const { standings, stats } = frozen;
  broadcastDashboardStateChange(guildId, SEASONS_REALTIME_REASON);

  const rankPlan = planSeasonRewards(readStoredSeasonRewards(season.rewards), standings, season.topRoleId);
  const tierPlan = planSeasonTiers(tiers, frozen.tierMembers);
  const plan = [...rankPlan, ...tierPlan];
  if (guild && season.topRoleId) {
    const winner = rankPlan.find((entry) => entry.rank === 1)?.userId;
    if (winner) await releaseTopRole(guild, season.topRoleId, winner, seasonId);
  }
  if (guild) await takeBackRotatingRoles(guild, season.number, plan);
  const outcomes = await grantRewards(guild, guildId, plan);
  if (outcomes.length > 0) {
    await prisma.levelingSeason.update({ where: { id: seasonId }, data: { grantedRewards: outcomes as unknown as Prisma.InputJsonValue } });
  }

  // Le classement RP se clôt avec la saison de leveling : le module Ranked se
  // greffe sur ce calendrier plutôt que d'en ouvrir un second. Les récompenses
  // suivent le seul classement de la saison : les passer aussi au RP les
  // donnait deux fois, à deux gagnants différents.
  const { closeRankedSeasonForLevelingSeason } = await import('./ranked/rankedSeasonService.js');
  await closeRankedSeasonForLevelingSeason(client, guildId, seasonId).catch(() => null);

  kotboEventBus.publish('season:ended', {
    guildId,
    seasonId,
    number: season.number,
    name: season.name,
    participants: stats.participants,
    winnerId: standings[0]?.userId ?? null,
    winnerXp: standings[0]?.xp ?? 0,
    timestamp: Date.now(),
  });

  // L'annonce nomme les récompenses de rang ; les paliers, souvent nombreux,
  // y sont comptés plutôt que listés.
  const tiersReached = tiers.map((tier) => ({ minXp: tier.minXp, count: tierPlan.filter((entry) => entry.tierXp === tier.minXp).length }));
  await announceSeasonEnd(client, season, standings, rankPlan, tiersReached).catch((err) => {
    logger.warn(LOG_TAG, `Annonce de clôture de la saison ${seasonId} impossible`, err);
  });

  logger.info(LOG_TAG, `Saison #${season.number} terminée pour ${guildId} : ${standings.length} classés`);

  if (season.autoRenew) {
    await renewSeason(client, season).catch((err) => {
      logger.error(LOG_TAG, `Saison suivante de ${seasonId} non ouverte sur ${guildId}`, err);
    });
  }
  return true;
}

/**
 * Ouvre la saison qui prend la suite, mêmes réglages et même durée prévue.
 * Une saison déjà prévue l'emporte : le staff a choisi la suite lui-même.
 */
async function renewSeason(
  client: Client,
  season: { guildId: string; name: string; startDate: Date; endDate: Date; rewards: unknown; tiers: unknown; topRoleId: string | null; announceChannelId: string | null; remindBeforeEnd: boolean },
): Promise<void> {
  const planned = await prisma.levelingSeason.findFirst({ where: { guildId: season.guildId, status: 'UPCOMING' }, select: { id: true } });
  if (planned) return;
  await createSeason(season.guildId, {
    name: season.name,
    ...renewedSeasonSchedule(season),
    rewards: readStoredSeasonRewards(season.rewards),
    tiers: readStoredSeasonTiers(season.tiers),
    topRoleId: season.topRoleId,
    announceChannelId: season.announceChannelId,
    autoRenew: true,
    remindBeforeEnd: season.remindBeforeEnd,
  }, client);
}

/** Donne chaque part prévue et rend ce qui a été réellement remis. */
async function grantRewards(guild: Guild | null, guildId: string, plan: ReadonlyArray<PlannedSeasonReward>): Promise<SeasonRewardOutcome[]> {
  if (plan.length === 0) return [];
  // Les pièces appartiennent à l'économie : éteinte, seuls les rôles sont remis.
  const economyEnabled = await isModuleEnabled(guildId, 'economy');
  const me = guild ? await botMember(guild) : null;

  const outcomes: SeasonRewardOutcome[] = [];
  for (const entry of plan) {
    outcomes.push({
      userId: entry.userId,
      rank: entry.rank,
      roleId: entry.roleId,
      coins: entry.coins,
      coinsStatus: entry.coins > 0 ? await grantCoins(guildId, entry.userId, entry.coins, economyEnabled) : null,
      roleStatus: entry.roleId ? await grantRole(guild, me, entry.userId, entry.roleId) : null,
      ...(entry.rotate ? { rotate: true } : {}),
      ...(entry.tierXp !== undefined ? { tierXp: entry.tierXp } : {}),
    });
  }
  return outcomes;
}

async function grantCoins(guildId: string, userId: string, coins: number, economyEnabled: boolean): Promise<SeasonCoinsOutcome> {
  if (!economyEnabled) return 'economy_off';
  try {
    const profile = await getOrCreateRpgProfile(guildId, userId);
    await prisma.rpgProfile.update({ where: { id: profile.id }, data: { balance: { increment: coins } } });
    return 'given';
  } catch (err) {
    logger.warn(LOG_TAG, `Pièces de saison non versées à ${userId} sur ${guildId}`, err);
    return 'failed';
  }
}

/** Un rôle que Discord refusera (hiérarchie, intégration, permission) n'est pas tenté. */
async function grantRole(guild: Guild | null, me: GuildMember | null, userId: string, roleId: string): Promise<SeasonRoleOutcome> {
  if (!guild) return 'failed';
  if (roleBlockerOf(guild.roles.cache.get(roleId), me)) return 'blocked';
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return 'member_left';
  try {
    await member.roles.add(roleId, REWARD_REASON);
    return 'given';
  } catch (err) {
    logger.warn(LOG_TAG, `Rôle de saison ${roleId} non donné à ${userId} sur ${guild.id}`, err);
    return 'failed';
  }
}

/**
 * Le rôle du premier n'a qu'un porteur. Ceux du cache le rendent, et les
 * premiers des saisons passées qui portaient ce rôle aussi : sur un grand
 * serveur, l'ancien champion n'est souvent plus en cache.
 */
async function releaseTopRole(guild: Guild, roleId: string, winnerId: string, seasonId: string): Promise<void> {
  const formerWinners = await prisma.seasonSnapshot.findMany({
    where: { guildId: guild.id, rank: 1, season: { topRoleId: roleId, id: { not: seasonId } } },
    select: { userId: true },
  });
  const holders = new Set([...(guild.roles.cache.get(roleId)?.members.keys() ?? []), ...formerWinners.map((row) => row.userId)]);
  holders.delete(winnerId);

  for (const memberId of holders) {
    const member = guild.roles.cache.get(roleId)?.members.get(memberId) ?? await guild.members.fetch(memberId).catch(() => null);
    if (!member?.roles.cache.has(roleId)) continue;
    await member.roles.remove(roleId, 'Rôle du premier repris par la saison suivante').catch((err: unknown) => {
      logger.warn(LOG_TAG, `Rôle du premier non retiré à ${memberId} sur ${guild.id}`, err);
    });
  }
}

/**
 * Rôles « repris » : ceux remis à la saison d'avant le sont à la clôture de
 * celle-ci, sauf à qui les regagne. La trace de la saison d'avant les dit.
 */
async function takeBackRotatingRoles(guild: Guild, number: number, plan: ReadonlyArray<PlannedSeasonReward>): Promise<void> {
  const previous = await prisma.levelingSeason.findFirst({
    where: { guildId: guild.id, status: 'ENDED', number: { lt: number } },
    orderBy: { number: 'desc' },
    select: { grantedRewards: true },
  });
  for (const { userId, roleId } of rolesToTakeBack(readSeasonRewardOutcomes(previous?.grantedRewards), plan)) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member?.roles.cache.has(roleId)) continue;
    await member.roles.remove(roleId, 'Rôle de saison repris à la clôture suivante').catch((err: unknown) => {
      logger.warn(LOG_TAG, `Rôle de saison ${roleId} non repris à ${userId} sur ${guild.id}`, err);
    });
  }
}

export type RetrySeasonRewardsResult = { retried: number; remaining: number } | 'not_found' | 'busy';

/**
 * Reprend les récompenses d'une saison terminée qui n'ont pas été remises.
 * La version de la saison (`updatedAt`) sert de verrou : deux reprises
 * simultanées ne donnent qu'une fois.
 */
export async function retrySeasonRewards(client: Client, guildId: string, seasonId: string): Promise<RetrySeasonRewardsResult> {
  const season = await prisma.levelingSeason.findFirst({ where: { id: seasonId, guildId, status: 'ENDED' } });
  if (!season) return 'not_found';
  const outcomes = readSeasonRewardOutcomes(season.grantedRewards);
  const pending = outcomes.filter((outcome) => !isRewardOutcomeComplete(outcome));
  if (pending.length === 0) return { retried: 0, remaining: 0 };

  const claim = await prisma.levelingSeason.updateMany({
    where: { id: seasonId, guildId, updatedAt: season.updatedAt },
    data: { grantedRewards: season.grantedRewards as Prisma.InputJsonValue },
  });
  if (claim.count === 0) return 'busy';

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  const retried = await grantRewards(guild, guildId, pending.map((outcome) => ({
    userId: outcome.userId,
    rank: outcome.rank,
    rotate: outcome.rotate,
    tierXp: outcome.tierXp,
    // Seules les parts manquantes sont redonnées : un rôle déjà remis n'est pas retenté.
    roleId: outcome.roleStatus === 'given' ? null : outcome.roleId,
    coins: outcome.coinsStatus === 'given' ? 0 : outcome.coins,
  })));

  const byPending = new Map(pending.map((outcome, index) => [outcome, retried[index]]));
  const updated = outcomes.map((outcome) => {
    const again = byPending.get(outcome);
    if (!again) return outcome;
    return {
      ...outcome,
      roleStatus: outcome.roleStatus === 'given' ? 'given' : again.roleStatus,
      coinsStatus: outcome.coinsStatus === 'given' ? 'given' : again.coinsStatus,
    } satisfies SeasonRewardOutcome;
  });
  await prisma.levelingSeason.update({ where: { id: seasonId }, data: { grantedRewards: updated as unknown as Prisma.InputJsonValue } });
  broadcastDashboardStateChange(guildId, SEASONS_REALTIME_REASON);

  return { retried: pending.length, remaining: updated.filter((outcome) => !isRewardOutcomeComplete(outcome)).length };
}

/**
 * Saison en cours : calculé à la volée. Terminée : le classement figé.
 * Le serveur sert à écarter les porteurs des rôles de la liste noire, comme le
 * fera la clôture ; sans lui, un membre écarté par son rôle paraîtrait classé
 * jusqu'à la fin puis disparaîtrait au moment des récompenses.
 */
export async function getSeasonLeaderboard(guildId: string, seasonId: string, limit: number, guild: Guild | null): Promise<SeasonStanding[]> {
  const season = await prismaRead.levelingSeason.findFirst({
    where: { id: seasonId, guildId },
    select: { status: true, startDate: true, endDate: true },
  });
  if (!season) return [];

  if (season.status === 'ACTIVE') {
    return liveStandings(prismaRead, guildId, seasonId, limit, { start: season.startDate, end: new Date() }, await excludedFromSeason(guildId, guild));
  }

  const snapshots = await prismaRead.seasonSnapshot.findMany({
    where: { guildId, seasonId },
    orderBy: { rank: 'asc' },
    take: limit,
  });
  return snapshots.map(({ userId, rank, xp, level, messagesCount, voiceMinutes }) => ({ userId, rank, xp, level, messagesCount, voiceMinutes }));
}

/** Rang et XP de saison d'un membre, même loin du haut du classement ; `null` s'il n'y figure pas. */
export async function getSeasonMemberStanding(
  guildId: string,
  seasonId: string,
  userId: string,
  guild: Guild | null,
): Promise<{ rank: number; xp: number } | null> {
  const season = await prismaRead.levelingSeason.findFirst({ where: { id: seasonId, guildId }, select: { status: true } });
  if (!season) return null;

  if (season.status !== 'ACTIVE') {
    const snapshot = await prismaRead.seasonSnapshot.findFirst({ where: { seasonId, userId }, select: { rank: true, xp: true } });
    return snapshot ?? null;
  }

  const excluded = await excludedFromSeason(guildId, guild);
  if (excluded.includes(userId)) return null;
  // Même ordre que `liveStandings` : le rang lu ici est celui du classement affiché.
  const [row] = await prismaRead.$queryRaw<Array<{ rank: number; seasonXp: number }>>`
    SELECT ranked."rank", ranked."seasonXp" FROM (
      SELECT ml."userId", (ml."xp" - COALESCE(b."xp", 0))::int AS "seasonXp",
        ROW_NUMBER() OVER (ORDER BY (ml."xp" - COALESCE(b."xp", 0)) DESC, ml."userId" ASC)::int AS "rank"
      FROM "member_levels" ml
      LEFT JOIN "season_baselines" b ON b."seasonId" = ${seasonId} AND b."userId" = ml."userId"
      WHERE ml."guildId" = ${guildId} AND ml."xp" > COALESCE(b."xp", 0)
        AND NOT (ml."userId" = ANY(${excluded}::text[]))
    ) ranked
    WHERE ranked."userId" = ${userId}`;
  return row ? { rank: row.rank, xp: row.seasonXp } : null;
}

export interface SeasonHistoryEntry {
  number: number;
  name: string;
  endDate: Date;
  rank: number;
  xp: number;
}

/** Saisons terminées où le membre a été classé, la plus récente d'abord. */
export async function getMemberSeasonHistory(guildId: string, userId: string, limit = HISTORY_LIMIT): Promise<SeasonHistoryEntry[]> {
  const rows = await prismaRead.seasonSnapshot.findMany({
    where: { guildId, userId, season: { status: 'ENDED' } },
    orderBy: { season: { number: 'desc' } },
    take: limit,
    select: { rank: true, xp: true, season: { select: { number: true, name: true, endDate: true } } },
  });
  return rows.map((row) => ({ number: row.season.number, name: row.season.name, endDate: row.season.endDate, rank: row.rank, xp: row.xp }));
}

/** Membres ayant gagné au moins `minXp` pendant la saison, dans l'ordre du classement. */
async function membersAbove(db: Db, guildId: string, seasonId: string, minXp: number, excluded: string[]): Promise<Array<{ userId: string; rank: number; xp: number }>> {
  const rows = await db.$queryRaw<Array<{ userId: string; seasonXp: number }>>`
    SELECT ml."userId", (ml."xp" - COALESCE(b."xp", 0))::int AS "seasonXp"
    FROM "member_levels" ml
    LEFT JOIN "season_baselines" b ON b."seasonId" = ${seasonId} AND b."userId" = ml."userId"
    WHERE ml."guildId" = ${guildId} AND (ml."xp" - COALESCE(b."xp", 0)) >= ${minXp}
      AND NOT (ml."userId" = ANY(${excluded}::text[]))
    ORDER BY "seasonXp" DESC, ml."userId" ASC`;
  return rows.map((row, index) => ({ userId: row.userId, rank: index + 1, xp: row.seasonXp }));
}

/** Participants (au moins 1 XP gagnée) et XP gagnée au total depuis l'ouverture. */
async function liveSeasonTotals(db: Db, guildId: string, seasonId: string, excluded: string[]): Promise<{ participants: number; totalXp: number }> {
  const [row] = await db.$queryRaw<Array<{ participants: number; totalXp: bigint | null }>>`
    SELECT COUNT(*)::int AS "participants", SUM(ml."xp" - COALESCE(b."xp", 0))::bigint AS "totalXp"
    FROM "member_levels" ml
    LEFT JOIN "season_baselines" b ON b."seasonId" = ${seasonId} AND b."userId" = ml."userId"
    WHERE ml."guildId" = ${guildId} AND ml."xp" > COALESCE(b."xp", 0)
      AND NOT (ml."userId" = ANY(${excluded}::text[]))`;
  return { participants: row?.participants ?? 0, totalXp: Number(row?.totalXp ?? 0) };
}

/** Rappel des dernières 24 h, une fois par saison : le passage de `reminderSentAt` sert de verrou. */
async function sendDueReminders(client: Client, now: Date): Promise<void> {
  const due = await prismaRead.levelingSeason.findMany({
    where: {
      status: 'ACTIVE',
      remindBeforeEnd: true,
      reminderSentAt: null,
      announceChannelId: { not: null },
      endDate: { gt: now, lte: new Date(now.getTime() + SEASON_REMINDER_HOURS * 60 * 60 * 1000) },
    },
  });
  for (const season of due) {
    if (!seasonReminderDue(season.startDate, season.endDate, now)) continue;
    if (!(await isModuleEnabled(season.guildId, 'seasons'))) continue;
    const { count } = await prisma.levelingSeason.updateMany({
      where: { id: season.id, reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    if (count === 0) continue;

    const guild = client.guilds.cache.get(season.guildId) ?? null;
    const standings = await getSeasonLeaderboard(season.guildId, season.id, REMINDER_PODIUM, guild);
    await announceSeasonReminder(client, season, standings).catch((err) => {
      logger.warn(LOG_TAG, `Rappel de la saison ${season.id} impossible`, err);
    });
  }
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

  await sendDueReminders(client, now).catch((err) => logger.error(LOG_TAG, 'Rappels de fin de saison impossibles', err));
}

export async function getSeasonsDashboardData(guildId: string, guild: Guild | null) {
  const [seasons, activeSeason] = await Promise.all([
    getAllSeasons(guildId),
    prismaRead.levelingSeason.findFirst({ where: { guildId, status: 'ACTIVE' } }),
  ]);

  const [activeLeaderboard, activeTotals] = activeSeason
    ? await Promise.all([
      getSeasonLeaderboard(guildId, activeSeason.id, 20, guild),
      excludedFromSeason(guildId, guild).then((excluded) => liveSeasonTotals(prismaRead, guildId, activeSeason.id, excluded)),
    ])
    : [[], null];

  const readable = <T extends { rewards: unknown; tiers: unknown; grantedRewards: unknown; stats: unknown }>(season: T) => ({
    ...season,
    rewards: readStoredSeasonRewards(season.rewards),
    tiers: readStoredSeasonTiers(season.tiers),
    grantedRewards: readSeasonRewardOutcomes(season.grantedRewards),
    stats: readSeasonStats(season.stats),
  });

  return {
    seasons: seasons.map(readable),
    activeSeason: activeSeason ? readable(activeSeason) : null,
    activeLeaderboard,
    activeTotals,
  };
}

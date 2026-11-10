import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import type { Client } from 'discord.js';
import { isModuleEnabled } from '../core/moduleGate.js';

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

export async function createSeason(guildId: string, data: {
  name: string;
  startDate: Date;
  endDate: Date;
  rewards?: any;
  topRoleId?: string;
}) {
  const lastSeason = await prismaRead.levelingSeason.findFirst({
    where: { guildId },
    orderBy: { number: 'desc' },
    select: { number: true },
  });

  const number = (lastSeason?.number ?? 0) + 1;

  return prisma.levelingSeason.create({
    data: {
      guildId,
      name: data.name,
      number,
      startDate: data.startDate,
      endDate: data.endDate,
      rewards: data.rewards ?? null,
      topRoleId: data.topRoleId,
      status: new Date() >= data.startDate ? 'ACTIVE' : 'UPCOMING',
    },
  });
}

export async function startSeason(guildId: string, seasonId: string): Promise<boolean> {
  const season = await prismaRead.levelingSeason.findFirst({
    where: { id: seasonId, guildId },
  });
  if (!season || season.status === 'ACTIVE') return false;

  await prisma.levelingSeason.updateMany({
    where: { guildId, status: 'ACTIVE' },
    data: { status: 'ENDED' },
  });

  await prisma.levelingSeason.update({
    where: { id: seasonId },
    data: { status: 'ACTIVE', startDate: new Date() },
  });

  return true;
}

export async function endSeason(client: Client, guildId: string, seasonId: string): Promise<boolean> {
  const season = await prismaRead.levelingSeason.findFirst({
    where: { id: seasonId, guildId, status: 'ACTIVE' },
  });
  if (!season) return false;

  const members = await prismaRead.memberLevel.findMany({
    where: { guildId },
    orderBy: { xp: 'desc' },
    take: 100,
  });

  const snapshots = members.map((m, i) => ({
    guildId,
    seasonId,
    userId: m.userId,
    xp: m.xp,
    level: m.level,
    rank: i + 1,
    messagesCount: 0,
    voiceMinutes: 0,
  }));

  if (snapshots.length > 0) {
    await prisma.seasonSnapshot.createMany({ data: snapshots, skipDuplicates: true });
  }

  const finalLeaderboard = snapshots.slice(0, 20).map((s) => ({
    userId: s.userId,
    xp: s.xp,
    level: s.level,
    rank: s.rank,
  }));

  await prisma.levelingSeason.update({
    where: { id: seasonId },
    data: {
      status: 'ENDED',
      endDate: new Date(),
      finalLeaderboard: finalLeaderboard as any,
    },
  });

  const rewards = season.rewards as any[];
  if (rewards && rewards.length > 0) {
    const guild = client.guilds.cache.get(guildId);
    // Les pièces appartiennent à l'économie : éteinte, seuls les rôles sont remis.
    const economyEnabled = await isModuleEnabled(guildId, 'economy');
    if (guild) {
      for (const reward of rewards) {
        const ranked = snapshots.find((s) => s.rank === reward.rank);
        if (!ranked) continue;

        const member = await guild.members.fetch(ranked.userId).catch(() => null);
        if (!member) continue;

        if (reward.roleId) {
          await member.roles.add(reward.roleId).catch(() => null);
        }

        if (reward.coins && economyEnabled) {
          await prisma.rpgProfile.updateMany({
            where: { guildId, userId: ranked.userId },
            data: { balance: { increment: reward.coins } },
          });
        }
      }
    }
  }

  // Le classement RP se clôt avec la saison de leveling : le module Ranked se
  // greffe sur ce calendrier plutôt que d'en ouvrir un second. Seul le RP est
  // remis à zéro - l'XP archivée juste au-dessus poursuit son cumul.
  const { closeRankedSeasonForLevelingSeason } = await import('./ranked/rankedSeasonService.js');
  await closeRankedSeasonForLevelingSeason(client, guildId, seasonId, rewards).catch(() => null);

  logger.info('Season', `Saison #${season.number} terminée pour ${guildId}`);
  return true;
}

export async function getSeasonLeaderboard(guildId: string, seasonId: string, limit = 20) {
  return prismaRead.seasonSnapshot.findMany({
    where: { guildId, seasonId },
    orderBy: { rank: 'asc' },
    take: limit,
  });
}

export async function checkAndProgressSeasons(client: Client): Promise<void> {
  const now = new Date();

  const toStart = await prismaRead.levelingSeason.findMany({
    where: { status: 'UPCOMING', startDate: { lte: now } },
  });

  for (const season of toStart) {
    if (!(await isModuleEnabled(season.guildId, 'seasons'))) continue;
    await startSeason(season.guildId, season.id);
    logger.info('Season', `Saison #${season.number} démarrée automatiquement pour ${season.guildId}`);
  }

  const toEnd = await prismaRead.levelingSeason.findMany({
    where: { status: 'ACTIVE', endDate: { lte: now } },
  });

  for (const season of toEnd) {
    if (!(await isModuleEnabled(season.guildId, 'seasons'))) continue;
    await endSeason(client, season.guildId, season.id);
  }
}

export async function getSeasonsDashboardData(guildId: string) {
  const [seasons, activeSeason] = await Promise.all([
    getAllSeasons(guildId),
    prismaRead.levelingSeason.findFirst({ where: { guildId, status: 'ACTIVE' } }),
  ]);

  let activeLeaderboard: any[] = [];
  if (activeSeason) {
    const members = await prismaRead.memberLevel.findMany({
      where: { guildId },
      orderBy: { xp: 'desc' },
      take: 20,
    });
    activeLeaderboard = members.map((m, i) => ({
      userId: m.userId,
      xp: m.xp,
      level: m.level,
      rank: i + 1,
    }));
  }

  return { seasons, activeSeason, activeLeaderboard };
}

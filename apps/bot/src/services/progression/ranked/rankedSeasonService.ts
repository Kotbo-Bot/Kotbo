/**
 * Remise à zéro saisonnière du RP.
 *
 * Le module se greffe sur les saisons de leveling déjà en place
 * (`LevelingSeason`) plutôt que d'ouvrir un calendrier concurrent : un serveur
 * n'a qu'une saison à la fois, et le staff n'a pas à en gérer deux jeux de
 * dates. Seul le RP est remis à zéro - l'XP archivée par `SeasonSnapshot`
 * poursuit son cumul.
 */

import type { Client } from 'discord.js';
import { resolveRankedTier } from '@kotbo/shared';
import prisma, { prismaRead } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { isModuleEnabled } from '../../core/moduleGate.js';
import { getGuildLadder, getRankedConfigSafe } from './rankedConfigService.js';
import { invalidateGlobalLeaderboard } from './rankedLeaderboardService.js';

const LOG_TAG = 'RankedSeason';
const ARCHIVE_LIMIT = 500;

export type SeasonResetMode =
  /** Tout le monde repart de zéro. */
  | 'FULL'
  /** Chacun conserve une fraction de son RP (« soft reset » compétitif). */
  | 'SOFT';

export type RankedSeasonResetResult = {
  archived: number;
  reset: number;
  rewarded: number;
};

/**
 * Clôt la saison RP : archive le classement, applique les récompenses, remet
 * les compteurs à zéro.
 *
 * L'archivage précède la remise à zéro et se fait dans une transaction avec
 * elle : une coupure entre les deux effacerait un classement de saison sans
 * jamais l'avoir enregistré.
 */
export async function closeRankedSeason(
  client: Client | null,
  guildId: string,
  seasonId: string,
  options: { mode?: SeasonResetMode; keepRatio?: number; rewards?: Array<{ rank: number; roleId?: string; coins?: number }> } = {},
): Promise<RankedSeasonResetResult> {
  const mode = options.mode ?? 'SOFT';
  // 0.25 : assez pour que le rang de la saison passée reste un avantage
  // ressenti, trop peu pour que le classement soit figé dès la reprise.
  const keepRatio = mode === 'FULL' ? 0 : Math.min(0.9, Math.max(0, options.keepRatio ?? 0.25));

  const ladder = await getGuildLadder(guildId);

  const standings = await prismaRead.rankedMember.findMany({
    where: { guildId, rp: { gt: 0 } },
    orderBy: [{ rp: 'desc' }, { userId: 'asc' }],
    take: ARCHIVE_LIMIT,
  });

  const entries = standings.map((member, index) => ({
    guildId,
    seasonId,
    userId: member.userId,
    rp: member.rp,
    rank: index + 1,
    tierKey: resolveRankedTier(member.rp, ladder).key,
    peakRp: member.peakRp,
    bestStreak: member.bestStreak,
  }));

  await prisma.$transaction(async (tx) => {
    if (entries.length > 0) {
      await tx.rankedSeasonEntry.createMany({ data: entries, skipDuplicates: true });
    }

    if (keepRatio <= 0) {
      await tx.rankedMember.updateMany({
        where: { guildId },
        data: { rp: 0, peakRp: 0, peakTierKey: null, previousTierKey: null, tierKey: ladder[0].key, lastDecayDate: null },
      });
    } else {
      // Le ratio ne se traduit pas en une seule requête SQL portable via
      // Prisma : les membres sont donc réécrits un par un, mais uniquement
      // ceux qui ont du RP - les autres sont déjà à zéro.
      for (const member of standings) {
        const kept = Math.floor(member.rp * keepRatio);
        await tx.rankedMember.update({
          where: { id: member.id },
          data: {
            rp: kept,
            peakRp: kept,
            peakTierKey: null,
            previousTierKey: null,
            tierKey: resolveRankedTier(kept, ladder).key,
            lastDecayDate: null,
          },
        });
      }
      await tx.rankedMember.updateMany({
        where: { guildId, rp: { lte: 0 } },
        data: { peakRp: 0, tierKey: ladder[0].key, peakTierKey: null, previousTierKey: null, lastDecayDate: null },
      });
    }
  });

  let rewarded = 0;
  if (client && options.rewards?.length) {
    rewarded = await grantSeasonRewards(client, guildId, entries, options.rewards);
  }

  await invalidateGlobalLeaderboard();
  logger.info(LOG_TAG, `Saison RP clôturée sur ${guildId} : ${entries.length} archivés, mode ${mode}`);

  return { archived: entries.length, reset: standings.length, rewarded };
}

async function grantSeasonRewards(
  client: Client,
  guildId: string,
  entries: Array<{ userId: string; rank: number }>,
  rewards: Array<{ rank: number; roleId?: string; coins?: number }>,
): Promise<number> {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return 0;

  let granted = 0;
  // Les pièces appartiennent à l'économie : éteinte, seuls les rôles sont remis.
  const economyEnabled = await isModuleEnabled(guildId, 'economy');

  for (const reward of rewards) {
    const winner = entries.find((entry) => entry.rank === reward.rank);
    if (!winner) continue;

    if (reward.roleId) {
      const member = await guild.members.fetch(winner.userId).catch(() => null);
      if (member) await member.roles.add(reward.roleId).catch(() => null);
    }

    if (economyEnabled && reward.coins && reward.coins > 0) {
      await prisma.rpgProfile.updateMany({
        where: { guildId, userId: winner.userId },
        data: { balance: { increment: reward.coins } },
      }).catch(() => null);
    }

    granted++;
  }

  return granted;
}

/** Classement archivé d'une saison passée. */
export async function getRankedSeasonStandings(guildId: string, seasonId: string, limit = 25) {
  return prismaRead.rankedSeasonEntry.findMany({
    where: { guildId, seasonId },
    orderBy: { rank: 'asc' },
    take: Math.min(100, Math.max(1, limit)),
  });
}

/**
 * Clôture automatique branchée sur la saison de leveling qui vient de se
 * terminer. Sans configuration Ranked active, la saison de leveling suit son
 * cours normal et rien n'est touché.
 */
export async function closeRankedSeasonForLevelingSeason(
  client: Client | null,
  guildId: string,
  seasonId: string,
  rewards?: Array<{ rank: number; roleId?: string; coins?: number }>,
): Promise<RankedSeasonResetResult | null> {
  const config = await getRankedConfigSafe(guildId);
  if (!config?.enabled) return null;

  return closeRankedSeason(client, guildId, seasonId, { mode: 'SOFT', rewards }).catch((err) => {
    logger.error(LOG_TAG, `Clôture de saison RP impossible sur ${guildId}:`, err);
    return null;
  });
}

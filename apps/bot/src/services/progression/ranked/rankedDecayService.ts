/**
 * Decay quotidien : le RP redescend quand le membre décroche.
 *
 * Rappel structurant : seul le RP baisse. `MemberLevel.xp` n'est jamais touché,
 * sinon un membre absent perdrait des niveaux, donc des rôles de récompense
 * déjà attribués, et rejouerait toutes ses annonces de montée en revenant.
 */

import type { Client } from 'discord.js';
import { computeScheduledDecay, rankedDayKey, rankedFloorRp, resolveRankedTier } from '@kotbo/shared';
import prisma, { prismaRead } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { decayConfigFromRankedConfig, getGuildLadder, getOrCreateRankedConfig } from './rankedConfigService.js';
import { syncTierRoles } from './rankedService.js';

const LOG_TAG = 'RankedDecay';
const BATCH_SIZE = 500;

export type GuildDecayReport = {
  guildId: string;
  scanned: number;
  affected: number;
  rpLost: number;
  demoted: number;
};

/**
 * Applique le decay à une guilde.
 *
 * Les membres sont traités par lots et filtrés en base : un serveur de 50 000
 * membres n'a en général qu'une poignée de lignes éligibles, il serait absurde
 * de toutes les rapatrier pour n'en modifier que quelques-unes.
 */
export async function runGuildDecay(guildId: string, client: Client | null): Promise<GuildDecayReport> {
  const report: GuildDecayReport = { guildId, scanned: 0, affected: 0, rpLost: 0, demoted: 0 };

  const config = await getOrCreateRankedConfig(guildId).catch(() => null);
  if (!config?.enabled || !config.decayEnabled) return report;

  const ladder = await getGuildLadder(guildId);
  const decayConfig = decayConfigFromRankedConfig(config, ladder);
  if (!decayConfig.enabled) return report;
  if (decayConfig.rpPerDay <= 0 && decayConfig.percentPerDay <= 0) return report;

  const today = rankedDayKey();
  const floorRp = rankedFloorRp(config.decayFloorTierKey, ladder);
  const cutoffDate = rankedDayKey(new Date(Date.now() - decayConfig.graceDays * 86_400_000));

  let cursor: string | undefined;

  for (;;) {
    const batch = await prismaRead.rankedMember.findMany({
      where: {
        guildId,
        rp: { gt: floorRp },
        // `lt` sur une clé `YYYY-MM-DD` : l'ordre lexicographique de ce format
        // est l'ordre chronologique, ce qui évite une colonne date en double.
        OR: [{ lastActiveDate: null }, { lastActiveDate: { lt: cutoffDate } }],
        NOT: { lastDecayDate: today },
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    report.scanned += batch.length;

    for (const member of batch) {
      const outcome = computeScheduledDecay({
        rp: member.rp,
        lastActiveDate: member.lastActiveDate,
        lastDecayDate: member.lastDecayDate,
        today,
      }, decayConfig);

      if (outcome.lost <= 0) {
        // La date est tout de même posée : sans elle, un membre inactif mais
        // protégé par le plancher serait réexaminé à chaque passage du cron.
        await prisma.rankedMember.update({
          where: { id: member.id },
          data: { lastDecayDate: today },
        }).catch(() => null);
        continue;
      }

      const tierBefore = resolveRankedTier(member.rp, ladder);
      const tierAfter = resolveRankedTier(outcome.newRp, ladder);
      const demoted = tierAfter.key !== tierBefore.key;

      await prisma.rankedMember.update({
        where: { id: member.id },
        data: {
          rp: outcome.newRp,
          tierKey: tierAfter.key,
          previousTierKey: demoted ? tierBefore.key : member.previousTierKey,
          lastDecayDate: today,
        },
      }).catch(() => null);

      await prisma.rankedRpLog.create({
        data: {
          guildId,
          userId: member.userId,
          delta: -outcome.lost,
          rpAfter: outcome.newRp,
          source: 'decay',
          detail: `${outcome.daysApplied}d`,
        },
      }).catch(() => null);

      report.affected++;
      report.rpLost += outcome.lost;

      if (demoted) {
        report.demoted++;
        // Les rôles suivent la rétrogradation, sans annonce : personne n'a
        // besoin d'être notifié publiquement de sa chute.
        if (client) await syncTierRoles(guildId, member.userId, tierAfter.key, client).catch(() => null);
      }
    }

    if (batch.length < BATCH_SIZE) break;
  }

  if (report.affected > 0) {
    logger.info(LOG_TAG, `Decay ${guildId} : ${report.affected} membres, -${report.rpLost} RP, ${report.demoted} rétrogradations`);
  }

  return report;
}

/** Passage quotidien sur toutes les guildes ayant le decay actif. */
export async function runDecaySweep(client: Client | null): Promise<GuildDecayReport[]> {
  const configs = await prismaRead.rankedConfig.findMany({
    where: { enabled: true, decayEnabled: true },
    select: { guildId: true },
  });

  const reports: GuildDecayReport[] = [];
  for (const { guildId } of configs) {
    const report = await runGuildDecay(guildId, client).catch((err) => {
      logger.error(LOG_TAG, `Decay impossible sur ${guildId}:`, err);
      return null;
    });
    if (report) reports.push(report);
  }

  return reports;
}

/**
 * Simulation, sans écriture : ce que le prochain passage retirerait.
 * Le dashboard s'en sert pour montrer l'impact d'un réglage avant de l'appliquer.
 */
export async function previewGuildDecay(guildId: string, limit = 25) {
  const config = await getOrCreateRankedConfig(guildId).catch(() => null);
  if (!config) return { affected: 0, rpLost: 0, samples: [] as Array<{ userId: string; rp: number; newRp: number; lost: number }> };

  const ladder = await getGuildLadder(guildId);
  const decayConfig = decayConfigFromRankedConfig(config, ladder);
  const today = rankedDayKey();
  const cutoffDate = rankedDayKey(new Date(Date.now() - decayConfig.graceDays * 86_400_000));

  const candidates = await prismaRead.rankedMember.findMany({
    where: {
      guildId,
      rp: { gt: decayConfig.floorRp },
      OR: [{ lastActiveDate: null }, { lastActiveDate: { lt: cutoffDate } }],
    },
    orderBy: { rp: 'desc' },
    take: 1000,
  });

  let affected = 0;
  let rpLost = 0;
  const samples: Array<{ userId: string; rp: number; newRp: number; lost: number }> = [];

  for (const member of candidates) {
    const outcome = computeScheduledDecay({
      rp: member.rp,
      lastActiveDate: member.lastActiveDate,
      lastDecayDate: member.lastDecayDate,
      today,
    }, { ...decayConfig, enabled: true });

    if (outcome.lost <= 0) continue;
    affected++;
    rpLost += outcome.lost;
    if (samples.length < limit) {
      samples.push({ userId: member.userId, rp: member.rp, newRp: outcome.newRp, lost: outcome.lost });
    }
  }

  return { affected, rpLost, samples };
}

/**
 * Récompenses de l'activité sur le site communautaire.
 *
 * Chaque versement est inscrit dans `SiteRewardLog` sous une clé de référence
 * unique (jour, page, commentaire…) avant d'être crédité : rejouer une action,
 * cliquer deux fois ou recharger ne paie jamais deux fois. Les pièces passent
 * par l'économie du bot, l'XP par le leveling ; un module éteint ne verse rien
 * de sa part.
 */

import type { Client } from 'discord.js';
import type { SiteRewardKind } from '@prisma/client';
import {
  normalizeSiteRewards,
  previousSiteDayKey,
  siteDayKey,
  siteDayStart,
  siteStreakBonus,
  type SiteRewardAmount,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getModuleStates } from '../core/moduleGate.js';
import { creditBalance, getOrCreateRpgProfile } from '../features/economyService.js';
import { addXp } from '../progression/levelingService.js';
import { getSiteByGuild } from './siteService.js';

export interface SiteRewardResult extends SiteRewardAmount {
  kind: SiteRewardKind;
  /** Série en cours (visites ou votes), quand elle s'applique. */
  streak?: number;
}

/**
 * Verse une récompense, une seule fois par clé. Renvoie ce qui a été versé,
 * ou `null` : récompenses coupées, plafond du jour atteint, déjà versée, ou
 * aucun module pour la recevoir.
 */
export async function grantSiteReward(
  client: Client,
  guildId: string,
  userId: string,
  kind: SiteRewardKind,
  refKey: string,
  extraCoins = 0,
): Promise<SiteRewardResult | null> {
  const site = await getSiteByGuild(guildId);
  if (!site) return null;
  const settings = normalizeSiteRewards(site.rewards);
  if (!settings.enabled) return null;

  const base: SiteRewardAmount =
    kind === 'DAILY' ? settings.daily : kind === 'PARTICIPATION' ? settings.participation : kind === 'READ' ? settings.read : settings.vote;
  const states = await getModuleStates(guildId);
  const coins = states.economy === false ? 0 : base.coins + extraCoins;
  const xp = states.leveling === false ? 0 : base.xp;
  if (coins <= 0 && xp <= 0) return null;

  const cap = kind === 'PARTICIPATION' ? settings.participation.dailyCap : kind === 'READ' ? settings.read.dailyCap : null;
  if (cap !== null) {
    const today = await prisma.siteRewardLog.count({ where: { guildId, userId, kind, createdAt: { gte: siteDayStart() } } });
    if (today >= cap) return null;
  }

  try {
    await prisma.siteRewardLog.create({ data: { guildId, userId, kind, refKey, coins, xp } });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return null;
    throw err;
  }

  if (coins > 0) {
    const profile = await getOrCreateRpgProfile(guildId, userId);
    await creditBalance(profile.id, coins);
  }
  if (xp > 0) {
    await addXp(guildId, userId, xp, client).catch((err: unknown) => logger.warn('Site', `XP de récompense non versée (${guildId}/${userId}) :`, err));
  }
  return { kind, coins, xp };
}

/**
 * Première visite du jour d'un membre connecté : récompense et série. La
 * série continue si la dernière visite date de la veille, sinon elle repart.
 */
export async function claimDailyVisit(client: Client, guildId: string, userId: string): Promise<SiteRewardResult | null> {
  const today = siteDayKey();
  const current = await prisma.siteMemberSettings.findUnique({ where: { guildId_userId: { guildId, userId } } });
  if (current?.lastDailyKey === today) return null;

  const streak = current?.lastDailyKey === previousSiteDayKey(today) ? current.dailyStreak + 1 : 1;
  // Écriture conditionnelle : deux onglets ouverts en même temps ne comptent qu'une visite.
  const updated = await prisma.siteMemberSettings.updateMany({
    where: { guildId, userId, OR: [{ lastDailyKey: null }, { lastDailyKey: { not: today } }] },
    data: { lastDailyKey: today, dailyStreak: streak },
  });
  if (updated.count === 0) {
    if (current) return null;
    try {
      await prisma.siteMemberSettings.create({ data: { guildId, userId, lastDailyKey: today, dailyStreak: 1 } });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') return null;
      throw err;
    }
  }

  const site = await getSiteByGuild(guildId);
  const settings = normalizeSiteRewards(site?.rewards);
  const bonus = siteStreakBonus(streak, settings.daily.streakBonus, settings.daily.streakCap);
  const reward = await grantSiteReward(client, guildId, userId, 'DAILY', `daily:${today}`, bonus);
  return reward ? { ...reward, streak } : null;
}

/** Récompenses récentes d'un membre, pour son espace. */
export async function listSiteRewards(guildId: string, userId: string, take = 30) {
  return prisma.siteRewardLog.findMany({
    where: { guildId, userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { kind: true, coins: true, xp: true, createdAt: true },
  });
}

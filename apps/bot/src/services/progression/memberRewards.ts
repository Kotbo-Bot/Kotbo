/**
 * Gains d'un membre en XP de niveau et en pièces, versés puis repris au besoin.
 *
 * Chaque gain passe par le module qui le tient : l'XP par `addXp`, qui
 * annonce et donne ses rôles ; les pièces sur le profil d'économie. Un gain
 * n'est versé que si son module est actif, et un gain qui échoue n'empêche
 * pas l'autre. Ce qui a réellement été versé est rendu, pour être gardé par
 * l'appelant et repris plus tard. Servi par la réputation et les suggestions.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { addXp, removeXp } from './levelingService.js';
import { getOrCreateRpgProfile } from '../features/economyService.js';

export interface MemberGains {
  xp: number;
  coins: number;
}

/** `scope` nomme le module dans les journaux, `reason` le gain (« de remerciement »…). */
export interface GainsContext {
  scope: string;
  reason: string;
  channelId?: string;
}

export async function grantMemberGains(
  client: Client,
  guildId: string,
  userId: string,
  amounts: MemberGains,
  context: GainsContext,
): Promise<MemberGains> {
  const gains: MemberGains = { xp: 0, coins: 0 };

  if (amounts.xp > 0 && await isModuleEnabled(guildId, 'leveling')) {
    try {
      await addXp(guildId, userId, amounts.xp, client, context.channelId);
      gains.xp = amounts.xp;
    } catch (err) {
      logger.warn(context.scope, `XP ${context.reason} non versée à ${userId}`, err);
    }
  }

  if (amounts.coins > 0 && await isModuleEnabled(guildId, 'economy')) {
    try {
      const profile = await getOrCreateRpgProfile(guildId, userId);
      await prisma.rpgProfile.update({ where: { id: profile.id }, data: { balance: { increment: amounts.coins } } });
      gains.coins = amounts.coins;
    } catch (err) {
      logger.warn(context.scope, `Pièces ${context.reason} non versées à ${userId}`, err);
    }
  }

  return gains;
}

/**
 * Reprend des gains versés. Les pièces déjà dépensées ne creusent pas de
 * dette : le solde descend à zéro, jamais en dessous. Elles sont reprises même
 * si Économie a été éteint depuis, puisqu'elles ont été versées.
 */
export async function reclaimMemberGains(
  client: Client,
  guildId: string,
  userId: string,
  gains: MemberGains,
  context: Omit<GainsContext, 'channelId'>,
): Promise<void> {
  if (gains.xp > 0) {
    await removeXp(guildId, userId, gains.xp, client).catch((err) => {
      logger.warn(context.scope, `XP ${context.reason} non reprise à ${userId}`, err);
    });
  }

  if (gains.coins > 0) {
    try {
      const where = { guildId, userId };
      const { count } = await prisma.rpgProfile.updateMany({
        where: { ...where, balance: { gte: gains.coins } },
        data: { balance: { decrement: gains.coins } },
      });
      if (count === 0) {
        await prisma.rpgProfile.updateMany({ where: { ...where, balance: { lt: gains.coins } }, data: { balance: 0 } });
      }
    } catch (err) {
      logger.warn(context.scope, `Pièces ${context.reason} non reprises à ${userId}`, err);
    }
  }
}

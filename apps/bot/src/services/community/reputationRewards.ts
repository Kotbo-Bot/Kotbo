/**
 * Gains du membre remercié : XP de niveau et pièces, réglés par serveur.
 *
 * Chaque gain passe par le module qui le tient : l'XP par `addXp`, qui
 * annonce et donne ses rôles ; les pièces sur le profil d'économie. Un gain
 * n'est versé que si son module est actif, et un gain qui échoue n'empêche
 * pas l'autre. Ce qui a réellement été versé est rendu, pour être gardé sur
 * le vote et repris s'il est retiré.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { addXp, removeXp } from '../progression/levelingService.js';
import { getOrCreateRpgProfile } from '../features/economyService.js';
import type { ReputationSettings } from './reputationService.js';

export interface RepGains {
  xp: number;
  coins: number;
}

export async function grantRepRewards(
  client: Client,
  guildId: string,
  receiverId: string,
  settings: Pick<ReputationSettings, 'xpPerRep' | 'coinsPerRep'>,
  channelId: string | undefined,
): Promise<RepGains> {
  const gains: RepGains = { xp: 0, coins: 0 };

  if (settings.xpPerRep > 0 && await isModuleEnabled(guildId, 'leveling')) {
    try {
      await addXp(guildId, receiverId, settings.xpPerRep, client, channelId);
      gains.xp = settings.xpPerRep;
    } catch (err) {
      logger.warn('Reputation', `XP de remerciement non versée à ${receiverId}`, err);
    }
  }

  if (settings.coinsPerRep > 0 && await isModuleEnabled(guildId, 'economy')) {
    try {
      const profile = await getOrCreateRpgProfile(guildId, receiverId);
      await prisma.rpgProfile.update({ where: { id: profile.id }, data: { balance: { increment: settings.coinsPerRep } } });
      gains.coins = settings.coinsPerRep;
    } catch (err) {
      logger.warn('Reputation', `Pièces de remerciement non versées à ${receiverId}`, err);
    }
  }

  return gains;
}

/**
 * Reprend les gains d'un vote retiré. Les pièces déjà dépensées ne creusent
 * pas de dette : le solde descend à zéro, jamais en dessous. Elles sont
 * reprises même si Économie a été éteint depuis, puisqu'elles ont été versées.
 */
export async function reclaimRepRewards(client: Client, guildId: string, receiverId: string, gains: RepGains): Promise<void> {
  if (gains.xp > 0) {
    await removeXp(guildId, receiverId, gains.xp, client).catch((err) => {
      logger.warn('Reputation', `XP de remerciement non reprise à ${receiverId}`, err);
    });
  }

  if (gains.coins > 0) {
    try {
      const where = { guildId, userId: receiverId };
      const { count } = await prisma.rpgProfile.updateMany({
        where: { ...where, balance: { gte: gains.coins } },
        data: { balance: { decrement: gains.coins } },
      });
      if (count === 0) {
        await prisma.rpgProfile.updateMany({ where: { ...where, balance: { lt: gains.coins } }, data: { balance: 0 } });
      }
    } catch (err) {
      logger.warn('Reputation', `Pièces de remerciement non reprises à ${receiverId}`, err);
    }
  }
}

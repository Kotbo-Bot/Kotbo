/**
 * Gains du membre remercié : XP de niveau et pièces, réglés par serveur.
 *
 * Chaque gain passe par le module qui le tient : l'XP par `addXp`, qui vérifie
 * déjà que Niveaux est actif, annonce et donne ses rôles ; les pièces sur le
 * profil d'économie, seulement si Économie est actif. Un gain qui échoue
 * n'empêche pas l'autre.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { addXp } from '../progression/levelingService.js';
import { getOrCreateRpgProfile } from '../features/economyService.js';
import type { ReputationSettings } from './reputationService.js';

export async function grantRepRewards(
  client: Client,
  guildId: string,
  receiverId: string,
  settings: Pick<ReputationSettings, 'xpPerRep' | 'coinsPerRep'>,
  channelId: string | undefined,
): Promise<void> {
  if (settings.xpPerRep > 0) {
    await addXp(guildId, receiverId, settings.xpPerRep, client, channelId).catch((err) => {
      logger.warn('Reputation', `XP de remerciement non versée à ${receiverId}`, err);
    });
  }

  if (settings.coinsPerRep > 0 && await isModuleEnabled(guildId, 'economy')) {
    try {
      const profile = await getOrCreateRpgProfile(guildId, receiverId);
      await prisma.rpgProfile.update({ where: { id: profile.id }, data: { balance: { increment: settings.coinsPerRep } } });
    } catch (err) {
      logger.warn('Reputation', `Pièces de remerciement non versées à ${receiverId}`, err);
    }
  }
}

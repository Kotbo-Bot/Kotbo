/**
 * Récompenses libres d'une quête : XP de niveau, rôle, objet, inscription à un concours, message.
 *
 * Elles se versent après les récompenses de base (pièces, XP RPG, points de clan), et chacune
 * est isolée : une récompense qui échoue — rôle trop haut pour le bot, objet supprimé — ne
 * prive pas le membre des suivantes, et ne défait pas une quête déjà payée.
 */

import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { isAutoGrantableRole } from '../../../utils/adminLockPermissions.js';
import { addXp } from '../../progression/levelingService.js';
import { addInventoryQuantity } from './rpgInventoryWrites.js';
import { expectBotRoleChange } from '../workflow/roleEcho.js';
import { renderQuestMessage, type QuestReward } from './rpgQuestRules.js';

export interface QuestRewardTarget {
  guildId: string;
  name: string;
  target: number;
}

export async function grantQuestRewards(
  client: Client,
  quest: QuestRewardTarget,
  rewards: readonly QuestReward[],
  userId: string,
  channelId?: string,
): Promise<void> {
  for (const reward of rewards) {
    try {
      await grantOne(client, quest, reward, userId, channelId);
    } catch (error) {
      logger.error('RpgQuest', `Récompense ${reward.type} non versée à ${userId} sur ${quest.guildId} :`, error);
    }
  }
}

async function grantOne(
  client: Client,
  quest: QuestRewardTarget,
  reward: QuestReward,
  userId: string,
  channelId?: string,
): Promise<void> {
  const { guildId } = quest;

  switch (reward.type) {
    case 'LEVEL_XP':
      await addXp(guildId, userId, reward.amount, client, channelId, { fromQuest: true });
      return;

    case 'ROLE':
      await grantRole(client, guildId, userId, reward.roleId, reward.durationHours);
      return;

    case 'ITEM': {
      // L'identifiant est saisi à la main : un objet d'un autre serveur ne doit jamais passer.
      const item = await prisma.rpgItem.findFirst({
        where: { id: reward.itemId, OR: [{ guildId: null }, { guildId }] },
        select: { id: true },
      });
      if (!item) {
        logger.error('RpgQuest', `Objet ${reward.itemId} introuvable sur ${guildId} : récompense de « ${quest.name} » non remise à ${userId}.`);
        return;
      }
      await prisma.$transaction(async (tx) => {
        const profile = await tx.rpgProfile.upsert({
          where: { guildId_userId: { guildId, userId } },
          update: {},
          create: { guildId, userId },
          select: { id: true },
        });
        await addInventoryQuantity(tx, profile.id, item.id, reward.quantity);
      });
      return;
    }

    case 'GIVEAWAY_ENTRY':
      // Une inscription directe plutôt que le bouton : celui-ci bascule, et inscrirait puis
      // désinscrirait un membre déjà présent. Le garde-fou du WHERE évite aussi un doublon.
      await prisma.$executeRaw`
        UPDATE giveaways
        SET participants = array_append(participants, ${userId})
        WHERE id = ${reward.giveawayId}
          AND "guildId" = ${guildId}
          AND ended = false
          AND NOT (${userId} = ANY(participants))`;
      return;

    case 'MESSAGE': {
      const content = renderQuestMessage(reward.content, { userId, quest: quest.name, target: quest.target });
      // Seul le membre récompensé peut être mentionné : le texte est libre.
      const allowedMentions = { parse: [] as never[], users: [userId] };

      if (reward.channelId) {
        const channel = await client.channels.fetch(reward.channelId).catch(() => null);
        if (channel?.isTextBased() && 'guildId' in channel && channel.guildId === guildId && 'send' in channel) {
          await channel.send({ content, allowedMentions });
        }
        return;
      }
      const user = await client.users.fetch(userId).catch(() => null);
      await user?.send({ content }).catch(() => null);
      return;
    }
  }
}

async function grantRole(
  client: Client,
  guildId: string,
  userId: string,
  roleId: string,
  durationHours?: number,
): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const role = guild.roles.cache.get(roleId);
  if (!role) return;
  // Une quête ne donne jamais un rôle Administrateur ; et le bot ne peut poser qu'un rôle
  // situé sous le sien.
  if (!isAutoGrantableRole(role) || !role.editable) {
    logger.warn('RpgQuest', `Rôle ${role.name} non attribuable par une quête sur ${guildId}.`);
    return;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const key = { guildId, userId, roleId };
  const existing = durationHours
    ? await prisma.workflowTemporaryRole.findUnique({ where: { guildId_userId_roleId: key } })
    : null;

  // Un rôle déjà porté sans trace d'une attribution temporaire vient de quelqu'un d'autre :
  // le retirer à l'échéance le reprendrait à tort.
  if (durationHours && !existing && member.roles.cache.has(roleId)) return;

  if (durationHours) {
    const requested = new Date(Date.now() + durationHours * 3_600_000);
    const expiresAt = existing && existing.expiresAt > requested ? existing.expiresAt : requested;
    // L'échéance s'écrit avant le rôle : dans l'ordre inverse, une panne entre les deux
    // laisserait un rôle que personne ne retirerait.
    await prisma.workflowTemporaryRole.upsert({
      where: { guildId_userId_roleId: key },
      create: { ...key, expiresAt },
      update: { expiresAt, attempts: 0 },
    });
  }

  if (member.roles.cache.has(roleId)) return;
  const forget = expectBotRoleChange(guildId, userId, roleId, 'added', null);
  try {
    await member.roles.add(role, 'Récompense de quête');
  } catch (error) {
    forget();
    if (durationHours && !existing) await prisma.workflowTemporaryRole.deleteMany({ where: key }).catch(() => null);
    throw error;
  }
}

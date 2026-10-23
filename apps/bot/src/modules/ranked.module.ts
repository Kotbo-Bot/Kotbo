/**
 * Ranked Module - Bus-based subscriber
 *
 * Le RP d'activité (texte, vocal) est crédité depuis `addXp` : il se greffe sur
 * le pipeline d'XP et hérite de ses garde-fous. Ce module ne couvre donc que la
 * seule source que le leveling ignore, la réaction - sans laquelle un
 * « Reaction Storm » n'aurait rien à récompenser.
 */

import type { Client } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import { getOrCreateLevelConfig } from '../services/progression/levelingService.js';
import { creditReactionRp } from '../services/progression/ranked/rankedService.js';
import { logger } from '../utils/logger.js';
import { isProgressionBlocked } from '../services/progression/progressionBlacklist.js';

const MODULE_NAME = 'ranked';

export function registerRankedBusSubscribers(client: Client): void {
  kotboEventBus.subscribe('reaction:add', async (payload) => {
    // Les exclusions de salons du leveling font foi : un salon qui ne donne pas
    // d'XP ne doit pas donner de RP non plus, sinon les salons de spam ou de
    // bots redeviennent rentables par les réactions.
    const levelConfig = await getOrCreateLevelConfig(payload.guildId).catch(() => null);
    // Le prestige dépend du leveling dans le registre de modules. Le RP
    // d'activité hérite de cette dépendance en passant par `addXp` ; la
    // réaction, elle, ne passe nulle part ailleurs et doit la vérifier ici,
    // sinon éteindre le leveling laisserait les réactions alimenter le
    // classement.
    if (!levelConfig?.enabled) return;
    if (levelConfig.ignoredChannels?.includes(payload.channelId)) return;

    const guild = client.guilds.cache.get(payload.guildId);
    const member = guild ? await guild.members.fetch(payload.userId).catch(() => null) : null;
    if (member && levelConfig.ignoredRoles?.some((roleId) => member.roles.cache.has(roleId))) return;
    const channel = guild?.channels.cache.get(payload.channelId);
    if (await isProgressionBlocked(payload.guildId, {
      userId: payload.userId,
      roleIds: member?.roles.cache.keys() ?? [],
      channelIds: [payload.channelId, channel?.parentId, channel?.isThread() ? channel.parent?.parentId : null],
    })) return;

    await creditReactionRp(payload.guildId, payload.userId, client);
  }, MODULE_NAME);

  logger.info('Modules', `Module "${MODULE_NAME}" enregistre sur le bus d'events.`);
}

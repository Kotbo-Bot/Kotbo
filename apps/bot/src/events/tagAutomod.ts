import { Events, type Client } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import { logger } from '../utils/logger.js';
import { evaluateTagMember, runTagAutomodSweep } from '../services/moderation/tagAutomod/tagAutomodService.js';
import { isInstanceBlocked } from '../services/system/instanceBlock.js';

const SWEEP_MS = 60_000;

/**
 * Automod des tags : contrôle à l'arrivée et à chaque changement de tag
 * (`member:tag`, publié par le suivi des tags), plus un balayage par minute
 * pour les escalades et les blocages temporaires.
 */
export function registerTagAutomodListener(client: Client): void {
  client.on(Events.GuildMemberAdd, (member) => {
    void evaluateTagMember(member, 'JOIN').catch((err) => logger.error('TagAutomod', 'Erreur GuildMemberAdd:', err));
  });

  kotboEventBus.subscribe('member:tag', async (payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    const member = guild?.members.cache.get(payload.userId) ?? (await guild?.members.fetch(payload.userId).catch(() => null));
    if (!member) return;
    await evaluateTagMember(member, 'TAG_CHANGE').catch((err) => logger.error('TagAutomod', 'Erreur member:tag:', err));
  });

  setInterval(() => {
    if (isInstanceBlocked()) return;
    void runTagAutomodSweep(client).catch((err) => logger.warn('TagAutomod', `Balayage impossible: ${String(err)}`));
  }, SWEEP_MS).unref?.();

  logger.success('TagAutomod', 'Automod des tags enregistré.');
}

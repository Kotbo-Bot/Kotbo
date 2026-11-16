/**
 * Gains du membre remercié : XP de niveau et pièces, réglés par serveur.
 * Le versement et la reprise sont ceux de `memberRewards`.
 */
import type { Client } from 'discord.js';
import { grantMemberGains, reclaimMemberGains, type MemberGains } from '../progression/memberRewards.js';
import type { ReputationSettings } from './reputationService.js';

export type RepGains = MemberGains;

const CONTEXT = { scope: 'Reputation', reason: 'de remerciement' };

export async function grantRepRewards(
  client: Client,
  guildId: string,
  receiverId: string,
  settings: Pick<ReputationSettings, 'xpPerRep' | 'coinsPerRep'>,
  channelId: string | undefined,
): Promise<RepGains> {
  return grantMemberGains(client, guildId, receiverId, { xp: settings.xpPerRep, coins: settings.coinsPerRep }, { ...CONTEXT, channelId });
}

/** Reprend les gains d'un vote retiré. */
export async function reclaimRepRewards(client: Client, guildId: string, receiverId: string, gains: RepGains): Promise<void> {
  await reclaimMemberGains(client, guildId, receiverId, gains, CONTEXT);
}

import type { Client } from 'discord.js';
import { getMemberIdentities } from '../moderation/memberIdentityService.js';

type InviterEntry = { inviterId: string | null };

/** Ajoute a chaque ligne d'usage la photo de l'inviteur, ou `null`. */
export function attachInviterAvatars<T extends InviterEntry>(
  usage: T[],
  identities: Map<string, { avatarUrl: string | null }>,
): Array<T & { avatarUrl: string | null }> {
  return usage.map((entry) => ({
    ...entry,
    avatarUrl: entry.inviterId ? identities.get(entry.inviterId)?.avatarUrl ?? null : null,
  }));
}

/**
 * Usage par inviteur pret pour le dashboard : sans avatar, le classement des
 * meilleurs inviteurs n'affiche que des initiales.
 */
export async function withInviterAvatars<T extends InviterEntry>(
  client: Client,
  guildId: string,
  usage: T[],
): Promise<Array<T & { avatarUrl: string | null }>> {
  const ids = usage.map((entry) => entry.inviterId).filter((id): id is string => Boolean(id));
  const identities = await getMemberIdentities(client, guildId, ids).catch(() => new Map());
  return attachInviterAvatars(usage, identities);
}

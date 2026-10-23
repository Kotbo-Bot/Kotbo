/**
 * Blacklist commune aux modules de progression.
 *
 * Un membre (ou un rôle, ou un salon) listé ne gagne plus d'XP ni de pièces, et
 * ses commandes et boutons de ces modules sont refusés. Le leveling garde ses
 * propres salons et rôles ignorés ; cette liste-ci vaut pour tous à la fois.
 */
import { getCachedGuild } from '../../utils/cache.js';

/** Modules du registre couverts par la blacklist. */
export const PROGRESSION_MODULES: ReadonlySet<string> = new Set([
  'leveling', 'seasons', 'prestige', 'economy', 'marketplace', 'quests', 'drops', 'clans', 'reputation',
]);

export interface ProgressionBlacklist {
  progressionBlacklistUserIds: string[];
  progressionBlacklistRoleIds: string[];
  progressionBlacklistChannelIds: string[];
}

export interface ProgressionActor {
  userId: string;
  roleIds: Iterable<string>;
  /** Le salon, puis ses parents (salon d'un fil, catégorie) : un parent listé couvre ses enfants. */
  channelIds: Array<string | null | undefined>;
}

export function isBlacklisted(list: ProgressionBlacklist | null | undefined, actor: ProgressionActor): boolean {
  if (!list) return false;
  if (list.progressionBlacklistUserIds?.includes(actor.userId)) return true;
  const roles = list.progressionBlacklistRoleIds ?? [];
  if (roles.length && [...actor.roleIds].some((id) => roles.includes(id))) return true;
  const channels = list.progressionBlacklistChannelIds ?? [];
  return channels.length > 0 && actor.channelIds.some((id) => !!id && channels.includes(id));
}

export async function isProgressionBlocked(guildId: string, actor: ProgressionActor): Promise<boolean> {
  return isBlacklisted(await getCachedGuild(guildId), actor);
}

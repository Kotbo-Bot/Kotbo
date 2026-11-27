/**
 * Référents partagés entre les cellules d'un réseau de serveurs : lectures en
 * base et sur Discord. Les règles sont dans wellbeingNetworkPolicy.ts.
 *
 * `GuildNetworkMember`, `WellbeingConfig` et `WellbeingCase` sont propres à
 * chaque serveur (networkScope.ts) : les `guildId` lus ici ne sont jamais
 * redirigés vers le serveur principal.
 */
import type { Client, Guild } from 'discord.js';
import prisma from '../../utils/db.js';
import { cellMemberIds, isCaseSubject, resolveWellbeingAccess } from './wellbeingPolicy.js';
import {
  networkPoolCandidates,
  networkReferentAllowed,
  sharesNetworkPool,
  type PoolCandidate,
} from './wellbeingNetworkPolicy.js';
import { cellActorOf, discordGuildOf } from './wellbeingRoles.js';

/** Serveurs du réseau de ce serveur, lui compris ; vide hors réseau. */
export async function networkGuildIds(guildId: string): Promise<string[]> {
  const membership = await prisma.guildNetworkMember.findFirst({ where: { guildId }, select: { networkId: true } });
  if (!membership) return [];
  const members = await prisma.guildNetworkMember.findMany({ where: { networkId: membership.networkId }, select: { guildId: true } });
  return members.map((member) => member.guildId);
}

/** Cellules du réseau qui partagent leurs référents, avec leur serveur Discord. */
async function sharingCells(client: Client, guildIds: readonly string[]) {
  const configs = await prisma.wellbeingConfig.findMany({ where: { guildId: { in: [...guildIds] } } });
  const cells: Array<{ config: (typeof configs)[number]; guild: Guild }> = [];
  for (const config of configs) {
    if (!sharesNetworkPool(config)) continue;
    const guild = await discordGuildOf(client, config.guildId);
    if (guild) cells.push({ config, guild });
  }
  return cells;
}

export interface NetworkPoolEntry extends PoolCandidate {
  /** Nom du membre sur le serveur de sa cellule : le dashboard ne le connaît pas ailleurs. */
  name: string;
  guildName: string;
  /** Dossiers actifs que ce membre suit déjà comme référent du réseau. */
  active: number;
}

/**
 * Référents du réseau proposés à la cellule de `guildId`. `available` est
 * faux hors réseau, ou si cette cellule ne partage pas.
 */
export async function networkPool(
  client: Client,
  guildId: string,
  excludeIds: readonly string[],
): Promise<{ available: boolean; candidates: NetworkPoolEntry[] }> {
  const guildIds = await networkGuildIds(guildId);
  if (guildIds.length < 2) return { available: false, candidates: [] };
  const cells = await sharingCells(client, guildIds);
  if (!cells.some((cell) => cell.config.guildId === guildId)) return { available: false, candidates: [] };

  const candidates = networkPoolCandidates(cells.map(({ config, guild }) => ({
    guildId: config.guildId,
    memberIds: cellMemberIds(config, [...guild.members.cache.values()].map((member) => ({ id: member.id, roleIds: [...member.roles.cache.keys()] }))),
  })), guildId, excludeIds);
  const followed = candidates.length > 0
    ? await prisma.wellbeingCase.findMany({
        where: { networkReferentId: { in: candidates.map((entry) => entry.userId) }, status: { not: 'CLOSED' }, deletedAt: null },
        select: { networkReferentId: true },
      })
    : [];
  const guilds = new Map(cells.map(({ config, guild }) => [config.guildId, guild]));
  return {
    available: true,
    candidates: candidates.map((entry) => ({
      ...entry,
      name: guilds.get(entry.guildId)?.members.cache.get(entry.userId)?.displayName ?? entry.userId,
      guildName: guilds.get(entry.guildId)?.name ?? entry.guildId,
      active: followed.filter((item) => item.networkReferentId === entry.userId).length,
    })),
  };
}

/**
 * Dossiers des autres serveurs du réseau confiés à `userId`, qu'il ouvre
 * depuis la cellule de `homeGuildId`. Chaque condition est revérifiée :
 * réseau commun, partage des deux côtés, appartenance à sa cellule.
 */
export async function networkReferentCaseRefs(
  client: Client,
  homeGuildId: string,
  userId: string,
  caseId?: string,
): Promise<Array<{ id: string; guildId: string }>> {
  const guildIds = await networkGuildIds(homeGuildId);
  if (guildIds.length < 2) return [];
  const cells = await sharingCells(client, guildIds);
  const home = cells.find((cell) => cell.config.guildId === homeGuildId);
  if (!home) return [];
  const isHomeTeamMember = resolveWellbeingAccess(home.config, await cellActorOf(home.guild, userId), false).isTeamMember;
  const sharing = new Set(cells.map((cell) => cell.config.guildId).filter((id) => id !== homeGuildId));

  const cases = await prisma.wellbeingCase.findMany({
    where: {
      networkReferentId: userId,
      networkReferentGuildId: homeGuildId,
      guildId: { in: [...sharing] },
      deletedAt: null,
      ...(caseId ? { id: caseId } : {}),
    },
    select: { id: true, guildId: true, subjectUserId: true, networkReferentId: true },
  });
  return cases
    .filter((item) => networkReferentAllowed({
      assigned: item.networkReferentId === userId,
      sameNetwork: guildIds.includes(item.guildId),
      caseCellShares: sharing.has(item.guildId),
      homeCellShares: true,
      isHomeTeamMember,
      isSubject: isCaseSubject(item.subjectUserId, userId),
    }))
    .map(({ id, guildId }) => ({ id, guildId }));
}

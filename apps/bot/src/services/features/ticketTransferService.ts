/**
 * Accès au salon d'un ticket après une prise en charge ou un transfert.
 *
 * Deux réglages du serveur, tous deux désactivés par défaut :
 * - `ticketClaimHidesSupport` : une fois pris, le ticket disparaît pour les
 *   rôles d'assistance (l'équipe responsable le garde toujours) ;
 * - `ticketClaimExclusive` : seul celui qui a pris le ticket peut y écrire.
 */
import { TextChannel, type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { recordHandlingEvent, type TicketHandlingEvent } from './ticketHandling.js';
import { listTicketPanelTypes, canManageTicket } from './ticketService.js';
import { ticketAccessRoleIds, ticketManagerRoleIds, ticketSupportRoleIds } from './ticketRoles.js';

type Config = Record<string, unknown>;
type TicketRow = { channelId: string | null; threadId: string | null; staffRoleId: string | null; userId: string };

const FULL_ACCESS = {
  ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AttachFiles: true,
} as const;

async function textChannelOf(client: Client, ticket: TicketRow): Promise<TextChannel | null> {
  const id = ticket.channelId;
  if (!id) return null;
  const channel = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
  return channel instanceof TextChannel ? channel : null;
}

type AccessPlan = {
  supportRoleIds: string[];
  managerRoleIds: string[];
  claimerId: string | null;
  previousClaimerId: string | null;
  /** Rôles d'assistance qui voient le ticket ; `null` = tous. */
  visibleSupportRoleIds: string[] | null;
  /** Seul `claimerId` peut écrire. */
  exclusive: boolean;
};

/** Pose les surcharges de rôles et du preneur sur le salon, rôle par rôle. */
async function syncChannelAccess(channel: TextChannel, plan: AccessPlan): Promise<void> {
  const writeLocked = plan.exclusive && !!plan.claimerId;
  const managers = new Set(plan.managerRoleIds);

  for (const roleId of new Set([...plan.supportRoleIds, ...plan.managerRoleIds])) {
    const isManager = managers.has(roleId);
    const visible = isManager || plan.visibleSupportRoleIds === null || plan.visibleSupportRoleIds.includes(roleId);
    await channel.permissionOverwrites
      .edit(roleId, { ...FULL_ACCESS, ViewChannel: visible, SendMessages: visible && !writeLocked })
      .catch(() => null);
  }

  const restricted = plan.visibleSupportRoleIds !== null || writeLocked;
  if (plan.previousClaimerId && plan.previousClaimerId !== plan.claimerId) {
    await channel.permissionOverwrites.delete(plan.previousClaimerId).catch(() => null);
  }
  // Le preneur garde la main même quand les rôles d'assistance ne voient plus rien.
  if (plan.claimerId && restricted) {
    await channel.permissionOverwrites.edit(plan.claimerId, FULL_ACCESS).catch(() => null);
  }
}

/**
 * À appeler après chaque prise en charge (`claimerId`) ou restitution (`null`).
 * Sans réglage actif, ne fait rien : le salon reste comme à l'ouverture.
 */
export async function applyTicketClaimAccess(
  client: Client,
  ticket: TicketRow,
  guildConfig: Config,
  claimerId: string | null,
  previousClaimerId: string | null = null,
): Promise<void> {
  const hides = guildConfig.ticketClaimHidesSupport === true;
  const exclusive = guildConfig.ticketClaimExclusive === true;
  if (!hides && !exclusive && !previousClaimerId) return;

  const channel = await textChannelOf(client, ticket);
  if (!channel) return;

  await syncChannelAccess(channel, {
    supportRoleIds: ticketSupportRoleIds(guildConfig, ticket.staffRoleId),
    managerRoleIds: ticketManagerRoleIds(guildConfig),
    claimerId,
    previousClaimerId,
    visibleSupportRoleIds: hides && claimerId ? [] : null,
    exclusive,
  });
}

/**
 * Suite commune d'une prise en charge, quel que soit le chemin (bouton, commande,
 * réponse automatique) : trace dans l'historique, puis accès au salon.
 * `ticket` est la ligne lue AVANT la prise, pour connaître le preneur précédent.
 */
export async function onTicketClaimed(
  client: Client,
  ticket: TicketRow & { id: string; claimedById: string | null },
  guildConfig: Config,
  claimer: { id: string; username: string },
): Promise<void> {
  await recordHandlingEvent(ticket.id, { type: 'CLAIM', byId: claimer.id, byName: claimer.username })
    .catch((err) => logger.error('Ticket', `Historique de prise en charge non enregistré (${ticket.id}):`, err));
  await applyTicketClaimAccess(client, ticket, guildConfig, claimer.id, ticket.claimedById)
    .catch((err) => logger.error('Ticket', `Accès au salon non ajusté après prise en charge (${ticket.id}):`, err));
}

export type TransferTarget = { roleId?: string | null; userId?: string | null };
export type TransferResult =
  | { ok: true; event: TicketHandlingEvent; history: TicketHandlingEvent[] }
  | { ok: false; error: string };

/** Équipes vers lesquelles on peut transférer : celles du serveur et celles des types de ticket. */
export function transferableRoleIds(guildConfig: Config): string[] {
  const fromTypes = listTicketPanelTypes(guildConfig)
    .map((type) => type.staffRoleId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set([...ticketAccessRoleIds(guildConfig), ...fromTypes])];
}

/**
 * Transfère un ticket ouvert à une autre équipe (rôle) ou à un membre, par
 * exemple un supérieur. Vers une équipe, le ticket repart sans preneur ; vers un
 * membre, il lui est confié.
 */
export async function transferTicket(
  client: Client,
  ticketId: string,
  actor: { id: string; username: string },
  target: TransferTarget,
  note?: string | null,
): Promise<TransferResult> {
  if (!target.roleId && !target.userId) return { ok: false, error: 'Choisis une équipe ou un membre.' };

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket || (ticket.status !== 'OPEN' && ticket.status !== 'CLAIMED')) {
    return { ok: false, error: "Ce ticket n'est plus ouvert." };
  }
  const guildConfig = await prisma.guild.findUnique({ where: { id: ticket.guildId } });
  if (!guildConfig) return { ok: false, error: 'Configuration du serveur introuvable.' };
  const config = guildConfig as unknown as Config;

  const guild = client.guilds.cache.get(ticket.guildId);
  if (!guild) return { ok: false, error: 'Serveur introuvable.' };

  let toRoleName: string | null = null;
  if (target.roleId) {
    if (!transferableRoleIds(config).includes(target.roleId)) {
      return { ok: false, error: "Ce rôle n'est pas une équipe du module Tickets." };
    }
    toRoleName = guild.roles.cache.get(target.roleId)?.name ?? null;
  }

  let toUserName: string | null = null;
  if (target.userId) {
    const member = await guild.members.fetch(target.userId).catch(() => null);
    if (!member || member.user.bot || !canManageTicket(member, config, ticket.staffRoleId)) {
      return { ok: false, error: "Ce membre ne fait pas partie de l'équipe des tickets." };
    }
    toUserName = member.displayName;
  }

  const toMember = !!target.userId;
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      ...(target.roleId ? { staffRoleId: target.roleId } : {}),
      status: toMember ? 'CLAIMED' : 'OPEN',
      claimedById: toMember ? target.userId : null,
      claimedByName: toMember ? toUserName : null,
    },
  });

  const history = await recordHandlingEvent(ticket.id, {
    type: 'TRANSFER',
    byId: actor.id,
    byName: actor.username,
    toRoleId: target.roleId ?? null,
    toRoleName,
    toUserId: target.userId ?? null,
    toUserName,
    note: note?.trim().slice(0, 200) || null,
  });

  const channel = await textChannelOf(client, ticket);
  if (channel) {
    const hides = config.ticketClaimHidesSupport === true;
    const newTeam = target.roleId ?? ticket.staffRoleId;
    // Vers une équipe, l'ancienne perd la vue seulement si le serveur masque les
    // tickets aux autres rôles d'assistance ; l'équipe responsable garde la sienne.
    await syncChannelAccess(channel, {
      supportRoleIds: [...new Set([...ticketSupportRoleIds(config, ticket.staffRoleId), ...(newTeam ? [newTeam] : [])])],
      managerRoleIds: ticketManagerRoleIds(config),
      claimerId: toMember ? target.userId! : null,
      previousClaimerId: ticket.claimedById,
      visibleSupportRoleIds: hides ? (newTeam ? [newTeam] : []) : null,
      exclusive: config.ticketClaimExclusive === true,
    });
    if (target.roleId) {
      await channel.permissionOverwrites
        .edit(target.roleId, { ...FULL_ACCESS, SendMessages: !(config.ticketClaimExclusive === true && toMember) })
        .catch(() => null);
    }
  } else if (ticket.channelId || ticket.threadId) {
    logger.warn('Ticket', `Transfert ${ticket.id} : salon introuvable, permissions inchangées.`);
  }

  broadcastDashboardStateChange(ticket.guildId, 'tickets_updated');
  return { ok: true, event: history[history.length - 1], history };
}

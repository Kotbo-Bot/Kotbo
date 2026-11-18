/**
 * Routes du centre de support, à côté des routes historiques des tickets :
 *
 *   PATCH /tickets/:id/properties   priorité et étiquettes
 *   POST  /tickets/:id/assign       attribuer à un membre du staff (ou retirer)
 *   GET   /tickets/agents           qui peut recevoir un ticket, et sa charge
 *   GET   /tickets/stats?days=      performance du support
 *   POST  /tickets/:id/approve      valider une demande en attente
 *   POST  /tickets/:id/reject       la refuser, motif facultatif
 *
 * Appelées par `handleTicketsRoutes` une fois le droit d'accès aux tickets
 * vérifié.
 */
import { Hono } from 'hono';
import { TextChannel, type Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { successEmbed } from '../../../../utils/embeds.js';
import { errorMessage } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import { resolveViewTimezone } from '../../../../utils/timezone.js';
import { broadcastDashboardStateChange, getGuildName, pushAudit } from '../../../shared.js';
import { normalizePriority, normalizeTags } from '../../../../services/features/ticketHelpdesk.js';
import { getTicketStats } from '../../../../services/features/ticketStatsService.js';
import { announceTicketClaim, approvePendingTicket, approvalErrorMessage, rejectPendingTicket } from '../../../../services/features/ticketService.js';
import { ticketsGate } from './tickets.js';
import { auditUserOf, readBody, send } from '../../../hono/dashboard/kit.js';

const PRIORITY_LABEL: Record<string, string> = { LOW: 'basse', NORMAL: 'normale', HIGH: 'haute', URGENT: 'urgente' };

async function ticketChannel(client: Client, channelId: string | null, threadId: string | null) {
  const id = channelId ?? threadId;
  if (!id) return null;
  const channel = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
  return channel && (channel instanceof TextChannel || channel.isThread()) ? channel : null;
}

export function createTicketHelpdeskRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Même garde que les tickets : le répartiteur d'origine la posait avant ces routes.
  const gate = ticketsGate(client);



  router.get(`${base}/tickets/stats`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const timezone = await resolveViewTimezone((c.req.query('tz') ?? null), guildId);
      return send(c, await getTicketStats(guildId, Number((c.req.query('days') ?? null)) || 30, timezone));
    } catch (err) {
      logger.error('TicketHelpdeskAPI', `Statistiques du support (${guildId}) : ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors du calcul des statistiques du support' }, 500);
    }
  });

  router.get(`${base}/tickets/agents`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = client.guilds.cache.get(guildId);
      const [config, staffRows, loads] = await Promise.all([
        prisma.guild.findUnique({ where: { id: guildId }, select: { ticketStaffRoleId: true } }),
        prisma.staffMember.findMany({ where: { guildId }, select: { userId: true } }),
        prisma.ticket.groupBy({ by: ['claimedById'], where: { guildId, status: { in: ['OPEN', 'CLAIMED'] }, claimedById: { not: null } }, _count: { _all: true } }),
      ]);
      const ids = new Set<string>(staffRows.map((row) => row.userId));
      if (guild && config?.ticketStaffRoleId) {
        guild.roles.cache.get(config.ticketStaffRoleId)?.members.forEach((member) => ids.add(member.id));
      }
      const load = new Map(loads.map((row) => [row.claimedById, row._count._all]));
      const agents = [...ids]
        .map((id) => {
          const member = guild?.members.cache.get(id);
          if (!member || member.user.bot) return null;
          return {
            id,
            name: member.displayName,
            avatar: member.displayAvatarURL({ size: 64 }),
            openTickets: load.get(id) ?? 0,
          };
        })
        .filter((agent): agent is NonNullable<typeof agent> => agent !== null)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 200);
      return send(c, { agents });
    } catch (err) {
      logger.error('TicketHelpdeskAPI', `Agents (${guildId}) : ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la récupération du staff' }, 500);
    }
  });

  router.patch(`${base}/tickets/:ticketId/properties`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const auditUser = auditUserOf(c);
    const ticketId = c.req.param('ticketId');
    try {
      const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, guildId }, select: { id: true, priority: true, tags: true, username: true } });
      if (!ticket) {
        return send(c, { error: 'Ticket introuvable' }, 404);
      }
      const body = await readBody<{ priority?: unknown; tags?: unknown }>(c);
      const data: { priority?: string; tags?: string[] } = {};
      if (body?.priority !== undefined) {
        const priority = normalizePriority(body.priority);
        if (!priority) {
          return send(c, { error: 'Priorité inconnue.' }, 400);
        }
        data.priority = priority;
      }
      if (body?.tags !== undefined) data.tags = normalizeTags(body.tags);

      const updated = await prisma.ticket.update({ where: { id: ticketId }, data, select: { id: true, priority: true, tags: true } });

      const changes: string[] = [];
      if (data.priority && data.priority !== ticket.priority) changes.push(`priorité ${PRIORITY_LABEL[data.priority]}`);
      if (data.tags && data.tags.join(',') !== ticket.tags.join(',')) changes.push(`étiquettes : ${data.tags.join(', ') || 'aucune'}`);
      if (changes.length > 0) {
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Ticket modifié',
          context: getGuildName(client, guildId),
          module: 'Tickets',
          eventType: 'Manuel',
          details: `Ticket de ${ticket.username} : ${changes.join(' ; ')}.`,
          channelId: null,
        }).catch(() => null);
      }
      broadcastDashboardStateChange(guildId, 'tickets_updated');
      return send(c, { ticket: updated });
    } catch (err) {
      logger.error('TicketHelpdeskAPI', `Propriétés du ticket ${ticketId} : ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la mise à jour du ticket' }, 500);
    }
  });

  // Mêmes fonctions que les boutons « Valider » et « Refuser » de Discord.
  router.post(`${base}/tickets/:ticketId/:decision{approve|reject}`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const ticketId = c.req.param('ticketId');
    const decision = c.req.param('decision');
    const guild = client.guilds.cache.get(guildId);
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
    if (!ticket || !guild) {
      return send(c, { error: 'Demande introuvable' }, 404);
    }
    if (ticket.status !== 'PENDING') {
      return send(c, { error: 'Cette demande a déjà été traitée.' }, 409);
    }
    const reviewer = { id: user.userId, username: user.username ?? user.userId };
    try {
      if (decision === 'approve') {
        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
        const result = await approvePendingTicket(client, guild, guildConfig, ticket, reviewer);
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Demande de ticket validée',
          context: getGuildName(client, guildId),
          module: 'Tickets',
          eventType: 'Manuel',
          details: `Demande de ${ticket.username} validée depuis le dashboard.`,
          channelId: null,
        }).catch(() => null);
        return send(c, { ok: true, message: result.userMessage, ticketId: result.ticketId ?? ticket.id });
      } else {
        const body = await readBody<{ reason?: unknown }>(c);
        const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
        await rejectPendingTicket(client, guild, ticket, reviewer, reason);
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Demande de ticket refusée',
          context: getGuildName(client, guildId),
          module: 'Tickets',
          eventType: 'Manuel',
          details: `Demande de ${ticket.username} refusée depuis le dashboard${reason ? ` : ${reason}` : ''}.`,
          channelId: null,
        }).catch(() => null);
        return send(c, { ok: true });
      }
    } catch (err) {
      // Les messages sont écrits pour Discord : on retire l'émoji de tête.
      return send(c, { error: approvalErrorMessage(err).replace(/^(?:❌|⚠️|\s)+/u, '') }, 409);
    }
  });

  router.post(`${base}/tickets/:ticketId/assign`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const ticketId = c.req.param('ticketId');
    try {
      const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
      if (!ticket) {
        return send(c, { error: 'Ticket introuvable' }, 404);
      }
      if (ticket.status !== 'OPEN' && ticket.status !== 'CLAIMED') {
        return send(c, { error: 'Seul un ticket en cours peut être attribué.' }, 400);
      }
      const body = await readBody<{ userId?: unknown }>(c);
      const targetId = typeof body?.userId === 'string' && /^\d{17,20}$/.test(body.userId) ? body.userId : null;
      const channel = await ticketChannel(client, ticket.channelId, ticket.threadId);

      if (!targetId) {
        const updated = await prisma.ticket.update({
          where: { id: ticketId },
          data: { status: 'OPEN', claimedById: null, claimedByName: null },
        });
        await channel?.send({ embeds: [successEmbed('Ticket remis en file', `Le ticket n'est plus attribué (modifié depuis le dashboard par **${user.username}**).`)] }).catch(() => null);
        broadcastDashboardStateChange(guildId, 'tickets_updated');
        return send(c, { ticket: updated });
      }

      const guild = client.guilds.cache.get(guildId);
      const member = guild ? guild.members.cache.get(targetId) ?? await guild.members.fetch(targetId).catch(() => null) : null;
      if (!member) {
        return send(c, { error: "Ce membre n'est pas sur le serveur." }, 400);
      }

      const updated = await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'CLAIMED',
          claimedById: member.id,
          claimedByName: member.user.username,
          ...(ticket.lockUntilClaim ? { lockUntilClaim: false } : {}),
        },
      });

      if (ticket.lockUntilClaim) {
        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
        if (guildConfig) {
          const { applyTicketLockState } = await import('../../../../services/features/ticketService.js');
          await applyTicketLockState(client, ticket, guildConfig, false).catch(() => null);
        }
      }

      if (channel) {
        await announceTicketClaim(
          channel,
          successEmbed('Ticket attribué', `Ce ticket est confié à <@${member.id}> par **${user.username}** depuis le dashboard.`),
          { content: `<@${member.id}>`, mentionUserIds: [member.id] },
        );
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Ticket attribué',
        context: getGuildName(client, guildId),
        module: 'Tickets',
        eventType: 'Manuel',
        details: `Ticket de ${ticket.username} attribué à ${member.user.username}.`,
        channelId: null,
      }).catch(() => null);

      broadcastDashboardStateChange(guildId, 'tickets_updated');
      return send(c, { ticket: updated });
    } catch (err) {
      logger.error('TicketHelpdeskAPI', `Attribution du ticket ${ticketId} : ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de l'attribution du ticket" }, 500);
    }
  });

  return router;
}


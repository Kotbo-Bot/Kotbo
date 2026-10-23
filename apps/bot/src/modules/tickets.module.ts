/**
 * Tickets Module - Bus-based subscriber
 *
 * Groups ticket-related event handling:
 * - Ticket inactivity reset (message:new in ticket channel)
 * - Ticket leave follow-up (member:leave with open tickets)
 * - DM relay (stays on client.on for DM detection)
 */

import type { Client, TextChannel } from 'discord.js';
import { Events, type Message, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { subscribeForModule } from '../services/core/moduleScope.js';
import prisma from '../utils/db.js';
import { COLORS } from '../utils/embeds.js';
import { autoClaimTicketOnStaffMessage, markTicketOrphaned, recordTicketFirstResponse, recordTicketTurn, relayDmToThread, relayThreadToDm } from '../services/features/ticketService.js';
import { logger } from '../utils/logger.js';
import { drainAllTicketQueues, onTicketCapacityFreed } from '../services/features/ticketQueueService.js';

const MODULE_NAME = 'tickets';

/**
 * Balayage de la file d'attente des tickets. Local a chaque shard, et non
 * confie a la file Redis : un job de file ne tourne que sur un shard, qui ne
 * voit pas les serveurs des autres.
 */
const TICKET_QUEUE_SWEEP_MS = 2 * 60_000;

export function registerTicketsBusSubscribers(client: Client): void {
  // ── Inactivity reset: creator speaks in ticket → reset flag ───
  subscribeForModule('tickets', 'message:new', async (payload) => {
    if (payload.isBot || !payload.guildId) return;

    const ticket = await prisma.ticket.findFirst({
      where: {
        guildId: payload.guildId,
        channelId: payload.channelId,
        status: { in: ['OPEN', 'CLAIMED'] },
        userId: payload.authorId,
      },
    });

    if (!ticket?.inactivityAlertSent) return;

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { inactivityAlertSent: false },
    });
  }, MODULE_NAME);

  // ── Salon supprime : detecter un ticket devenu orphelin ───────
  // Abonnement ici, dans le module `tickets`, et pas dans `advancedLogs.ts` :
  // couper le module « logs » ne doit pas couper une protection fonctionnelle.
  subscribeForModule('tickets', 'channel:delete', async (payload) => {
    const ticket = await prisma.ticket.findFirst({
      where: { guildId: payload.guildId, channelId: payload.channelId, status: { in: ['OPEN', 'CLAIMED'] } },
    });
    if (!ticket) return;

    const guild = client.guilds.cache.get(payload.guildId) ?? null;
    await markTicketOrphaned(client, guild, ticket, payload.channelId);
  }, MODULE_NAME);

  // ── File d'attente : une place a pu se liberer ────────────────
  // Un salon supprime libere une place dans le serveur et dans sa categorie ;
  // un fil archive ou supprime libere une place parmi les fils actifs.
  subscribeForModule('tickets', 'channel:delete', async (payload) => {
    await onTicketCapacityFreed(client, payload.guildId);
  }, MODULE_NAME);

  client.on(Events.ThreadDelete, (thread) => {
    onTicketCapacityFreed(client, thread.guildId).catch((err) => logger.error('TicketQueue', 'Erreur reprise de file :', err));
  });

  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    if (oldThread.archived || !newThread.archived) return;
    onTicketCapacityFreed(client, newThread.guildId).catch((err) => logger.error('TicketQueue', 'Erreur reprise de file :', err));
  });

  setInterval(() => {
    drainAllTicketQueues(client).catch((err) => logger.error('TicketQueue', 'Erreur balayage de la file :', err));
  }, TICKET_QUEUE_SWEEP_MS).unref?.();

  // ── Leave follow-up: member leaves with open tickets ──────────
  subscribeForModule('tickets', 'member:leave', async (payload) => {
    const tickets = await prisma.ticket.findMany({
      where: {
        guildId: payload.guildId,
        userId: payload.userId,
        status: { in: ['OPEN', 'CLAIMED'] },
        channelId: { not: null },
      },
    });

    if (tickets.length === 0) return;

    const guildConfig = await prisma.guild.findUnique({
      where: { id: payload.guildId },
      select: { ticketStaffRoleId: true, moderatorRoleId: true },
    });

    // Batch-resolve all ticket channels from cache first
    const channelFetches = tickets
      .filter(t => t.channelId)
      .map(async (ticket) => {
        const channel = client.channels.cache.get(ticket.channelId!) as TextChannel | undefined
          ?? await client.channels.fetch(ticket.channelId!).catch(() => null) as TextChannel | null;
        return { ticket, channel };
      });

    const resolved = await Promise.all(channelFetches);

    const sends = resolved
      .filter((r): r is { ticket: typeof r.ticket; channel: TextChannel } =>
        r.channel !== null && 'send' in r.channel)
      .map(({ ticket, channel }) => {
        const staffPing = guildConfig?.ticketStaffRoleId
          ? `<@&${ticket.staffRoleId || guildConfig.ticketStaffRoleId}>`
          : ticket.staffRoleId
            ? `<@&${ticket.staffRoleId}>`
            : guildConfig?.moderatorRoleId
              ? `<@&${guildConfig.moderatorRoleId}>`
              : '';

        const embed = new EmbedBuilder()
          .setTitle('👋 Le créateur a quitté le serveur')
          .setDescription(
            `Le membre <@${payload.userId}> a quitté le serveur alors que ce ticket est encore actif.\n\n` +
            'Souhaitez-vous fermer ou supprimer ce ticket ?'
          )
          .setColor(COLORS.warning)
          .setTimestamp();

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
          new ButtonBuilder().setCustomId(`ticket:delete:${ticket.id}`).setLabel('Supprimer').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        );

        return channel.send({
          content: staffPing || undefined,
          embeds: [embed],
          components: [row],
        }).catch((error) => {
          logger.warn('Ticket', `Impossible d'envoyer le follow-up de départ pour ${ticket.id}: ${String(error)}`);
        });
      });

    await Promise.all(sends);
  }, MODULE_NAME);

  // ── DM Relay - stays on client.on (DMs are not guild events) ──
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    try {
      if (!message.guild && message.channel.isDMBased()) {
        await relayDmToThread(client, message);
        return;
      }

      if (message.guild) {
        await recordTicketFirstResponse(message);
        await recordTicketTurn(message);
        await autoClaimTicketOnStaffMessage(client, message);
      }

      if (message.channel.isThread()) {
        await relayThreadToDm(client, message);
      }
    } catch (err) {
      logger.error(`[EventBus:${MODULE_NAME}]`, 'Erreur DM relay:', err);
    }
  });

  logger.info('Modules', `Module "${MODULE_NAME}" enregistre sur le bus d'events.`);
}

/**
 * Relance du staff quand un membre attend une réponse dans son ticket.
 *
 * Pendant de `checkTicketInactivity`, qui relance le membre : ici c'est le
 * staff qui a la parole et ne la prend pas. La relance mentionne celui qui a
 * pris le ticket en charge, sinon le rôle staff du ticket ou du serveur. Le
 * compteur `staffReminderCount` alimente les statistiques (tickets restés sans
 * réponse, global et par membre du staff).
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { notifyMany } from '../notifications/notifyService.js';
import { staffReminderDue } from './ticketHelpdesk.js';

export async function checkTicketStaffReminders(client: Client): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: { ticketStaffReminderEnabled: true, id: { in: [...client.guilds.cache.keys()] } },
    select: {
      id: true, ticketStaffReminderMinutes: true, ticketStaffRoleId: true,
      ticketStaffReminderTarget: true, ticketStaffReminderChannelId: true,
    },
  });

  const now = new Date();
  for (const config of guilds) {
    if (!(await isModuleEnabled(config.id, 'tickets'))) continue;

    const tickets = await prisma.ticket.findMany({
      where: { guildId: config.id, status: { in: ['OPEN', 'CLAIMED'] } },
      select: {
        id: true, status: true, userId: true, channelId: true, threadId: true, staffRoleId: true, claimedById: true,
        createdAt: true, lastMemberMessageAt: true, lastStaffMessageAt: true, staffReminderSentAt: true,
      },
    });
    const due = tickets.filter((ticket) => staffReminderDue(ticket, config.ticketStaffReminderMinutes, now));
    if (due.length === 0) continue;

    const discordGuild = client.guilds.cache.get(config.id);
    const locale = await resolveGuildLocale(config.id, discordGuild?.preferredLocale ?? null);

    for (const ticket of due) {
      const ticketChannelId = ticket.channelId ?? ticket.threadId;
      if (!ticketChannelId) continue;
      const roleId = ticket.staffRoleId ?? config.ticketStaffRoleId;
      const target = ticket.claimedById ? `<@${ticket.claimedById}>` : roleId ? `<@&${roleId}>` : '';
      const since = ticket.lastStaffMessageAt ? ticket.lastMemberMessageAt! : ticket.createdAt;
      const text = m.tkt_staff_reminder(
        { target, member: `<@${ticket.userId}>`, since: `<t:${Math.floor(since.getTime() / 1000)}:f>` },
        { locale },
      ).trim();

      if (config.ticketStaffReminderTarget === 'DASHBOARD') {
        // Qui prévenir : celui qui a pris le ticket, sinon les membres du rôle staff (cache, plafonné).
        const recipients = ticket.claimedById
          ? [ticket.claimedById]
          : roleId
            ? [...(discordGuild?.roles.cache.get(roleId)?.members.keys() ?? [])].slice(0, 25)
            : [];
        if (recipients.length === 0) continue;
        // notify() applique la grille de chacun : boîte du dashboard, MP, résumé du jour.
        await notifyMany(recipients, {
          guildId: config.id,
          kind: 'tickets.staff_reminder',
          title: m.tkt_staff_reminder_title({}, { locale }),
          message: m.tkt_staff_reminder_dash({ member: `<@${ticket.userId}>`, since: `<t:${Math.floor(since.getTime() / 1000)}:R>` }, { locale }),
          severity: 'WARNING',
          link: `/tickets?ticket=${ticket.id}`,
          groupKey: `ticket-staff-reminder:${ticket.id}`,
        });
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { staffReminderSentAt: now, staffReminderCount: { increment: 1 } },
        });
        continue;
      }

      // Salon dédié (éventuellement sur le serveur du staff) ; sans salon valide, retour dans le ticket.
      const channelId = (config.ticketStaffReminderTarget === 'CHANNEL' && config.ticketStaffReminderChannelId) || ticketChannelId;
      const inTicket = channelId === ticketChannelId;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isSendable()) continue;

      const sent = await channel
        .send({
          content: inTicket ? text : `${text} <#${ticketChannelId}>`,
          // Seul le staff visé est notifié : le membre n'a pas à être repingé.
          allowedMentions: { users: ticket.claimedById ? [ticket.claimedById] : [], roles: roleId && !ticket.claimedById ? [roleId] : [] },
        })
        .then(() => true)
        .catch((error: unknown) => {
          logger.warn('Ticket', `Relance staff impossible pour le ticket ${ticket.id} (${channelId}) : ${String(error)}`);
          return false;
        });

      // Posée seulement après un envoi réussi, comme pour l'inactivité : un
      // salon fermé au bot réessaiera au prochain tour.
      if (sent) {
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { staffReminderSentAt: now, staffReminderCount: { increment: 1 } },
        });
      }
    }
  }
}

/**
 * Rapport de la nuit : un embed posté chaque matin dans le salon de logs du
 * serveur staff (`StaffServerLink.staffLogChannelId`) avec ce qui s'est passé
 * depuis la veille au soir et ce qui attend une décision. Rien n'est posté si
 * la nuit a été calme et que rien n'est en attente.
 */
import { EmbedBuilder, type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const WINDOW_MS = 10 * 60 * 60_000;

export async function sendNightReports(client: Client, now = new Date()): Promise<void> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const links = await prisma.staffServerLink.findMany({
    where: { staffLogChannelId: { not: null } },
    select: { mainGuildId: true, staffLogChannelId: true },
  });

  for (const link of links) {
    const guildId = link.mainGuildId;
    if (!client.guilds.cache.has(guildId)) continue;
    const channel = await client.channels.fetch(link.staffLogChannelId!).catch(() => null);
    if (!channel?.isSendable()) continue;

    const [raid, appeals, ticketsOpened, ticketsWaiting, absences] = await Promise.all([
      prisma.raidProtectionConfig.findFirst({
        where: { guildId, raidModeActivatedAt: { gte: since } },
        select: { raidModeActivatedAt: true },
      }),
      prisma.banAppeal.count({ where: { guildId, status: { in: ['PENDING', 'NEEDS_INFO'] } } }),
      prisma.ticket.count({ where: { guildId, createdAt: { gte: since } } }),
      prisma.ticket.count({ where: { guildId, status: { in: ['OPEN', 'CLAIMED'] }, lastStaffMessageAt: null, createdAt: { lt: now } } }),
      prisma.staffAbsence.count({ where: { guildId, status: 'PENDING' } }),
    ]);

    const locale = await resolveGuildLocale(guildId, client.guilds.cache.get(guildId)?.preferredLocale ?? null);
    const o = { locale };
    const lines: string[] = [];
    if (raid?.raidModeActivatedAt) {
      lines.push(m.nrp_raid({ time: `<t:${Math.floor(raid.raidModeActivatedAt.getTime() / 1000)}:t>` }, o));
    }
    if (appeals > 0) lines.push(m.nrp_appeals({ count: appeals }, o));
    if (ticketsOpened > 0 || ticketsWaiting > 0) lines.push(m.nrp_tickets({ opened: ticketsOpened, waiting: ticketsWaiting }, o));
    if (absences > 0) lines.push(m.nrp_absences({ count: absences }, o));
    if (lines.length === 0) continue;

    const todo = appeals + absences;
    const embed = new EmbedBuilder().setTitle(m.nrp_title({}, o)).setDescription(lines.join('\n')).setTimestamp(now);
    if (todo > 0) embed.setFooter({ text: m.nrp_todo({ count: todo }, o) });
    await channel.send({ embeds: [embed] }).catch((error: unknown) => {
      logger.warn('NightReport', `Rapport de la nuit impossible pour ${guildId} : ${String(error)}`);
    });
  }
}

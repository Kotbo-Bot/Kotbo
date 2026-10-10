/**
 * Notifications en message privé des membres du site communautaire.
 *
 * Un membre choisit, depuis son espace, ce qu'il veut recevoir (commentaires,
 * tickets, boutique, rappel de vote). Un MP refusé (messages privés fermés)
 * n'est pas une erreur : on passe.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type Message } from 'discord.js';
import { normalizeSiteNotifications, resolveSiteTheme, type SiteNotificationKind, type SiteNotificationPrefs } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { getSiteByGuild } from './siteService.js';
import { publishGuildSignal } from './siteLive.js';

/** Délai minimal entre deux MP pour un même ticket. */
const TICKET_NOTIFY_INTERVAL_MS = 10 * 60_000;

export async function getSiteNotificationPrefs(guildId: string, userId: string): Promise<SiteNotificationPrefs> {
  const row = await prisma.siteMemberSettings.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { notifications: true } });
  return normalizeSiteNotifications(row?.notifications);
}

export async function siteUrl(guildId: string, path = ''): Promise<string | null> {
  const site = await getSiteByGuild(guildId);
  if (!site || !site.published || site.suspendedAt) return null;
  const { getDashboardUrl } = await import('../../api/shared.js');
  return `${getDashboardUrl().replace(/\/$/, '')}/s/${site.slug}${path}`;
}

export interface SiteNotification {
  title: string;
  body: string;
  /** Chemin sur le site (`/blog/…`, `/me`) ; le bouton mène à cette page. */
  path?: string;
}

/**
 * Envoie un MP si le membre l'accepte pour ce type. Renvoie `true` quand le
 * message est parti.
 */
export async function notifySiteMember(client: Client, guildId: string, userId: string, kind: SiteNotificationKind, notification: SiteNotification): Promise<boolean> {
  const prefs = await getSiteNotificationPrefs(guildId, userId);
  if (!prefs[kind]) return false;
  const site = await getSiteByGuild(guildId);
  if (!site || !site.published || site.suspendedAt) return false;

  const guild = client.guilds.cache.get(guildId);
  const locale = (await resolveGuildLocale(guildId, guild?.preferredLocale)) === 'en' ? 'en' : 'fr';
  const url = await siteUrl(guildId, notification.path ?? '');
  const accent = resolveSiteTheme(site.theme, site.themeSettings).accent;

  const embed = new EmbedBuilder()
    .setColor(Number.parseInt(accent.slice(1), 16))
    .setTitle(notification.title.slice(0, 256))
    .setDescription(notification.body.slice(0, 2000))
    .setFooter({ text: `${site.name || guild?.name || site.slug} · ${m.site_notify_footer({}, { locale })}`.slice(0, 2048) });
  const components = url
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(m.site_notify_open({}, { locale })))]
    : [];

  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed], components });
    return true;
  } catch (err) {
    logger.debug('Site', `MP du site non remis à ${userId} (${guildId}) :`, err);
    return false;
  }
}

// ─── Tickets ouverts depuis le site ─────────────────────────────────────────

export async function linkSiteTicket(guildId: string, userId: string, ticketId: string): Promise<void> {
  await prisma.siteTicketLink.upsert({ where: { ticketId }, create: { ticketId, guildId, userId }, update: {} });
  await cache.delete(`guild:${guildId}:site-ticket-channels`);
}

/** Salons (et fils) des tickets encore ouverts nés sur le site, par serveur. */
async function siteTicketChannels(guildId: string): Promise<string[]> {
  return cache.wrap(`guild:${guildId}:site-ticket-channels`, 120, async () => {
    const links = await prisma.siteTicketLink.findMany({ where: { guildId }, select: { ticketId: true } });
    if (links.length === 0) return [];
    const tickets = await prisma.ticket.findMany({
      where: { id: { in: links.map((l) => l.ticketId) }, status: { not: 'CLOSED' } },
      select: { channelId: true },
    });
    return tickets.map((t) => t.channelId).filter((id): id is string => Boolean(id));
  });
}

/**
 * Réponse dans un ticket ouvert depuis le site : si elle vient d'un autre que
 * le membre (le staff), le membre est prévenu en MP, au plus une fois par délai.
 */
export async function handleSiteTicketMessage(message: Message): Promise<void> {
  if (!message.guildId || message.system) return;
  const channels = await siteTicketChannels(message.guildId);
  if (!channels.includes(message.channelId)) return;

  const ticket = await prisma.ticket.findUnique({ where: { channelId: message.channelId }, select: { id: true, userId: true, reason: true } });
  if (!ticket) return;
  // Tout message (relais du site compris) rafraîchit le fil ouvert dans les onglets du membre.
  publishGuildSignal(message.guildId, `user:${ticket.userId}`);
  if (message.author.bot || ticket.userId === message.author.id) return;
  const link = await prisma.siteTicketLink.findUnique({ where: { ticketId: ticket.id } });
  if (!link) return;

  // Créneau réservé avant l'envoi : deux réponses rapprochées ne font qu'un MP.
  const since = new Date(Date.now() - TICKET_NOTIFY_INTERVAL_MS);
  const claimed = await prisma.siteTicketLink.updateMany({
    where: { id: link.id, OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lt: since } }] },
    data: { lastNotifiedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const locale = (await resolveGuildLocale(message.guildId, message.guild?.preferredLocale)) === 'en' ? 'en' : 'fr';
  await notifySiteMember(message.client, message.guildId, ticket.userId, 'tickets', {
    title: m.site_notify_ticket_title({}, { locale }),
    body: m.site_notify_ticket_body({ subject: ticket.reason }, { locale }),
    path: '/me',
  });
}

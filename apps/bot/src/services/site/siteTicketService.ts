/**
 * Tickets ouverts et suivis depuis le site communautaire.
 *
 * L'ouverture reprend les règles du module Tickets (liste noire, quotas,
 * validation préalable, ouverture déjà en cours) puis délègue la création de
 * l'espace à `createTicketWorkspace`, comme un clic sur le panneau Discord.
 *
 * Les réponses écrites sur le site sont relayées dans le salon du ticket par
 * un message du bot qui porte le nom et l'avatar du membre : le staff répond
 * depuis Discord comme d'habitude, et le site relit le salon.
 */

import { EmbedBuilder, type Client, type Guild, type Message } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import {
  createPendingTicketRequest,
  createTicketWorkspace,
  findActiveTicketBlacklist,
  listTicketPanelTypes,
  resolveRequireApproval,
  resolveTicketPanelType,
} from '../features/ticketService.js';
import { beginTicketOpening, endTicketOpening } from '../features/ticketRecordingNotice.js';
import { ACTIVE_TICKET_STATUSES, checkMemberTicketQuota, resolveTicketQuotas } from '../features/ticketQuotaService.js';
import type { SiteViewer } from './siteService.js';

/** Pied des messages relayés : c'est lui qui les distingue des messages du bot. */
export const SITE_RELAY_FOOTER = '🌐 Envoyé depuis le site';

export interface SiteTicketType {
  id: string;
  label: string;
  description: string | null;
  emoji: string | null;
}

export async function listSiteTicketTypes(guildId: string): Promise<SiteTicketType[]> {
  const config = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!config) return [];
  return listTicketPanelTypes(config as unknown as Record<string, unknown>).map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description ?? null,
    emoji: t.emoji ?? null,
  }));
}

export type OpenTicketError = 'blacklisted' | 'quota' | 'pending' | 'busy' | 'failed';

export async function openTicketFromSite(
  client: Client,
  guild: Guild,
  viewer: SiteViewer,
  input: { typeId: string | null; subject: string; message: string },
): Promise<{ ok: true; ticketId: string } | { ok: false; error: OpenTicketError; detail?: string }> {
  const guildConfig = await prisma.guild.findUnique({ where: { id: guild.id } });
  if (!guildConfig) return { ok: false, error: 'failed' };
  const configRecord = guildConfig as unknown as Record<string, unknown>;

  const blacklisted = await findActiveTicketBlacklist(guild.id, viewer.userId);
  if (blacklisted) return { ok: false, error: 'blacklisted', detail: blacklisted.reason ?? undefined };

  const ticketType = resolveTicketPanelType(configRecord, input.typeId);
  const verdict = await checkMemberTicketQuota({ guildId: guild.id, userId: viewer.userId, quotas: resolveTicketQuotas(configRecord, ticketType) });
  if (!verdict.ok) return { ok: false, error: verdict.kind !== 'COOLDOWN' && verdict.kind !== 'PERIOD' && verdict.blocking?.status === 'PENDING' ? 'pending' : 'quota' };

  if (!beginTicketOpening(guild.id, viewer.userId)) return { ok: false, error: 'busy' };
  try {
    const locale = await resolveGuildLocale(guild.id, guild.preferredLocale);
    const params = {
      guild,
      user: { id: viewer.userId, username: viewer.username },
      ticketType,
      guildConfig,
      reason: input.subject,
      description: `${input.message}\n\n-# ${SITE_RELAY_FOOTER}`,
      locale,
    };
    const result = resolveRequireApproval(ticketType, configRecord)
      ? await createPendingTicketRequest(client, params)
      : await createTicketWorkspace(client, params);
    return { ok: true, ticketId: result.ticketId };
  } catch (err) {
    logger.error('Site', `Ouverture de ticket depuis le site impossible sur ${guild.id} :`, err);
    return { ok: false, error: 'failed', detail: err instanceof Error && err.message.startsWith('❌') ? err.message : undefined };
  } finally {
    endTicketOpening(guild.id, viewer.userId);
  }
}

export interface SiteTicketSummary {
  id: string;
  reason: string;
  status: string;
  createdAt: Date;
  channelId: string | null;
  threadId: string | null;
}

export async function listViewerTickets(guildId: string, userId: string): Promise<SiteTicketSummary[]> {
  return prisma.ticket.findMany({
    where: { guildId, userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, reason: true, status: true, createdAt: true, channelId: true, threadId: true },
  });
}

export function isTicketActive(status: string): boolean {
  return (ACTIVE_TICKET_STATUSES as readonly string[]).includes(status);
}

export interface SiteTicketMessage {
  id: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  createdAt: string;
  mine: boolean;
}

/** Salon (ou fil) du ticket sur le serveur : nul pour un ticket en MP ou relayé ailleurs. */
async function ticketChannel(client: Client, ticket: Pick<SiteTicketSummary, 'channelId' | 'threadId'>, guildId: string) {
  const id = ticket.threadId ?? ticket.channelId;
  if (!id) return null;
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) return null;
  return channel;
}

function toSiteMessage(msg: Message, ownerId: string, botId: string): SiteTicketMessage | null {
  const relayed = msg.author.id === botId ? msg.embeds.find((e) => e.footer?.text === SITE_RELAY_FOOTER) : undefined;
  if (relayed) {
    return {
      id: msg.id,
      authorName: relayed.author?.name ?? '',
      authorAvatar: relayed.author?.iconURL ?? null,
      content: relayed.description ?? '',
      createdAt: msg.createdAt.toISOString(),
      mine: true,
    };
  }
  // Messages du bot (accueil, prise en charge…) : ils parlent au staff, pas au membre.
  if (msg.author.bot || msg.system) return null;
  const content = msg.content.trim();
  if (!content && msg.attachments.size === 0) return null;
  return {
    id: msg.id,
    authorName: msg.member?.displayName ?? msg.author.displayName ?? msg.author.username,
    authorAvatar: (msg.member ?? msg.author).displayAvatarURL({ size: 64 }),
    content: content || [...msg.attachments.values()].map((a) => a.name).join(', '),
    createdAt: msg.createdAt.toISOString(),
    mine: msg.author.id === ownerId,
  };
}

/** Conversation d'un ticket, du plus ancien au plus récent ; `null` si elle ne vit pas sur le serveur. */
export async function readTicketThread(client: Client, guildId: string, ticket: SiteTicketSummary & { userId: string }): Promise<SiteTicketMessage[] | null> {
  const channel = await ticketChannel(client, ticket, guildId);
  if (!channel) return null;
  const fetched = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!fetched) return [];
  const botId = client.user?.id ?? '';
  return [...fetched.values()]
    .reverse()
    .map((msg) => toSiteMessage(msg, ticket.userId, botId))
    .filter((m): m is SiteTicketMessage => m !== null);
}

export async function postTicketMessageFromSite(
  client: Client,
  guildId: string,
  ticket: SiteTicketSummary & { userId: string },
  viewer: SiteViewer,
  content: string,
): Promise<boolean> {
  const channel = await ticketChannel(client, ticket, guildId);
  if (!channel || !('send' in channel)) return false;
  const embed = new EmbedBuilder()
    .setAuthor({ name: viewer.displayName, iconURL: viewer.avatarUrl ?? undefined })
    .setDescription(content.slice(0, 4000))
    .setColor(0x5865f2)
    .setFooter({ text: SITE_RELAY_FOOTER })
    .setTimestamp();
  const sent = await channel.send({ content: `<@${viewer.userId}>`, embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  if (!sent) return false;
  // Le relais est un message du bot : le tour de parole du membre est noté ici,
  // sans quoi les objectifs de délai du module compteraient la réponse au staff.
  await prisma.ticket.update({ where: { id: ticket.id }, data: { lastMemberMessageAt: new Date() } }).catch(() => null);
  return true;
}

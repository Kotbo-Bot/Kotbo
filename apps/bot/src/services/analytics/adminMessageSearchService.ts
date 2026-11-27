/**
 * Recherche d'un message sur tous les serveurs (console admin) : retrouver d'ou
 * vient un texte, un lien ou un identifiant. Ne voit que `message_logs`, donc
 * les serveurs qui ont active la journalisation des messages.
 */
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { prismaRead } from '../../utils/db.js';
import { collectGuildLabels } from './adminInsightsService.js';

/** En dessous, l'index trigramme ne sert pas et la table entiere est lue. */
export const MIN_TEXT_LENGTH = 3;
const PAGE_SIZE = 50;

export type MessageQuery =
  | { kind: 'link'; guildId: string; channelId: string; messageId: string }
  | { kind: 'id'; id: string }
  | { kind: 'text'; text: string };

export function parseMessageQuery(raw: string): MessageQuery | null {
  const value = raw.trim();
  const link = value.match(/^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})\/?>?$/);
  if (link) return { kind: 'link', guildId: link[1], channelId: link[2], messageId: link[3] };
  if (/^\d{15,25}$/.test(value)) return { kind: 'id', id: value };
  return value.length >= MIN_TEXT_LENGTH ? { kind: 'text', text: value } : null;
}

async function whereFor(query: MessageQuery): Promise<Prisma.MessageLogWhereInput> {
  if (query.kind === 'link') return { messageId: query.messageId };
  if (query.kind === 'text') return { content: { contains: query.text, mode: 'insensitive' } };
  // Un identifiant seul designe un message, sinon un auteur. Lister les serveurs
  // fait passer la recherche d'auteur par l'index (guildId, authorId, createdAt).
  if (await prismaRead.messageLog.findUnique({ where: { messageId: query.id }, select: { id: true } })) {
    return { messageId: query.id };
  }
  const guilds = await prismaRead.guild.findMany({ select: { id: true } });
  return { guildId: { in: guilds.map((guild) => guild.id) }, authorId: query.id };
}

export async function searchMessagesEverywhere(client: Client, query: MessageQuery, offset: number) {
  const rows = await prismaRead.messageLog.findMany({
    where: await whereFor(query),
    orderBy: { createdAt: 'desc' },
    skip: offset,
    take: PAGE_SIZE + 1,
    select: {
      id: true, guildId: true, channelId: true, channelName: true, messageId: true,
      authorId: true, authorName: true, authorAvatar: true, isBot: true, content: true,
      attachments: true, createdAt: true, editedAt: true, deletedAt: true,
    },
  });
  const messages = rows.slice(0, PAGE_SIZE);
  // Un lien nomme son serveur meme quand le message n'a pas ete journalise.
  const ids = [...new Set([...messages.map((row) => row.guildId), ...(query.kind === 'link' ? [query.guildId] : [])])];
  const labels = ids.length > 0 ? await collectGuildLabels(client, ids) : new Map<string, never>();
  const guildOf = (id: string) => {
    const label = labels.get(id);
    return { id, name: label?.name ?? null, icon: label?.icon ?? null, memberCount: label?.memberCount ?? 0 };
  };

  return {
    kind: query.kind,
    linkGuild: query.kind === 'link' ? guildOf(query.guildId) : null,
    messages: messages.map((row) => ({ ...row, guild: guildOf(row.guildId) })),
    hasMore: rows.length > PAGE_SIZE,
  };
}

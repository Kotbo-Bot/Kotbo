import type { NewsChannel } from 'discord.js';
import { type TextChannel, type Message, type Guild, type Embed } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { buildTranscriptData } from './transcriptData.js';

export interface ParsedTranscriptEmbed {
  color: string | null;
  authorName: string | null;
  authorIconUrl: string | null;
  authorUrl: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
  fields: { name: string; value: string; inline: boolean }[];
  thumbnailUrl: string | null;
  imageUrl: string | null;
  footerText: string | null;
  footerIconUrl: string | null;
}

export interface ParsedTranscriptMessage {
  avatarUrl: string;
  username: string;
  isBot: boolean;
  timestamp: string;
  content: string;
  embeds: ParsedTranscriptEmbed[];
  imageUrls: string[];
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<span class="mention">(@[^<]*)<\/span>/g, '$1')
    .replace(/<span class="mention">(#[^<]*)<\/span>/g, '$1')
    .replace(/<code class="inline-code">([^<]*)<\/code>/g, '`$1`')
    .replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, '```\n$1```')
    .replace(/<strong>(.*?)<\/strong>/g, '**$1**')
    .replace(/<em>(.*?)<\/em>/g, '*$1*')
    .replace(/<u>(.*?)<\/u>/g, '__$1__')
    .replace(/<del>(.*?)<\/del>/g, '~~$1~~')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/g, '$1')
    .replace(/<img[^>]*class="discord-emoji"[^>]*alt="([^"]*)"[^>]*\/?>/g, '$1')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parseEmbedFromHtml(embedHtml: string): ParsedTranscriptEmbed {
  const colorMatch = embedHtml.match(/border-left-color:\s*([^"]+)/);

  const authorIconMatch = embedHtml.match(/<img class="discord-embed-author-icon" src="([^"]*?)"/);
  const authorLinkMatch = embedHtml.match(/<a class="discord-embed-author-link" href="([^"]*?)"[^>]*>([^<]*)<\/a>/);
  const authorSpanMatch = !authorLinkMatch ? embedHtml.match(/<div class="discord-embed-author">[^]*?<span>([^<]*)<\/span>/) : null;

  const titleLinkMatch = embedHtml.match(/<div class="discord-embed-title">\s*<a href="([^"]*?)"[^>]*>([^<]*)<\/a>/);
  const titlePlainMatch = !titleLinkMatch ? embedHtml.match(/<div class="discord-embed-title">\s*([^<]+)/) : null;

  const descMatch = embedHtml.match(/<div class="discord-embed-description">([\s\S]*?)<\/div>/);

  const fields: { name: string; value: string; inline: boolean }[] = [];
  const fieldRegex = /<div class="discord-embed-field\s*(inline)?\s*">\s*<div class="discord-embed-field-name">([^<]*)<\/div>\s*<div class="discord-embed-field-value">([\s\S]*?)<\/div>/g;
  let fieldMatch;
  while ((fieldMatch = fieldRegex.exec(embedHtml)) !== null) {
    fields.push({
      name: unescapeHtml(fieldMatch[2]),
      value: unescapeHtml(stripHtmlTags(fieldMatch[3])),
      inline: !!fieldMatch[1]
    });
  }

  const thumbnailMatch = embedHtml.match(/<img class="discord-embed-thumbnail" src="([^"]*?)"/);
  const imageMatch = embedHtml.match(/<img class="discord-embed-image" src="([^"]*?)"/);
  const footerTextMatch = embedHtml.match(/<span class="discord-embed-footer-text">\s*([\s\S]*?)\s*<\/span>/);
  const footerIconMatch = embedHtml.match(/<img class="discord-embed-footer-icon" src="([^"]*?)"/);

  return {
    color: colorMatch ? colorMatch[1].trim() : null,
    authorName: authorLinkMatch ? unescapeHtml(authorLinkMatch[2]) : (authorSpanMatch ? unescapeHtml(authorSpanMatch[1]) : null),
    authorIconUrl: authorIconMatch ? authorIconMatch[1] : null,
    authorUrl: authorLinkMatch ? authorLinkMatch[1] : null,
    title: titleLinkMatch ? unescapeHtml(titleLinkMatch[2]) : (titlePlainMatch ? unescapeHtml(titlePlainMatch[1].trim()) : null),
    url: titleLinkMatch ? titleLinkMatch[1] : null,
    description: descMatch ? unescapeHtml(stripHtmlTags(descMatch[1])) : null,
    fields,
    thumbnailUrl: thumbnailMatch ? thumbnailMatch[1] : null,
    imageUrl: imageMatch ? imageMatch[1] : null,
    footerText: footerTextMatch ? unescapeHtml(footerTextMatch[1].replace(/\s*•\s*.*$/, '').trim()) : null,
    footerIconUrl: footerIconMatch ? footerIconMatch[1] : null,
  };
}

/**
 * Les transcriptions générées avant le correctif posaient un fond bleu sous
 * chaque avatar, visible à travers les avatars transparents (celui de Kotbo
 * en tête). Le HTML étant stocké tel quel, on retire ce fond au service.
 */
export function stripLegacyAvatarBackground(html: string): string {
  return html.replace(/(\.avatar\s*\{[^}]*?)background-color:\s*#5865F2;\s*/i, '$1');
}

export function parseTranscriptHtml(html: string): ParsedTranscriptMessage[] {
  const messages: ParsedTranscriptMessage[] = [];

  // Split on message-group boundaries to get each message block
  const blocks = html.split(/<div class="message-group">/);
  blocks.shift(); // remove content before first message

  for (const rawBlock of blocks) {
    // Re-add the opening tag for consistency
    const block = `<div class="message-group">${rawBlock}`;

    const avatarMatch = block.match(/<img class="avatar" src="([^"]*?)"/);
    const usernameMatch = block.match(/<span class="username"[^>]*>([^<]*)<\/span>/);
    const isBotMatch = block.match(/<span class="bot-tag">BOT<\/span>/);
    const timestampMatch = block.match(/<span class="timestamp">([^<]*)<\/span>/);
    const textMatch = block.match(/<div class="message-text">([\s\S]*?)<\/div>/);

    if (!usernameMatch) continue;

    const rawContent = textMatch ? stripHtmlTags(textMatch[1]) : '';
    const content = unescapeHtml(rawContent);

    // Extract embeds
    const embeds: ParsedTranscriptEmbed[] = [];
    const embedRegex = /<div class="discord-embed"[\s\S]*?(?=<div class="discord-embed"|<div class="message-group">|<div class="reactions-list">|$)/g;
    let embedMatch;
    while ((embedMatch = embedRegex.exec(block)) !== null) {
      embeds.push(parseEmbedFromHtml(embedMatch[0]));
    }

    // Extract standalone images (attachments)
    const imageUrls: string[] = [];
    const imgRegex = /<img src="([^"]*?)" class="discord-img"/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(block)) !== null) {
      imageUrls.push(imgMatch[1]);
    }

    messages.push({
      avatarUrl: avatarMatch ? avatarMatch[1] : '',
      username: unescapeHtml(usernameMatch[1]),
      isBot: !!isBotMatch,
      timestamp: timestampMatch ? timestampMatch[1] : '',
      content,
      embeds,
      imageUrls
    });
  }

  return messages;
}

/**
 * Resolves Discord mentions (<@id>, <#id>, <@&id>) in raw (non-escaped) message
 * text into plain readable text (@Pseudo, #salon, @Rôle) - no HTML produced.
 * Used by API responses that are rendered client-side without {@html}.
 */
export function resolveMentionsToText(text: string, guild?: Guild): string {
  if (!guild) {
    return text
      .replace(/<@!?(\d+)>/g, '@Utilisateur')
      .replace(/<#(\d+)>/g, '#salon')
      .replace(/<@&(\d+)>/g, '@Rôle');
  }

  return text
    .replace(/<@!?(\d+)>/g, (_, id) => {
      const member = guild.members.cache.get(id);
      const user = guild.client.users.cache.get(id);
      return `@${member?.displayName || user?.username || 'Utilisateur inconnu'}`;
    })
    .replace(/<#(\d+)>/g, (_, id) => `#${guild.channels.cache.get(id)?.name || 'salon-inconnu'}`)
    .replace(/<@&(\d+)>/g, (_, id) => `@${guild.roles.cache.get(id)?.name || 'rôle-inconnu'}`);
}

/**
 * Builds a plain-data representation of a Discord embed (no HTML), suitable
 * for client-side Svelte rendering without {@html}.
 */
export function embedToApiShape(embed: Embed, guild?: Guild): ParsedTranscriptEmbed {
  return {
    color: embed.hexColor,
    authorName: embed.author?.name ?? null,
    authorIconUrl: embed.author?.iconURL ?? null,
    authorUrl: embed.author?.url ?? null,
    title: embed.title,
    url: embed.url,
    description: embed.description ? resolveMentionsToText(embed.description, guild) : null,
    fields: (embed.fields ?? []).map((f) => ({
      name: f.name,
      value: resolveMentionsToText(f.value, guild),
      inline: f.inline ?? false,
    })),
    thumbnailUrl: embed.thumbnail?.url ?? null,
    imageUrl: embed.image?.url ?? null,
    footerText: embed.footer?.text ?? null,
    footerIconUrl: embed.footer?.iconURL ?? null,
  };
}

/** Transcrit tout l'historique d'un salon et l'enregistre en base. */
export async function generateTranscript(channel: TextChannel): Promise<{ id: string; url: string; count: number }> {
  logger.info('Transcript', `Génération de la transcription pour #${channel.name} (${channel.id})...`);
  
  // 1. Fetch ALL messages in chronological order
  const allMessages: Message[] = [];
  let lastId: string | undefined;

  for (;;) {
    const options = { limit: 100, before: lastId };
    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;
    allMessages.push(...messages.values());
    lastId = messages.last()?.id;
  }

  // Reverse so they are in chronological order (oldest to newest)
  allMessages.reverse();

  return generateTranscriptFromMessages(channel, allMessages);
}

/**
 * Enregistre la transcription JSON (`TranscriptDataV1`) d'une suite de
 * messages, dans l'ordre donné. Les transcriptions HTML historiques restent
 * lisibles via `parseTranscriptHtml`.
 */
export async function generateTranscriptFromMessages(channel: TextChannel | NewsChannel, allMessages: Message[]): Promise<{ id: string; url: string; count: number }> {
  const data = await buildTranscriptData(channel, allMessages);
  const firstMsg = allMessages[0];
  const lastMsg = allMessages[allMessages.length - 1];

  const transcript = await prisma.transcript.create({
    data: {
      guildId: channel.guild.id,
      channelId: channel.id,
      channelName: channel.name,
      format: 'json',
      data: data as unknown as Prisma.InputJsonValue,
      messageCount: allMessages.length,
      startMessageId: firstMsg?.id || null,
      endMessageId: lastMsg?.id || null,
      startTime: firstMsg?.createdAt || null,
      endTime: lastMsg?.createdAt || null,
    },
  });

  logger.success('Transcript', `Transcription générée pour #${channel.name} (${allMessages.length} messages) : ID ${transcript.id}`);
  return { id: transcript.id, url: `/transcripts/${transcript.id}`, count: allMessages.length };
}

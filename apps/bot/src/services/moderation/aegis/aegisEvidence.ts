/**
 * Preuve d'une détection AegisAI : transcription du salon autour du message,
 * prise AVANT tout retrait (après, il n'y a plus rien à transcrire). Le lien
 * part dans la sanction (rapport de sanction) et sur la carte du staff.
 *
 * Quelques messages qui précèdent sont inclus : une insulte se juge dans son
 * contexte (réponse à une provocation, chambrage entre amis).
 */
import type { Guild, GuildTextBasedChannel, Message } from 'discord.js';
import { logger } from '../../../utils/logger.js';

export const EVIDENCE_CONTEXT = 10;

async function textChannel(guild: Guild, channelId: string): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  return channel && channel.isTextBased() ? channel : null;
}

/**
 * Transcription des `context` messages qui précèdent `messageId`, puis du
 * message lui-même s'il existe encore. Sans `messageId`, les derniers messages
 * du salon (escalade). Rend l'URL complète, ou null si rien n'a pu être pris.
 */
export async function captureEvidence(
  guild: Guild,
  channelId: string,
  messageId: string | null,
  context = EVIDENCE_CONTEXT,
): Promise<string | null> {
  try {
    const channel = await textChannel(guild, channelId);
    if (!channel) return null;

    const target: Message<true> | null = messageId ? await channel.messages.fetch(messageId).catch(() => null) : null;
    const before = await channel.messages
      .fetch({ limit: Math.min(100, Math.max(1, context)), ...(messageId ? { before: messageId } : {}) })
      .catch(() => null);
    const messages = [...(before?.values() ?? [])].reverse();
    if (target) messages.push(target);
    if (messages.length === 0) return null;

    const [{ generateTranscriptFromMessages }, { getDashboardUrl }] = await Promise.all([
      import('../../features/transcriptService.js'),
      import('../../../api/shared.js'),
    ]);
    // Les fils et salons vocaux textuels ont ce dont la transcription se sert
    // (id, nom, serveur), comme les salons textuels qu'elle déclare.
    const transcript = await generateTranscriptFromMessages(channel as Parameters<typeof generateTranscriptFromMessages>[0], messages);
    return `${getDashboardUrl()}${transcript.url}`;
  } catch (err) {
    logger.warn('AegisAI', `Preuve non capturée (${guild.id}/${channelId}) :`, err);
    return null;
  }
}

/** Liens de preuve sans doublon ni vide, dans l'ordre. */
export function evidenceLinks(...links: Array<string | null | undefined>): string[] {
  return [...new Set(links.filter((link): link is string => Boolean(link)))];
}

/** Motif de sanction avec l'extrait en cause : la preuve se lit dès le casier. */
export function reasonWithExcerpt(base: string, excerpt: string | null | undefined): string {
  const flat = (excerpt ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return base;
  return `${base} : « ${flat.length > 200 ? `${flat.slice(0, 199)}…` : flat} »`;
}

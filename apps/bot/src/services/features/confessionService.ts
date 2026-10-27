import { EmbedBuilder, type Guild, type TextBasedChannel } from 'discord.js';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { COLORS } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

export const CONFESSION_MAX_LENGTH = 1500;
const CONFESSION_COOLDOWN_MS = 60_000;

const lastSentAt = new Map<string, number>();

export type ConfessionResult =
  | { ok: true; number: number }
  | { ok: false; reason: 'cooldown' | 'empty' | 'too_long' | 'not_configured' | 'send_failed'; retryInSeconds?: number };

function isSendable(channel: unknown): channel is TextBasedChannel & { send: (o: unknown) => Promise<{ id: string }> } {
  return !!channel && typeof (channel as { send?: unknown }).send === 'function';
}

/** Numéro suivant du serveur. La contrainte unique rejoue en cas de course. */
async function createWithNextNumber(guildId: string, authorId: string, content: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await prisma.confession.findFirst({
      where: { guildId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    try {
      return await prisma.confession.create({
        data: { guildId, authorId, content, number: (last?.number ?? 0) + 1 },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  throw new Error('Numéro de confession introuvable après 5 essais');
}

export async function submitConfession(
  guild: Guild,
  channelId: string | null,
  logChannelId: string | null,
  authorId: string,
  rawContent: string,
): Promise<ConfessionResult> {
  if (!channelId) return { ok: false, reason: 'not_configured' };

  const content = rawContent.trim();
  if (!content) return { ok: false, reason: 'empty' };
  if (content.length > CONFESSION_MAX_LENGTH) return { ok: false, reason: 'too_long' };

  const key = `${guild.id}:${authorId}`;
  const wait = (lastSentAt.get(key) ?? 0) + CONFESSION_COOLDOWN_MS - Date.now();
  if (wait > 0) return { ok: false, reason: 'cooldown', retryInSeconds: Math.ceil(wait / 1000) };
  lastSentAt.set(key, Date.now());

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!isSendable(channel)) {
    lastSentAt.delete(key);
    return { ok: false, reason: 'not_configured' };
  }

  const confession = await createWithNextNumber(guild.id, authorId, content);

  try {
    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`Confession #${confession.number}`)
      .setDescription(content)
      .setTimestamp();
    // Aucune mention ne doit partir d'un message anonyme.
    const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    await prisma.confession.update({ where: { id: confession.id }, data: { messageId: sent.id } });
  } catch (err) {
    logger.warn('Confession', `Envoi impossible sur ${guild.id}`, err);
    await prisma.confession.delete({ where: { id: confession.id } }).catch(() => undefined);
    lastSentAt.delete(key);
    return { ok: false, reason: 'send_failed' };
  }

  await postStaffLog(guild, logChannelId, `Confession #${confession.number} envoyée (auteur consigné, révélable par un administrateur).`);
  return { ok: true, number: confession.number };
}

async function postStaffLog(guild: Guild, logChannelId: string | null, message: string): Promise<void> {
  if (!logChannelId) return;
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!isSendable(channel)) return;
  await channel
    .send({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setDescription(message)], allowedMentions: { parse: [] } })
    .catch(() => undefined);
}

/** Révèle l'auteur à l'administrateur seul ; la révélation est tracée côté staff. */
export async function revealConfession(
  guild: Guild,
  logChannelId: string | null,
  number: number,
  revealedBy: string,
): Promise<{ authorId: string; content: string } | null> {
  const confession = await prisma.confession.findUnique({
    where: { guildId_number: { guildId: guild.id, number } },
  });
  if (!confession) return null;

  await prisma.confession.update({
    where: { id: confession.id },
    data: { revealedAt: new Date(), revealedBy },
  });
  await postStaffLog(guild, logChannelId, `Confession #${number} révélée par <@${revealedBy}>.`);
  return { authorId: confession.authorId, content: confession.content };
}

export async function setConfessionChannels(guildId: string, channelId: string | null, logChannelId: string | null): Promise<void> {
  await prisma.guild.update({
    where: { id: guildId },
    data: { funConfessionChannelId: channelId, funConfessionLogChannelId: logChannelId },
  });
  await cache.invalidateGuild(guildId);
}

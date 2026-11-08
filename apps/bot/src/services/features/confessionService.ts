import { EmbedBuilder, type Guild, type TextBasedChannel } from 'discord.js';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { COLORS } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { loadBannedWords } from '../moderation/bannedWordsService.js';
import { checkConfession, type ConfessionRefusal } from './confessionPolicy.js';

export { CONFESSION_MAX_LENGTH } from './confessionPolicy.js';

export type ConfessionResult =
  | { ok: true; number: number }
  | { ok: false; reason: ConfessionRefusal | 'not_configured' | 'send_failed'; retryInSeconds?: number };

function isSendable(channel: unknown): channel is TextBasedChannel & { send: (o: unknown) => Promise<{ id: string }> } {
  return !!channel && typeof (channel as { send?: unknown }).send === 'function';
}

/**
 * Vérifie puis enregistre la confession sous un verrou du serveur. Le délai
 * part de la dernière confession en base : il survit aux redémarrages et vaut
 * pour toutes les instances du bot. Deux envois simultanés (double clic, deux
 * instances) passent l'un après l'autre : le second voit la ligne du premier,
 * donc le délai, et prend le numéro suivant.
 */
async function reserveConfession(
  guildId: string,
  authorId: string,
  input: { rawContent: string; channelId: string; cooldownSeconds: number; bannedWords: string[] },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`confession:${guildId}`}))`;
    const lastOfAuthor = await tx.confession.findFirst({
      where: { guildId, authorId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const check = checkConfession({
      content: input.rawContent,
      bannedWords: input.bannedWords,
      lastSentAt: lastOfAuthor?.createdAt ?? null,
      cooldownSeconds: input.cooldownSeconds,
      now: Date.now(),
    });
    if (!check.ok) return check;

    const lastOfGuild = await tx.confession.findFirst({
      where: { guildId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const confession = await tx.confession.create({
      data: { guildId, authorId, content: check.content, channelId: input.channelId, number: (lastOfGuild?.number ?? 0) + 1 },
    });
    return { ok: true as const, confession };
  });
}

export async function submitConfession(
  guild: Guild,
  config: { channelId: string | null; logChannelId: string | null; cooldownSeconds: number },
  authorId: string,
  rawContent: string,
): Promise<ConfessionResult> {
  const { channelId, logChannelId } = config;
  if (!channelId) return { ok: false, reason: 'not_configured' };

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!isSendable(channel)) return { ok: false, reason: 'not_configured' };

  const reserved = await reserveConfession(guild.id, authorId, {
    rawContent,
    channelId,
    cooldownSeconds: config.cooldownSeconds,
    bannedWords: await loadBannedWords(guild.id),
  });
  if (!reserved.ok) return reserved;
  const { confession } = reserved;
  const { content } = confession;

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

/** Code Discord d'un message déjà supprimé : le but est atteint. */
const UNKNOWN_MESSAGE = 10008;

/**
 * Retire une confession publiée : le message Discord est supprimé, la ligne
 * reste (contenu et auteur) pour garder la trace. Le retrait est noté dans le
 * journal staff. `message_kept` signale un message que le bot n'a pas pu
 * supprimer (permissions, salon disparu) : le staff doit le retirer à la main.
 */
export async function deleteConfession(
  guild: Guild,
  config: { channelId: string | null; logChannelId: string | null },
  number: number,
  deletedBy: string,
): Promise<'deleted' | 'message_kept' | 'not_found' | 'already_deleted'> {
  const confession = await prisma.confession.findUnique({
    where: { guildId_number: { guildId: guild.id, number } },
  });
  if (!confession) return 'not_found';
  if (confession.deletedAt) return 'already_deleted';

  // Les confessions antérieures au suivi du salon visent le salon actuel.
  const channelId = confession.channelId ?? config.channelId;
  const messageRemoved = !confession.messageId || await removeMessage(guild, channelId, confession.messageId);

  await prisma.confession.update({
    where: { id: confession.id },
    data: { deletedAt: new Date(), deletedBy },
  });
  await postStaffLog(guild, config.logChannelId, `Confession #${number} supprimée par <@${deletedBy}>.`);
  return messageRemoved ? 'deleted' : 'message_kept';
}

async function removeMessage(guild: Guild, channelId: string | null, messageId: string): Promise<boolean> {
  if (!channelId) return false;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  return channel.messages.delete(messageId).then(
    () => true,
    (err: { code?: number }) => err?.code === UNKNOWN_MESSAGE,
  );
}

export async function setConfessionSettings(
  guildId: string,
  settings: { channelId: string; logChannelId: string | null; cooldownSeconds?: number },
): Promise<void> {
  await prisma.guild.update({
    where: { id: guildId },
    data: {
      funConfessionChannelId: settings.channelId,
      funConfessionLogChannelId: settings.logChannelId,
      funConfessionCooldownSeconds: settings.cooldownSeconds,
    },
  });
  await cache.invalidateGuild(guildId);
}

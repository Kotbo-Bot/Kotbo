/**
 * Spam à plusieurs : quand plusieurs membres déclenchent l'anti-spam AutoMod
 * dans le même salon en peu de temps, le salon passe en mode lent au lieu de
 * sanctionner chacun. Un fou rire collectif ou une vague de raid se calment
 * mieux ainsi qu'avec une pluie d'avertissements.
 */

import { EmbedBuilder, type Message } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveLogChannel } from '../../utils/logChannel.js';
import { mirrorModlogToStaffServer } from '../staff/staffServerService.js';

/** Membres distincts qui doivent déclencher l'anti-spam dans la fenêtre. */
export const GROUP_SPAM_MIN_USERS = 3;
export const GROUP_SPAM_WINDOW_MS = 15_000;

const spammersByChannel = new Map<string, Map<string, number>>();
/** Salons en mode lent « spam à plusieurs », avec leur échéance. */
const slowedUntil = new Map<string, number>();

/** Enregistre un déclenchement et rend le nombre de membres distincts récents du salon. */
export function noteSpammer(channelId: string, userId: string, now: number): number {
  const spammers = spammersByChannel.get(channelId) ?? new Map<string, number>();
  for (const [id, at] of spammers) if (at <= now - GROUP_SPAM_WINDOW_MS) spammers.delete(id);
  spammers.set(userId, now);
  spammersByChannel.set(channelId, spammers);
  return spammers.size;
}

export function resetGroupSpam(): void {
  spammersByChannel.clear();
  slowedUntil.clear();
}

/**
 * @returns true si le salon est (ou vient d'être mis) en mode lent : l'appelant
 *          supprime le message sans sanctionner l'auteur.
 */
export async function handleGroupSpam(message: Message, slowmodeSec: number, durationMin: number): Promise<boolean> {
  const now = Date.now();
  const channelId = message.channelId;
  const until = slowedUntil.get(channelId);
  if (until !== undefined) {
    if (until > now) return true;
    slowedUntil.delete(channelId);
  }
  if (noteSpammer(channelId, message.author.id, now) < GROUP_SPAM_MIN_USERS) return false;

  const channel = message.channel;
  if (!('setRateLimitPerUser' in channel) || !('rateLimitPerUser' in channel)) return false;

  const durationMs = durationMin * 60_000;
  const previous = channel.rateLimitPerUser ?? 0;
  // Un mode lent déjà plus strict est laissé tel quel.
  if (previous < slowmodeSec) {
    const applied = await channel
      .setRateLimitPerUser(slowmodeSec, '[AutoMod] Spam à plusieurs')
      .then(() => true)
      .catch(() => false);
    // Sans la permission, on retombe sur les sanctions individuelles.
    if (!applied) return false;

    // shortcut: levée en mémoire, un redémarrage pendant la fenêtre laisse le mode lent en place ; persister comme aegisDetection si ça gêne.
    setTimeout(() => {
      // Un modérateur qui a retouché le mode lent entre-temps garde la main.
      if (channel.rateLimitPerUser !== slowmodeSec) return;
      channel.setRateLimitPerUser(previous, '[AutoMod] Fin du spam à plusieurs').catch((err) => {
        logger.warn('AutoModService', `Mode lent non levé sur ${channelId} :`, err);
      });
    }, durationMs);

    if (channel.isSendable()) {
      await channel
        .send(`🐢 Beaucoup de messages d'un coup : mode lent de ${slowmodeSec} s pendant ${durationMin} min.`)
        .catch(() => null);
    }
  }

  slowedUntil.set(channelId, now + durationMs);
  const spammers = [...(spammersByChannel.get(channelId)?.keys() ?? [])];
  spammersByChannel.delete(channelId);
  void logGroupSpam(message, spammers, slowmodeSec, durationMin);
  return true;
}

async function logGroupSpam(message: Message, spammers: string[], slowmodeSec: number, durationMin: number): Promise<void> {
  try {
    const guild = message.guild!;
    const guildDb = await prisma.guild.findUnique({ where: { id: guild.id }, select: { logChannelId: true } });
    const embed = new EmbedBuilder()
      .setTitle('🐢 Spam à plusieurs')
      .setDescription(`Plusieurs membres ont spammé en même temps : le salon passe en mode lent au lieu de sanctionner chacun.`)
      .addFields(
        { name: 'Salon', value: `<#${message.channelId}>`, inline: true },
        { name: 'Mode lent', value: `${slowmodeSec} s pendant ${durationMin} min`, inline: true },
        { name: 'Membres', value: spammers.map((id) => `<@${id}>`).join(', ') || '-', inline: false }
      )
      .setColor('#FEE75C')
      .setTimestamp();

    const logChannel = await resolveLogChannel(guild, guildDb?.logChannelId, 'AutoModService');
    if (logChannel) await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
    await mirrorModlogToStaffServer(message.client, guild.id, embed);
  } catch (err) {
    logger.warn('AutoModService', "Impossible d'envoyer le log de spam à plusieurs :", err);
  }
}

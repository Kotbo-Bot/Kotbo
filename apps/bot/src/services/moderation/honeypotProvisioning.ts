/**
 * Creation du salon piege : le meme salon, qu'il vienne de la page Gestion des
 * salons ou de la mise en place guidee. Les deux entrees doivent poser le meme
 * appat, sans quoi un serveur monte d'un cote se ferait piloter par l'autre.
 */
import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type Message,
  type OverwriteResolvable,
  type TextChannel,
} from 'discord.js';
import type { BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import prisma from '../../utils/db.js';
import { formatMinutes } from './autoSanction.js';

export function honeypotChannelName(locale: BotLocale): string {
  return m.setup_template_channel_honeypot({}, { locale });
}

export type HoneypotNoticeConfig = {
  honeypotSanction: string;
  honeypotDurationMin: number | null;
  honeypotGraceSeconds: number;
  honeypotShowCount: boolean;
  honeypotCatchCount: number;
};

const TIMEOUT_MAX_MIN = 28 * 24 * 60;

/** Ce qui attend l'auteur d'un message, dit avec la sanction réellement configurée. */
export function honeypotConsequence(cfg: Pick<HoneypotNoticeConfig, 'honeypotSanction' | 'honeypotDurationMin'>): string {
  const d = cfg.honeypotDurationMin;
  switch (cfg.honeypotSanction) {
    case 'BAN':
      return d ? `**un bannissement de ${formatMinutes(d)}**` : '**un bannissement immédiat et définitif**, sans possibilité de débannissement';
    case 'SOFTBAN':
      return "**une expulsion du serveur** et la suppression de tes messages des 7 derniers jours";
    case 'KICK':
      return '**une expulsion du serveur**';
    case 'JAIL':
      return d ? `**une mise en quarantaine de ${formatMinutes(d)}**` : '**une mise en quarantaine définitive**';
    case 'WARN':
      return '**un avertissement** inscrit à ton casier';
    default:
      return `**une exclusion temporaire de ${formatMinutes(Math.min(d ?? TIMEOUT_MAX_MIN, TIMEOUT_MAX_MIN))}**`;
  }
}

export function honeypotNoticeEmbed(cfg: HoneypotNoticeConfig): EmbedBuilder {
  const grace = cfg.honeypotGraceSeconds > 0
    ? `\n\nSi tu écris ici par erreur, un bouton te laissera ${cfg.honeypotGraceSeconds >= 60 ? `${cfg.honeypotGraceSeconds / 60} min` : `${cfg.honeypotGraceSeconds} s`} pour le signaler.`
    : '';
  const embed = new EmbedBuilder()
    .setTitle("N'ÉCRIS PAS DANS CE SALON, MÊME POUR RIGOLER")
    .setDescription(`Ce salon sert à piéger les robots de spam. Tout message envoyé ici entraîne ${honeypotConsequence(cfg)}.${grace}`)
    .setColor(0xEE5555)
    .setFooter({ text: 'Système de protection Kotbo' });
  if (cfg.honeypotShowCount) {
    embed.addFields({ name: 'Comptes piégés', value: cfg.honeypotCatchCount.toLocaleString('fr-FR'), inline: true });
  }
  return embed;
}

/**
 * Met l'avertissement du salon piège en accord avec la configuration. Un salon
 * monté avant le suivi du message est retrouvé parmi ses derniers messages du
 * bot ; `createIfMissing` n'en pose un neuf que sur un enregistrement explicite,
 * jamais à chaque prise (un salon choisi par le staff peut avoir son propre texte).
 */
export async function refreshHoneypotNotice(guild: Guild, opts: { createIfMissing?: boolean } = {}): Promise<void> {
  const cfg = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: {
      honeypotEnabled: true,
      honeypotChannelId: true,
      honeypotNoticeMessageId: true,
      honeypotSanction: true,
      honeypotDurationMin: true,
      honeypotGraceSeconds: true,
      honeypotShowCount: true,
      honeypotCatchCount: true,
    },
  });
  if (!cfg?.honeypotEnabled || !cfg.honeypotChannelId) return;
  const channel = guild.channels.cache.get(cfg.honeypotChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const payload = { embeds: [honeypotNoticeEmbed(cfg)], allowedMentions: { parse: [] } };
  let notice: Message | null = cfg.honeypotNoticeMessageId
    ? await channel.messages.fetch(cfg.honeypotNoticeMessageId).catch(() => null)
    : null;
  if (!notice) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    notice = recent?.find((msg) => msg.author.id === guild.client.user.id && msg.embeds.length > 0 && msg.components.length === 0) ?? null;
  }

  if (notice) {
    await notice.edit(payload).catch(() => null);
  } else if (opts.createIfMissing) {
    notice = await channel.send(payload).catch(() => null);
  }
  if (notice && notice.id !== cfg.honeypotNoticeMessageId) {
    await prisma.guild.update({ where: { id: guild.id }, data: { honeypotNoticeMessageId: notice.id } }).catch(() => null);
  }
}

/** Une prise de plus : le compteur monte, et l'avertissement suit s'il l'affiche. */
export async function recordHoneypotCatch(guild: Guild): Promise<void> {
  const { honeypotShowCount } = await prisma.guild.update({
    where: { id: guild.id },
    data: { honeypotCatchCount: { increment: 1 } },
    select: { honeypotShowCount: true },
  });
  // shortcut: une édition par prise ; un raid de centaines de comptes file dans la limite de débit Discord, regrouper si ça gêne.
  if (honeypotShowCount) await refreshHoneypotNotice(guild);
}

/**
 * Le salon est pose hors categorie et en tete de la liste : un appat range au
 * milieu des salons du serveur ne serait vu par personne, la ou le premier
 * salon de la colonne est celui qu'un bot de spam ouvre en arrivant.
 *
 * Il reste ouvert a @everyone meme sur un serveur ferme : sans le droit d'y
 * ecrire, il n'attrape rien.
 */
export async function provisionHoneypotChannel(guild: Guild, input: {
  name: string;
  reason?: string;
  extraOverwrites?: OverwriteResolvable[];
}): Promise<TextChannel> {
  const channel = await guild.channels.create({
    name: input.name,
    type: ChannelType.GuildText,
    position: 0,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      },
      ...(input.extraOverwrites ?? []),
    ],
    reason: input.reason,
  });

  // L'avertissement reçoit la configuration une fois le salon enregistré
  // (refreshHoneypotNotice) ; d'ici là, celle par défaut.
  const cfg = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: { honeypotSanction: true, honeypotDurationMin: true, honeypotGraceSeconds: true, honeypotShowCount: true, honeypotCatchCount: true },
  }).catch(() => null);
  const notice = await channel
    .send({
      embeds: [honeypotNoticeEmbed(cfg ?? { honeypotSanction: 'TIMEOUT', honeypotDurationMin: null, honeypotGraceSeconds: 0, honeypotShowCount: false, honeypotCatchCount: 0 })],
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  if (notice) {
    await prisma.guild.update({ where: { id: guild.id }, data: { honeypotNoticeMessageId: notice.id } }).catch(() => null);
  }

  return channel;
}

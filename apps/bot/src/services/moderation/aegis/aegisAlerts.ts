/**
 * Cartes envoyées au staff par le module : message à vérifier, action
 * automatique, harcèlement, escalade, détresse. Chaque carte porte les
 * boutons qui tranchent (`aegis:<geste>:<id de détection>`).
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ColorResolvable,
  type Guild,
  type SendableChannels,
} from 'discord.js';
import type { AegisDetection } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { COLORS, truncate } from '../../../utils/embeds.js';
import { resolveLogChannel } from '../../../utils/logChannel.js';
import type { AegisEmotion } from './aegisClient.js';

export const AEGIS_BUTTON_PREFIX = 'aegis:';
export type AegisButtonAction = 'confirm' | 'dismiss' | 'unslow';

export function parseAegisButton(customId: string): { action: AegisButtonAction; detectionId: string } | null {
  if (!customId.startsWith(AEGIS_BUTTON_PREFIX)) return null;
  const [, action, detectionId] = customId.split(':');
  if (!detectionId || (action !== 'confirm' && action !== 'dismiss' && action !== 'unslow')) return null;
  return { action, detectionId };
}

export const EMOTION_LABELS: Record<AegisEmotion, string> = {
  joy: 'Joie',
  sad: 'Tristesse',
  anger: 'Colère',
  fear: 'Peur',
  surprise: 'Surprise',
  neutral: 'Neutre',
};

export const pct = (score: number) => `${Math.round(score * 100)} %`;

export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

const FOOTER = 'Kotbo × AegisAI';

const SOURCE_LABELS: Record<string, string> = {
  MESSAGE: 'Message',
  EDIT: 'Message modifié',
  NICKNAME: 'Pseudo',
  TICKET: 'Ticket',
};

const ACTION_LABELS: Record<string, string> = {
  DELETE: 'Message supprimé',
  WARN: 'Message supprimé + avertissement',
  TIMEOUT: 'Message supprimé + exclusion temporaire',
  NICKNAME_RESET: 'Pseudo remplacé',
  SLOWMODE: 'Mode lent activé',
  ALERT: 'Alerte au staff',
  REVIEW: 'À vérifier',
  NONE: 'Aucune',
};

type CardDetection = Pick<
  AegisDetection,
  'id' | 'guildId' | 'channelId' | 'messageId' | 'authorId' | 'targetUserId' | 'kind' | 'source' | 'toxicity' | 'emotion' | 'emotionScore' | 'excerpt' | 'action' | 'status' | 'late'
>;

function scoreFields(detection: CardDetection): Array<{ name: string; value: string; inline: boolean }> {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  fields.push({
    name: 'Toxicité',
    value: detection.toxicity === null ? 'AegisAI indisponible : repéré par la liste de mots bannis' : pct(detection.toxicity),
    inline: true,
  });
  if (detection.emotion) {
    const label = EMOTION_LABELS[detection.emotion as AegisEmotion] ?? detection.emotion;
    fields.push({ name: 'Émotion', value: detection.emotionScore !== null ? `${label} (${pct(detection.emotionScore)})` : label, inline: true });
  }
  return fields;
}

function excerptField(excerpt: string | null): { name: string; value: string; inline: boolean } | null {
  if (!excerpt) return null;
  // Bloc de code : une insulte reste lisible sans être rendue en mentions ou en liens.
  return { name: 'Extrait', value: `\`\`\`\n${truncate(excerpt.replace(/`/g, 'ˋ'), 900)}\n\`\`\``, inline: false };
}

/** Carte d'une détection de message ou de pseudo toxique. */
export function buildToxicEmbed(detection: CardDetection, note?: string): EmbedBuilder {
  const auto = detection.status === 'AUTO';
  const embed = new EmbedBuilder()
    .setColor((auto ? COLORS.danger : COLORS.warning) as ColorResolvable)
    .setTitle(auto ? '🛡️ Propos toxiques retirés' : '🔎 Propos à vérifier')
    .setFooter({ text: FOOTER })
    .setTimestamp()
    .addFields(
      { name: 'Membre', value: `<@${detection.authorId}> (\`${detection.authorId}\`)`, inline: true },
      { name: SOURCE_LABELS[detection.source] ?? 'Source', value: detection.source === 'NICKNAME' ? '—' : `<#${detection.channelId}>`, inline: true },
      { name: 'Action', value: ACTION_LABELS[detection.action] ?? detection.action, inline: true },
      ...scoreFields(detection),
    );
  if (detection.targetUserId) embed.addFields({ name: 'Visé', value: `<@${detection.targetUserId}>`, inline: true });
  const excerpt = excerptField(detection.excerpt);
  if (excerpt) embed.addFields(excerpt);
  const notes = [
    detection.late ? "Analysé avec du retard (file chargée) : rien n'a été retiré d'office." : null,
    note ?? null,
  ].filter(Boolean);
  if (notes.length) embed.setDescription(notes.join('\n'));
  return embed;
}

export function buildHarassmentEmbed(detection: CardDetection, count: number, excerpts: string[]): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('🚨 Harcèlement probable')
    .setDescription(`<@${detection.authorId}> a visé <@${detection.targetUserId}> avec **${count}** messages toxiques en peu de temps.`)
    .addFields(
      { name: 'Salon', value: `<#${detection.channelId}>`, inline: true },
      { name: 'Action', value: ACTION_LABELS[detection.action] ?? detection.action, inline: true },
      ...(excerpts.length
        ? [{ name: 'Derniers messages', value: truncate(excerpts.map((e) => `• ${e.replace(/`/g, 'ˋ')}`).join('\n'), 1000), inline: false }]
        : []),
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildConflictEmbed(detection: CardDetection, authors: string[], count: number, slowmodeSec: number | null, durationMin: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🔥 Le ton monte')
    .setDescription(
      `**${count}** messages tendus dans <#${detection.channelId}> en quelques minutes.`
      + (slowmodeSec ? `\nMode lent de ${slowmodeSec} s posé pour ${durationMin} min, puis levé automatiquement.` : "\nLe mode lent n'a pas pu être posé (permission manquante ?)."),
    )
    .addFields({ name: 'Membres impliqués', value: truncate(authors.map((id) => `<@${id}>`).join(' '), 1000), inline: false })
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildDistressEmbed(detection: CardDetection): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('💙 Un membre semble en difficulté')
    .setDescription(
      `Un message de <@${detection.authorId}> dans <#${detection.channelId}> exprime une forte ${detection.emotion === 'fear' ? 'peur' : 'tristesse'}.\n`
      + "Aucune sanction n'est appliquée. Un échange bienveillant en privé peut aider.",
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
  const excerpt = excerptField(detection.excerpt);
  if (excerpt) embed.addFields(excerpt);
  return embed;
}

/** Boutons d'une carte selon ce qu'il reste à trancher. */
export function buildButtons(
  detection: Pick<CardDetection, 'id' | 'kind' | 'status' | 'guildId' | 'channelId' | 'messageId' | 'source'> & { evidenceUrl?: string | null },
  opts: { canUnslow?: boolean } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (detection.status === 'PENDING') {
    const confirmLabel = detection.kind === 'TOXIC' ? 'Confirmer et sanctionner' : 'Pris en charge';
    row.addComponents(
      new ButtonBuilder().setCustomId(`aegis:confirm:${detection.id}`).setLabel(confirmLabel).setStyle(detection.kind === 'TOXIC' ? ButtonStyle.Danger : ButtonStyle.Primary),
    );
  }
  if (opts.canUnslow) {
    row.addComponents(new ButtonBuilder().setCustomId(`aegis:unslow:${detection.id}`).setLabel('Lever le mode lent').setStyle(ButtonStyle.Secondary));
  }
  if (detection.status === 'PENDING' || detection.status === 'AUTO') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`aegis:dismiss:${detection.id}`)
        .setLabel(detection.kind === 'DISTRESS' ? 'Fausse alerte' : 'Faux positif')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  // Le message n'existe plus quand le bot l'a retiré : pas de lien mort.
  if (detection.messageId && detection.status !== 'AUTO' && detection.source !== 'NICKNAME') {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Voir le message').setURL(messageUrl(detection.guildId, detection.channelId, detection.messageId)),
    );
  }
  // La transcription survit au retrait du message : c'est elle qui fait foi.
  if (detection.evidenceUrl && /^https?:\/\//.test(detection.evidenceUrl)) {
    row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Preuve').setURL(detection.evidenceUrl));
  }
  return row.components.length ? [row] : [];
}

/** Salon des cartes : celui demandé, sinon le salon de logs du serveur. */
export async function resolveAlertChannel(guild: Guild, preferredId: string | null): Promise<SendableChannels | null> {
  if (preferredId) {
    const preferred = await resolveLogChannel(guild, preferredId, 'AegisAI');
    if (preferred) return preferred;
  }
  const row = await prisma.guild.findUnique({ where: { id: guild.id }, select: { logChannelId: true } });
  return resolveLogChannel(guild, row?.logChannelId, 'AegisAI');
}

/** Envoie une carte et la rattache à sa détection. */
export async function postAlert(
  guild: Guild,
  channelId: string | null,
  detectionId: string,
  payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] },
): Promise<void> {
  const channel = await resolveAlertChannel(guild, channelId);
  if (!channel) {
    logger.warn('AegisAI', `Aucun salon pour la carte ${detectionId} sur ${guild.id}`);
    return;
  }
  const sent = await channel.send({ ...payload, allowedMentions: { parse: [] } }).catch((err) => {
    logger.warn('AegisAI', `Carte ${detectionId} non envoyée :`, err);
    return null;
  });
  if (sent) {
    await prisma.aegisDetection.update({
      where: { id: detectionId },
      data: { alertChannelId: sent.channelId, alertMessageId: sent.id },
    }).catch(() => null);
  }
}

/** Ajoute la décision à la carte et retire les boutons devenus sans objet. */
export async function closeAlert(
  guild: Guild,
  detection: Pick<AegisDetection, 'alertChannelId' | 'alertMessageId'>,
  decision: string,
  keepComponents: ActionRowBuilder<ButtonBuilder>[] = [],
): Promise<void> {
  if (!detection.alertChannelId || !detection.alertMessageId) return;
  const channel = await guild.channels.fetch(detection.alertChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(detection.alertMessageId).catch(() => null);
  if (!message) return;
  const [first] = message.embeds;
  const embed = first ? EmbedBuilder.from(first) : new EmbedBuilder();
  embed.addFields({ name: 'Décision', value: decision, inline: false });
  await message.edit({ embeds: [embed], components: keepComponents }).catch(() => null);
}

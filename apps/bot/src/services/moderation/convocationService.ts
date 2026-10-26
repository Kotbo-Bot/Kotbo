/**
 * Convocations : la moderation convoque un membre.
 *
 * Un message dans le salon (accuse de reception par ✅), un fil « Convocation •
 * membre » ou le membre propose un creneau ou se dit disponible tout de suite,
 * et une action a l'echeance si le membre n'a donne aucun signe : alerter le
 * staff, avertir, exclure 24 h, ou rien.
 *
 * Repondre, c'est accuser reception, ecrire dans le fil, ou proposer un
 * creneau : n'importe lequel des trois suspend l'echeance.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Message,
  type MessageReaction,
  type ModalSubmitInteraction,
  type NewsChannel,
  type PartialMessageReaction,
  type PartialUser,
  type TextChannel,
  type User,
} from 'discord.js';
import type { Convocation } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { COLORS_RAW } from '../../utils/embeds.js';
import { registerTimeoutSanction, registerWarnSanction } from './sanctionService.js';
import { ackLine, expiryNotice, type ExpiryAction } from './convocationRules.js';

export const CONVOCATION_THREAD_PREFIX = 'Convocation •';

const ACK_EMOJI = '✅';
const EXPIRY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function buildConvocationEmbed(c: Convocation, avatarUrl: string | null): EmbedBuilder {
  const deadline = Math.floor(c.deadline.getTime() / 1000);
  const hours = Math.round((c.deadline.getTime() - c.createdAt.getTime()) / 3_600_000);
  const embed = new EmbedBuilder()
    .setColor(c.status === 'CLOSED' || c.status === 'EXPIRED' ? COLORS_RAW.dark : COLORS_RAW.danger)
    .setTitle('📋 Convocation')
    .setDescription(`<@${c.userId}>, vous êtes **convoqué(e)** par la modération.`)
    .addFields(
      { name: '👤 Membre convoqué', value: `<@${c.userId}>`, inline: true },
      { name: '👮 Convoqué par', value: `<@${c.staffId}>`, inline: true },
      { name: '⏳ Délai de réponse', value: `<t:${deadline}:F> (<t:${deadline}:R>)`, inline: true },
      { name: '📝 Raison', value: c.reason },
      {
        name: '📌 Marche à suivre',
        value: [
          '1️⃣ Indiquez vos **disponibilités** (jours et horaires) dans le **fil** ci-dessous.',
          `2️⃣ **Accusez réception** en réagissant avec ${ACK_EMOJI} sous ce message.`,
          '3️⃣ Si vous êtes **réellement indisponible**, prévenez-nous dans le fil.',
        ].join('\n'),
      },
      { name: '📬 Accusé de réception', value: ackLine(c) },
    )
    .setTimestamp(c.createdAt);
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  const notice = expiryNotice(c.expiryAction, hours);
  if (notice) embed.setFooter({ text: notice });
  return embed;
}

function buildThreadIntro(c: Convocation) {
  const embed = new EmbedBuilder()
    .setColor(COLORS_RAW.warning)
    .setTitle('🗓️ Vos disponibilités')
    .setDescription([
      `<@${c.userId}>, merci d'indiquer ici **quand vous êtes disponible** pour échanger avec la modération (jours et plages horaires).`,
      '',
      'Si vous ne pouvez **vraiment pas vous présenter**, prévenez-nous **dans ce fil**, avec la raison.',
      '',
      '🗓️ **Proposer une date** : proposez un jour et une heure, le staff accepte ou refuse.',
      `⚡ **Disponible maintenant** : prévenez le staff que vous êtes disponible tout de suite.${c.waitingChannelId ? " Si le staff accepte, vous pourrez vous connecter dans le salon d'attente." : ''}`,
    ].join('\n'));

  const memberRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`convoc:propose:${c.id}`).setLabel('Proposer une date').setStyle(ButtonStyle.Primary).setEmoji('🗓️'),
    new ButtonBuilder().setCustomId(`convoc:now:${c.id}`).setLabel('Disponible maintenant').setStyle(ButtonStyle.Success).setEmoji('⚡'),
  );
  if (c.waitingChannelId) {
    memberRow.addComponents(new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Salon d'attente")
      .setEmoji('🔊')
      .setURL(`https://discord.com/channels/${c.guildId}/${c.waitingChannelId}`));
  }
  const staffRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`convoc:close:${c.id}`).setLabel('Clore (staff)').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
  );

  return { content: `<@${c.userId}>`, embeds: [embed], components: [memberRow, staffRow], allowedMentions: { users: [c.userId] } };
}

function decisionRow(convocationId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`convoc:accept:${convocationId}`).setLabel('Accepter').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`convoc:refuse:${convocationId}`).setLabel('Refuser').setStyle(ButtonStyle.Danger).setEmoji('❌'),
  );
}

export async function createConvocation(params: {
  guildId: string;
  channel: TextChannel | NewsChannel;
  target: User;
  staff: User;
  reason: string;
  delayHours: number;
  expiryAction: ExpiryAction;
  waitingChannelId: string | null;
}): Promise<Convocation> {
  const conv = await prisma.convocation.create({
    data: {
      guildId: params.guildId,
      userId: params.target.id,
      staffId: params.staff.id,
      reason: params.reason,
      deadline: new Date(Date.now() + params.delayHours * 3_600_000),
      expiryAction: params.expiryAction,
      waitingChannelId: params.waitingChannelId,
      channelId: params.channel.id,
    },
  });

  try {
    const message = await params.channel.send({
      content: `<@${params.target.id}>`,
      embeds: [buildConvocationEmbed(conv, params.target.displayAvatarURL())],
      allowedMentions: { users: [params.target.id] },
    });
    await message.react(ACK_EMOJI).catch(() => null);

    const thread = await message.startThread({
      name: `${CONVOCATION_THREAD_PREFIX} ${params.target.username}`.slice(0, 100),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });
    await thread.members.add(params.target.id).catch(() => null);
    await thread.send(buildThreadIntro(conv));

    return await prisma.convocation.update({ where: { id: conv.id }, data: { messageId: message.id, threadId: thread.id } });
  } catch (err) {
    // Sans message ni fil, la convocation n'existe pas pour le membre : on ne
    // laisse pas une echeance courir contre lui.
    await prisma.convocation.delete({ where: { id: conv.id } }).catch(() => null);
    throw err;
  }
}

async function refreshConvocationMessage(conv: Convocation): Promise<void> {
  if (!conv.messageId) return;
  const channel = await getClient().channels.fetch(conv.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(conv.messageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [buildConvocationEmbed(conv, message.embeds[0]?.thumbnail?.url ?? null)] }).catch(() => null);
}

async function markAnswered(convocationId: string): Promise<void> {
  await prisma.convocation.updateMany({
    where: { id: convocationId, status: 'PENDING' },
    data: { status: 'ANSWERED', answeredAt: new Date() },
  });
}

export async function handleConvocationButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, id] = interaction.customId.split(':');
  const conv = interaction.guildId ? await prisma.convocation.findFirst({ where: { id, guildId: interaction.guildId } }) : null;
  if (!conv) {
    await interaction.reply({ content: '❌ Convocation introuvable.', flags: [MessageFlags.Ephemeral] });
    return;
  }
  if (conv.status === 'CLOSED') {
    await interaction.reply({ content: '🔒 Cette convocation est close.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  const isTarget = interaction.user.id === conv.userId;
  const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) ?? false;

  if (action === 'propose' || action === 'now') {
    if (!isTarget) {
      await interaction.reply({ content: '❌ Seul le membre convoqué peut utiliser ce bouton.', flags: [MessageFlags.Ephemeral] });
      return;
    }
    if (action === 'propose') {
      await interaction.showModal(new ModalBuilder()
        .setCustomId(`modal:convoc:propose:${conv.id}`)
        .setTitle('Proposer une date')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('slot')
            .setLabel('Jour et heure proposés')
            .setPlaceholder('Mercredi 28 octobre, 18 h')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(200)
            .setRequired(true),
        )));
      return;
    }
    await markAnswered(conv.id);
    await interaction.reply({
      content: `⚡ <@${conv.userId}> est **disponible maintenant**. <@${conv.staffId}>`,
      components: [decisionRow(conv.id)],
      allowedMentions: { users: [conv.staffId] },
    });
    return;
  }

  if (!isStaff) {
    await interaction.reply({ content: '❌ Réservé à la modération.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (action === 'accept' || action === 'refuse') {
    const verdict = action === 'accept'
      ? `✅ **Accepté** par <@${interaction.user.id}>.`
      : `❌ **Refusé** par <@${interaction.user.id}>.`;
    await interaction.update({ content: `${interaction.message.content}\n\n${verdict}`, components: [] });
    await interaction.followUp({
      content: action === 'accept'
        ? `<@${conv.userId}>, c'est d'accord.${conv.waitingChannelId ? ` Rejoins le salon d'attente : <#${conv.waitingChannelId}>.` : ''}`
        : `<@${conv.userId}>, ce créneau ne convient pas : propose-en un autre.`,
      allowedMentions: { users: [conv.userId] },
    });
    return;
  }

  if (action === 'close') {
    const closed = await prisma.convocation.update({ where: { id: conv.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    await interaction.reply({ content: `🔒 Convocation close par <@${interaction.user.id}>.`, allowedMentions: { parse: [] } });
    await refreshConvocationMessage(closed);
    if (interaction.channel?.isThread()) {
      await interaction.channel.setLocked(true).catch(() => null);
      await interaction.channel.setArchived(true).catch(() => null);
    }
  }
}

export async function handleConvocationModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId.split(':')[3];
  const conv = interaction.guildId ? await prisma.convocation.findFirst({ where: { id, guildId: interaction.guildId } }) : null;
  if (!conv || conv.status === 'CLOSED' || interaction.user.id !== conv.userId) {
    await interaction.reply({ content: '❌ Convocation introuvable ou close.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  await markAnswered(conv.id);
  const slot = interaction.fields.getTextInputValue('slot').trim();
  await interaction.reply({
    content: `🗓️ <@${conv.userId}> propose : **${slot}**\n<@${conv.staffId}>`,
    components: [decisionRow(conv.id)],
    allowedMentions: { users: [conv.staffId] },
  });
}

/** ✅ du membre convoque sous le message : accuse de reception. */
export async function handleConvocationReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (reaction.emoji.name !== ACK_EMOJI) return;
  const conv = await prisma.convocation.findFirst({
    where: { messageId: reaction.message.id, userId: user.id, acknowledgedAt: null },
  });
  if (!conv) return;

  const now = new Date();
  const updated = await prisma.convocation.update({
    where: { id: conv.id },
    data: { acknowledgedAt: now, ...(conv.status === 'PENDING' ? { status: 'ANSWERED', answeredAt: now } : {}) },
  });
  await refreshConvocationMessage(updated);
}

/** Message du membre dans son fil de convocation : il a repondu. */
export async function handleConvocationThreadMessage(message: Message): Promise<void> {
  // Le nom du fil filtre avant toute requete : la plupart des messages n'ont rien a voir.
  if (message.author.bot || !message.channel.isThread() || !message.channel.name.startsWith(CONVOCATION_THREAD_PREFIX)) return;
  await prisma.convocation.updateMany({
    where: { threadId: message.channelId, userId: message.author.id, status: 'PENDING' },
    data: { status: 'ANSWERED', answeredAt: new Date() },
  });
}

/** Echeances depassees sans aucune reponse, sur les serveurs tenus par ce processus. */
export async function processExpiredConvocations(): Promise<void> {
  const client = getClient();
  const due = await prisma.convocation.findMany({
    where: { status: 'PENDING', deadline: { lte: new Date() }, guildId: { in: [...client.guilds.cache.keys()] } },
    take: 50,
  });

  for (const conv of due) {
    // Reservation : un seul passage applique l'echeance, meme si deux balayages se croisent.
    const claimed = await prisma.convocation.updateMany({ where: { id: conv.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    if (claimed.count === 0) continue;
    await applyExpiry({ ...conv, status: 'EXPIRED' }).catch((err) =>
      logger.error('Convocation', `Échéance de la convocation ${conv.id} non appliquée`, err));
  }
}

async function applyExpiry(conv: Convocation): Promise<void> {
  const client = getClient();
  const thread = conv.threadId ? await client.channels.fetch(conv.threadId).catch(() => null) : null;
  const say = async (content: string) => {
    if (thread?.isSendable()) await thread.send({ content, allowedMentions: { users: [conv.staffId] } }).catch(() => null);
  };

  const [target, staff] = await Promise.all([
    client.users.fetch(conv.userId).catch(() => null),
    client.users.fetch(conv.staffId).catch(() => null),
  ]);
  const sanction = {
    guildId: conv.guildId,
    target: { id: conv.userId, tag: target?.tag ?? conv.userId },
    moderator: { id: conv.staffId, tag: staff?.tag ?? conv.staffId },
    reason: `Absence de réponse à la convocation : ${conv.reason}`.slice(0, 500),
    client,
  };

  if (conv.expiryAction === 'WARN') {
    await registerWarnSanction(sanction);
    await say(`⌛ Délai dépassé : un **avertissement** a été appliqué à <@${conv.userId}>. <@${conv.staffId}>`);
  } else if (conv.expiryAction === 'TIMEOUT') {
    const member = await client.guilds.cache.get(conv.guildId)?.members.fetch(conv.userId).catch(() => null);
    if (member) {
      await registerTimeoutSanction({ ...sanction, member, durationMs: EXPIRY_TIMEOUT_MS });
      await say(`⌛ Délai dépassé : <@${conv.userId}> est **exclu 24 h**. <@${conv.staffId}>`);
    } else {
      await say(`⌛ Délai dépassé, mais <@${conv.userId}> n'est plus sur le serveur : aucune exclusion appliquée. <@${conv.staffId}>`);
    }
  } else if (conv.expiryAction === 'NONE') {
    await say('⌛ Délai dépassé sans réponse.');
  } else {
    await say(`⌛ Délai dépassé : <@${conv.userId}> n'a pas répondu. <@${conv.staffId}>, à toi de décider de la suite.`);
  }

  await refreshConvocationMessage(conv);
}

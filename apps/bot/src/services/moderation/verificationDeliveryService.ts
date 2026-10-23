/**
 * verificationDeliveryService.ts
 *
 * Achemine le lien de vérification jusqu'au membre et tient le staff informé.
 *
 * Ordre de livraison :
 *  1. MP au membre.
 *  2. Si le MP échoue et que le membre est sur le serveur : thread privé dans le
 *     salon de repli (verificationFallbackChannelId, sinon verificationChannelId).
 *  3. Si aucun salon parent n'est configuré : ticket dédié (salon privé + entrée Ticket).
 *
 * Le staff est notifié quand un MP n'a pas pu être délivré, et à chaque
 * vérification terminée.
 */

import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type ActionRowBuilder,
  type ButtonBuilder,
  type Client,
  type GuildMember,
  type OverwriteResolvable,
  type TextChannel,
  type User,
} from 'discord.js';
import { VerificationFallbackKind, VerificationStatus } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { notifyMany } from '../notifications/notifyService.js';

const THREAD_AUTO_ARCHIVE_MINUTES = 10080; // 7 jours

export interface VerificationDeliveryResult {
  dmSent: boolean;
  fallbackKind: VerificationFallbackKind | null;
  fallbackChannelId: string | null;
  /** Raison lisible de l'absence de repli, à afficher au staff. */
  fallbackError: string | null;
}

interface DeliverVerificationParams {
  client: Client;
  guildId: string;
  user: User;
  /** null si le membre n'est pas (ou plus) sur le serveur - aucun repli possible. */
  member: GuildMember | null;
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
  /** Contexte affiché au staff et dans le thread de repli. */
  reason: string;
  /** Vérification à rattacher au salon de repli, pour le nettoyage ultérieur. */
  verificationId?: string | null;
}

/**
 * Envoie le lien de vérification au membre, avec repli en serveur si le MP échoue.
 * Ne jette jamais : un échec de livraison est signalé via le résultat retourné.
 */
export async function deliverVerification(
  params: DeliverVerificationParams,
): Promise<VerificationDeliveryResult> {
  const { client, guildId, user, member, embed, row, reason } = params;

  let dmSent = false;
  try {
    await user.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    dmSent = true;
  } catch {
    logger.warn('VerifDelivery', `MP de vérification non délivré à ${user.tag} (${user.id}) sur ${guildId}.`);
  }

  if (dmSent) {
    return { dmSent: true, fallbackKind: null, fallbackChannelId: null, fallbackError: null };
  }

  const fallback = member
    ? await createFallbackChannel({ client, guildId, member, embed, row, reason })
    : {
        fallbackKind: null,
        fallbackChannelId: null,
        fallbackError: "Le membre n'est pas sur le serveur : aucun salon de repli n'a pu être créé.",
      };

  if (params.verificationId && fallback.fallbackChannelId) {
    await prisma.securityVerification
      .update({
        where: { id: params.verificationId },
        data: {
          fallbackChannelId: fallback.fallbackChannelId,
          fallbackKind: fallback.fallbackKind,
        },
      })
      .catch((err) => {
        logger.warn('VerifDelivery', `Impossible d'enregistrer le salon de repli pour ${user.id}:`, err);
      });
  }

  await notifyStaffDmFailed({
    client,
    guildId,
    user,
    reason,
    fallbackKind: fallback.fallbackKind,
    fallbackChannelId: fallback.fallbackChannelId,
    fallbackError: fallback.fallbackError,
  });

  return { dmSent: false, ...fallback };
}

// ---------------------------------------------------------------------------

type FallbackOutcome = Omit<VerificationDeliveryResult, 'dmSent'>;

async function createFallbackChannel(params: {
  client: Client;
  guildId: string;
  member: GuildMember;
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
  reason: string;
}): Promise<FallbackOutcome> {
  const { guildId, member, embed, row, reason } = params;

  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      verificationFallbackChannelId: true,
      verificationChannelId: true,
      ticketCategoryId: true,
      ticketStaffRoleId: true,
      moderatorRoleId: true,
    },
  });

  const parentId = guildConfig?.verificationFallbackChannelId || guildConfig?.verificationChannelId || null;

  if (parentId) {
    const thread = await createFallbackThread({ member, parentId, embed, row, reason });
    if (thread) return thread;
    logger.warn(
      'VerifDelivery',
      `Thread de repli impossible dans ${parentId} pour ${member.user.tag} - bascule sur un ticket.`,
    );
  }

  return createFallbackTicket({
    member,
    embed,
    row,
    reason,
    categoryId: guildConfig?.ticketCategoryId || null,
    staffRoleId: guildConfig?.ticketStaffRoleId || null,
    moderatorRoleId: guildConfig?.moderatorRoleId || null,
  });
}

async function createFallbackThread(params: {
  member: GuildMember;
  parentId: string;
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
  reason: string;
}): Promise<FallbackOutcome | null> {
  const { member, parentId, embed, row, reason } = params;

  try {
    const parent = await member.guild.channels.fetch(parentId).catch(() => null);
    if (!parent || parent.type !== ChannelType.GuildText) return null;

    const thread = await parent.threads.create({
      name: `🔐 Vérification - ${member.user.username}`.slice(0, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
      reason: `Vérification de sécurité - MP fermés pour ${member.user.tag}`,
    });

    await thread.members.add(member.id).catch(() => null);
    await thread.send({
      content: `<@${member.id}> - tes MP sont fermés, voici ton lien de vérification.\n**Raison :** ${reason}`,
      embeds: [embed],
      components: [row],
      allowedMentions: { users: [member.id] },
    });

    logger.info('VerifDelivery', `Thread de vérification ${thread.id} créé pour ${member.user.tag}.`);
    return {
      fallbackKind: VerificationFallbackKind.THREAD,
      fallbackChannelId: thread.id,
      fallbackError: null,
    };
  } catch (err) {
    logger.warn('VerifDelivery', `Échec de création du thread de repli pour ${member.user.tag}:`, err);
    return null;
  }
}

async function createFallbackTicket(params: {
  member: GuildMember;
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
  reason: string;
  categoryId: string | null;
  staffRoleId: string | null;
  moderatorRoleId: string | null;
}): Promise<FallbackOutcome> {
  const { member, embed, row, reason, categoryId, staffRoleId, moderatorRoleId } = params;
  const guild = member.guild;

  try {
    const category = categoryId ? guild.channels.cache.get(categoryId) : null;

    const permissionOverwrites: OverwriteResolvable[] = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ];

    for (const roleId of [staffRoleId, moderatorRoleId]) {
      if (roleId && guild.roles.cache.has(roleId)) {
        permissionOverwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks,
          ],
        });
      }
    }

    const cleanedUsername = member.user.username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'membre';
    const channel = await guild.channels.create({
      name: `verif-${cleanedUsername}`.slice(0, 100),
      type: ChannelType.GuildText,
      parent: category && category.type === ChannelType.GuildCategory ? category.id : undefined,
      topic: `Vérification de sécurité de ${member.user.username} - MP fermés`,
      permissionOverwrites,
    });

    await prisma.ticket.create({
      data: {
        guildId: guild.id,
        channelId: channel.id,
        mode: 'CHANNEL',
        ticketTypeLabel: 'Vérification de sécurité',
        staffRoleId,
        categoryId: category?.id ?? null,
        userId: member.id,
        username: member.user.username,
        reason: 'Vérification de sécurité',
        description: reason,
        status: 'OPEN',
      },
    });

    await channel.send({
      content: `<@${member.id}> - tes MP sont fermés, voici ton lien de vérification.\n**Raison :** ${reason}`,
      embeds: [embed],
      components: [row],
      allowedMentions: { users: [member.id] },
    });

    logger.info('VerifDelivery', `Ticket de vérification ${channel.id} créé pour ${member.user.tag}.`);
    return {
      fallbackKind: VerificationFallbackKind.TICKET,
      fallbackChannelId: channel.id,
      fallbackError: null,
    };
  } catch (err) {
    logger.error('VerifDelivery', `Échec de création du ticket de repli pour ${member.user.tag}:`, err);
    return {
      fallbackKind: null,
      fallbackChannelId: null,
      fallbackError:
        "Aucun salon de repli n'a pu être créé (salon de vérification non configuré et création de ticket impossible).",
    };
  }
}

// ---------------------------------------------------------------------------

async function resolveStaffLogChannel(client: Client, guildId: string): Promise<TextChannel | null> {
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { verificationLogChannelId: true, logChannelId: true },
  });

  const channelId = guildConfig?.verificationLogChannelId || guildConfig?.logChannelId;
  if (!channelId) return null;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel && channel.type === ChannelType.GuildText ? channel : null;
}

async function notifyStaffDmFailed(params: {
  client: Client;
  guildId: string;
  user: User;
  reason: string;
  fallbackKind: VerificationFallbackKind | null;
  fallbackChannelId: string | null;
  fallbackError: string | null;
}): Promise<void> {
  const { client, guildId, user, reason, fallbackKind, fallbackChannelId, fallbackError } = params;

  const delivered = fallbackChannelId !== null;
  const location = !delivered
    ? `❌ ${fallbackError ?? 'Aucun repli disponible.'}`
    : fallbackKind === VerificationFallbackKind.THREAD
      ? `✅ Thread privé créé : <#${fallbackChannelId}>`
      : `✅ Ticket créé : <#${fallbackChannelId}>`;

  const embed = new EmbedBuilder()
    .setTitle(delivered ? '📪 MP fermés - lien envoyé en serveur' : '📪 MP fermés - lien non délivré')
    .setColor(delivered ? 0xffa500 : 0xed4245)
    .setDescription(
      `Le MP de vérification n'a pas pu être envoyé à <@${user.id}> (\`${user.id}\`).${
        delivered ? '' : "\n\n**Une action manuelle du staff est nécessaire.**"
      }`,
    )
    .addFields(
      { name: 'Membre', value: `${user.tag} (\`${user.id}\`)`, inline: true },
      { name: 'Raison', value: reason, inline: false },
      { name: 'Repli', value: location, inline: false },
    )
    .setTimestamp();

  const channel = await resolveStaffLogChannel(client, guildId);
  if (channel) {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  } else {
    logger.warn('VerifDelivery', `Aucun salon de log configuré pour ${guildId} - staff non notifié du MP échoué.`);
  }

  await notifyManagers(
    guildId,
    '📪 MP de vérification non délivré',
    delivered
      ? `Les MP de <@${user.id}> sont fermés. Le lien a été posté dans <#${fallbackChannelId}>.`
      : `Les MP de <@${user.id}> sont fermés et aucun salon de repli n'a pu être créé.`,
    delivered ? 'WARNING' : 'ERROR',
  );
}

/**
 * Notifie le staff qu'une vérification est terminée (réussie ou signalée).
 * Les alertes de double compte restent gérées séparément par notifyStaffOfDuplicate.
 */
export async function notifyStaffVerificationCompleted(params: {
  client: Client;
  guildId: string;
  userId: string;
  status: VerificationStatus;
  duplicateDetected: boolean;
  origin: string;
}): Promise<void> {
  const { client, guildId, userId, status, duplicateDetected, origin } = params;

  try {
    const flagged = duplicateDetected || status === VerificationStatus.FLAGGED;

    const embed = new EmbedBuilder()
      .setTitle(flagged ? '🔐 Vérification terminée - signalée' : '✅ Vérification terminée')
      .setColor(flagged ? 0xffa500 : 0x57f287)
      .setDescription(
        flagged
          ? `<@${userId}> a terminé sa vérification, mais un double compte potentiel a été détecté.`
          : `<@${userId}> a vérifié son identité avec succès.`,
      )
      .addFields(
        { name: 'Membre', value: `<@${userId}> (\`${userId}\`)`, inline: true },
        { name: 'Origine', value: origin, inline: true },
        { name: 'Statut', value: flagged ? '⚠️ Signalée' : '✅ Vérifiée', inline: true },
      )
      .setTimestamp();

    const channel = await resolveStaffLogChannel(client, guildId);
    if (channel) {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
    }
  } catch (err) {
    logger.error('VerifDelivery', `Erreur lors de la notification de vérification terminée pour ${userId}:`, err);
  }
}

/**
 * Archive et verrouille le salon de repli une fois la vérification terminée,
 * pour éviter que les threads/tickets de vérif ne s'accumulent.
 */
export async function closeFallbackChannel(params: {
  client: Client;
  guildId: string;
  fallbackChannelId: string | null;
  fallbackKind: VerificationFallbackKind | null;
}): Promise<void> {
  const { client, guildId, fallbackChannelId, fallbackKind } = params;
  if (!fallbackChannelId) return;

  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const channel = await guild.channels.fetch(fallbackChannelId).catch(() => null);
    if (!channel) return;

    if (channel.isThread()) {
      await channel.send({ content: '✅ Vérification terminée - ce thread est archivé.' }).catch(() => null);
      await channel.setLocked(true).catch(() => null);
      await channel.setArchived(true).catch(() => null);
      return;
    }

    if (fallbackKind === VerificationFallbackKind.TICKET && channel.type === ChannelType.GuildText) {
      await channel
        .send({ content: '✅ Vérification terminée - ce ticket peut être fermé.' })
        .catch(() => null);
      await prisma.ticket
        .updateMany({
          where: { guildId, channelId: fallbackChannelId, status: 'OPEN' },
          data: { status: 'CLOSED', closedAt: new Date(), closedByName: 'Kotbo (vérification terminée)' },
        })
        .catch(() => null);
    }
  } catch (err) {
    logger.warn('VerifDelivery', `Impossible de clôturer le salon de repli ${fallbackChannelId}:`, err);
  }
}

async function notifyManagers(
  guildId: string,
  title: string,
  message: string,
  type: 'WARNING' | 'ERROR',
): Promise<void> {
  const managers = await prisma.staffMember
    .findMany({
      where: {
        guildId,
        grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction'] },
      },
    })
    .catch(() => []);

  await notifyMany(managers.map((m) => m.userId), {
    guildId,
    kind: 'security.verification_undelivered',
    title,
    message,
    severity: type,
    link: '/double-accounts',
    dm: false,
  });
}

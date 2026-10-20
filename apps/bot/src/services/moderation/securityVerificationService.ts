import {
  type Client,
  type GuildMember,
  type Interaction,
  type TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import crypto from 'node:crypto';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { LinkedAccountType, LinkedAccountStatus, VerificationStatus, VerificationLevel } from '@prisma/client';
import * as altAccountService from './altAccountService.js';
import { notifyMany } from '../notifications/notifyService.js';
import {
  closeFallbackChannel,
  deliverVerification,
  notifyStaffVerificationCompleted,
  type VerificationDeliveryResult,
} from './verificationDeliveryService.js';

const VERIFICATION_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h

export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Crée la session et renvoie l'enregistrement complet (id nécessaire pour le repli). */
export async function createVerificationSessionRecord(
  guildId: string,
  userId: string,
  level: VerificationLevel = VerificationLevel.HIGH,
  appealId?: string | null
) {
  await prisma.securityVerification.updateMany({
    where: { guildId, userId, status: VerificationStatus.PENDING },
    data: { status: VerificationStatus.EXPIRED },
  });

  return prisma.securityVerification.create({
    data: {
      guildId,
      userId,
      token: generateVerificationToken(),
      level,
      appealId: appealId || null,
      status: VerificationStatus.PENDING,
      expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MS),
    },
  });
}

export async function createVerificationSession(
  guildId: string,
  userId: string,
  level: VerificationLevel = VerificationLevel.HIGH,
  appealId?: string | null
): Promise<string> {
  const verification = await createVerificationSessionRecord(guildId, userId, level, appealId);
  return verification.token;
}

export async function getVerificationByToken(token: string) {
  const verification = await prisma.securityVerification.findUnique({
    where: { token },
  });

  if (!verification) return null;
  if (verification.expiresAt < new Date()) {
    await prisma.securityVerification.update({
      where: { id: verification.id },
      data: { status: VerificationStatus.EXPIRED },
    });
    return null;
  }
  if (verification.status !== VerificationStatus.PENDING) return null;

  return verification;
}

export function buildVerificationUrl(dashboardUrl: string, guildId: string, token: string): string {
  return `${dashboardUrl}/verify/${guildId}/${token}`;
}

/**
 * Délai minimal entre deux demandes de vérification sur le même membre.
 *
 * Chaque demande coupe la parole au membre (timeout de 28 jours) et lui envoie
 * un MP : la relancer en boucle le harcèle sans rien apprendre au staff. Une
 * heure laisse le temps de voir la demande précédente aboutir.
 */
export const VERIFICATION_REQUEST_COOLDOWN_MS = 60 * 60 * 1000;

/** Nombre de demandes remontées dans la fiche membre. */
const VERIFICATION_HISTORY_LIMIT = 10;

export type VerificationHistory = {
  entries: Array<{
    id: string;
    status: VerificationStatus;
    level: VerificationLevel;
    requestedAt: Date;
    verifiedAt: Date | null;
    expiresAt: Date | null;
  }>;
  total: number;
  lastRequestedAt: Date | null;
  lastVerifiedAt: Date | null;
  hasPending: boolean;
  cooldownUntil: Date | null;
};

/**
 * Historique des vérifications d'un membre, plus l'état anti-spam associé.
 *
 * Sert à la fois à l'affichage dans la fiche membre et au garde-fou côté API :
 * les deux doivent lire la même règle pour que le bouton grisé et le refus
 * serveur ne se contredisent jamais.
 */
export async function getVerificationHistory(
  guildId: string,
  userId: string,
): Promise<VerificationHistory> {
  const [rows, total] = await Promise.all([
    prisma.securityVerification.findMany({
      where: { guildId, userId },
      orderBy: { createdAt: 'desc' },
      take: VERIFICATION_HISTORY_LIMIT,
      select: {
        id: true,
        status: true,
        level: true,
        createdAt: true,
        verifiedAt: true,
        expiresAt: true,
      },
    }),
    prisma.securityVerification.count({ where: { guildId, userId } }),
  ]);

  const entries = rows.map((row) => ({
    id: row.id,
    status: row.status,
    level: row.level,
    requestedAt: row.createdAt,
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
  }));

  const lastRequestedAt = entries[0]?.requestedAt ?? null;
  const lastVerifiedAt = entries.find((entry) => entry.verifiedAt)?.verifiedAt ?? null;
  // Une session encore valide est toujours actionnable par le membre : inutile
  // d'en créer une seconde, elle invaliderait la première.
  const now = Date.now();
  const hasPending = entries.some(
    (entry) => entry.status === VerificationStatus.PENDING
      && (entry.expiresAt?.getTime() ?? 0) > now,
  );

  const cooldownEnd = lastRequestedAt
    ? new Date(lastRequestedAt.getTime() + VERIFICATION_REQUEST_COOLDOWN_MS)
    : null;

  return {
    entries,
    total,
    lastRequestedAt,
    lastVerifiedAt,
    hasPending,
    cooldownUntil: cooldownEnd && cooldownEnd.getTime() > now ? cooldownEnd : null,
  };
}

export function buildVerificationEmbed(
  guildName: string,
  title: string,
  description: string,
  color: string,
  verifyUrl: string,
): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(parseInt(color.replace('#', ''), 16))
    .addFields({
      name: '🔒 Pourquoi vérifier ?',
      value: 'Ce système protège la communauté contre les doubles comptes. La vérification est rapide et sécurisée via Discord OAuth.',
    })
    .setFooter({ text: `${guildName} • Vérification de sécurité` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Vérifier mon identité')
      .setStyle(ButtonStyle.Link)
      .setURL(verifyUrl)
      .setEmoji('🔐'),
  );

  return { embed, row };
}

/**
 * Envoie le lien de vérification à un membre qui vient de rejoindre.
 * Si ses MP sont fermés, le lien est déposé dans un thread privé (ou un ticket)
 * et le staff est notifié - voir verificationDeliveryService.
 */
export async function sendVerificationDM(
  member: GuildMember,
  dashboardUrl: string,
): Promise<VerificationDeliveryResult | null> {
  const guild = member.guild;
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: {
      verificationEnabled: true,
      verificationEmbedTitle: true,
      verificationEmbedDesc: true,
      verificationEmbedColor: true,
      verificationLevelJoin: true,
    },
  });

  if (!guildConfig?.verificationEnabled) return null;

  const verification = await createVerificationSessionRecord(
    guild.id,
    member.id,
    guildConfig.verificationLevelJoin || VerificationLevel.HIGH
  );
  const verifyUrl = buildVerificationUrl(dashboardUrl, guild.id, verification.token);
  const { embed, row } = buildVerificationEmbed(
    guild.name,
    guildConfig.verificationEmbedTitle,
    guildConfig.verificationEmbedDesc,
    guildConfig.verificationEmbedColor,
    verifyUrl,
  );

  const result = await deliverVerification({
    client: member.client,
    guildId: guild.id,
    user: member.user,
    member,
    embed,
    row,
    reason: 'Vérification automatique à l’arrivée sur le serveur.',
    verificationId: verification.id,
  });

  if (result.dmSent) {
    logger.info('SecurityVerif', `DM de vérification envoyé à ${member.user.tag} sur ${guild.name}`);
  }

  return result;
}

export async function sendVerificationEmbed(
  client: Client,
  guildId: string,
  channelId: string,
  _dashboardUrl: string,
): Promise<boolean> {
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      verificationEmbedTitle: true,
      verificationEmbedDesc: true,
      verificationEmbedColor: true,
    },
  });

  if (!guildConfig) return false;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return false;

  const channel = await guild.channels.fetch(channelId).catch(() => null) as TextChannel | null;
  if (!channel) return false;

  const embed = new EmbedBuilder()
    .setTitle(guildConfig.verificationEmbedTitle)
    .setDescription(guildConfig.verificationEmbedDesc)
    .setColor(parseInt(guildConfig.verificationEmbedColor.replace('#', ''), 16))
    .addFields({
      name: '🔒 Pourquoi vérifier ?',
      value: 'Ce système protège la communauté contre les doubles comptes. Cliquez sur le bouton ci-dessous pour lancer la vérification.',
    })
    .setFooter({ text: `${guild.name} • Vérification de sécurité` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`secverif_start_${guildId}`)
      .setLabel('Vérifier mon identité')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔐'),
  );

  await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  return true;
}

export async function handleVerifyButtonClick(
  interaction: any,
  dashboardUrl: string,
): Promise<void> {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      verificationLevelCommand: true,
    },
  });

  const existing = await prisma.securityVerification.findFirst({
    where: {
      guildId,
      userId,
      status: VerificationStatus.PENDING,
      expiresAt: { gt: new Date() },
    },
  });

  let token: string;
  if (existing) {
    token = existing.token;
  } else {
    token = await createVerificationSession(
      guildId,
      userId,
      guildConfig?.verificationLevelCommand || VerificationLevel.HIGH
    );
  }

  const verifyUrl = buildVerificationUrl(dashboardUrl, guildId, token);

  const embed = new EmbedBuilder()
    .setTitle('🔐 Vérification de sécurité')
    .setDescription('Cliquez sur le lien ci-dessous pour vérifier votre identité. Le lien expire dans 24 heures.')
    .setColor(0x5865F2)
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Ouvrir la vérification')
      .setStyle(ButtonStyle.Link)
      .setURL(verifyUrl)
      .setEmoji('🔗'),
  );

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

export async function completeVerification(params: {
  token: string;
  verifiedDiscordId: string;
  ipAddress: string;
  dashboardUrl: string;
  client: Client;
  email?: string | null;
  connections?: any;
  guilds?: any;
  userFetched?: any;
  clientInfo?: any;
}): Promise<{ success: boolean; message: string; duplicateDetected: boolean; duplicateUserId?: string; inviteUrl?: string | null }> {
  const { token, verifiedDiscordId, ipAddress, client } = params;

  const verification = await getVerificationByToken(token);
  if (!verification) {
    return { success: false, message: 'Token invalide ou expiré.', duplicateDetected: false };
  }

  const guildConfig = await prisma.guild.findUnique({
    where: { id: verification.guildId },
    select: {
      verificationAction: true,
      verificationLogChannelId: true,
      logChannelId: true,
      verificationRoleId: true,
      verificationSaveIp: true,
      verificationSaveDevice: true,
    },
  });

  let saveIp = guildConfig?.verificationSaveIp ?? true;
  let saveDevice = guildConfig?.verificationSaveDevice ?? true;
  if (verification.appealId) {
    const appealConfig = await prisma.banAppealConfig.findUnique({
      where: { guildId: verification.guildId },
      select: { appealSaveIp: true, appealSaveDevice: true },
    });
    saveIp = appealConfig?.appealSaveIp ?? true;
    saveDevice = appealConfig?.appealSaveDevice ?? true;
  }
  const ipToStore = saveIp ? ipAddress : null;
  const deviceToStore = saveDevice ? (params.clientInfo || null) : null;

  if (verification.userId !== verifiedDiscordId) {
    const evidence = {
      expectedUserId: verification.userId,
      authenticatedUserId: verifiedDiscordId,
      ipAddress: ipToStore,
      deviceInfo: deviceToStore,
      detectedAt: new Date().toISOString(),
      method: 'oauth_mismatch',
    };

    await prisma.securityVerification.update({
      where: { id: verification.id },
      data: {
        status: VerificationStatus.FLAGGED,
        verifiedDiscordId,
        ipAddress: ipToStore,
        deviceInfo: deviceToStore || undefined,
        verifiedAt: new Date(),
        duplicateDetected: true,
        duplicateUserId: verifiedDiscordId,
        duplicateEvidence: evidence,
        email: params.email,
        connections: params.connections ? JSON.parse(JSON.stringify(params.connections)) : undefined,
        guilds: params.guilds ? JSON.parse(JSON.stringify(params.guilds)) : undefined,
        userFetched: params.userFetched ? JSON.parse(JSON.stringify(params.userFetched)) : undefined,
      },
    });

    const action = guildConfig?.verificationAction || 'NOTIFY_STAFF';

    if (action === 'AUTO_LINK') {
      await altAccountService.linkAccounts({
        guildId: verification.guildId,
        user1Id: verification.userId,
        user2Id: verifiedDiscordId,
        type: LinkedAccountType.AUTOMATIC,
        status: LinkedAccountStatus.VALIDATED,
        reason: 'Détecté automatiquement via vérification de sécurité (OAuth mismatch).',
        metadata: evidence,
      });

      await notifyStaffOfDuplicate(client, verification.guildId, verification.userId, verifiedDiscordId, evidence, guildConfig?.verificationLogChannelId || guildConfig?.logChannelId, true);

      return {
        success: true,
        message: 'Double compte détecté et lié automatiquement.',
        duplicateDetected: true,
        duplicateUserId: verifiedDiscordId,
      };
    } else {
      await notifyStaffOfDuplicate(client, verification.guildId, verification.userId, verifiedDiscordId, evidence, guildConfig?.verificationLogChannelId || guildConfig?.logChannelId, false);

      return {
        success: true,
        message: 'Double compte détecté. Les modérateurs ont été notifiés.',
        duplicateDetected: true,
        duplicateUserId: verifiedDiscordId,
      };
    }
  }

  // Same user - check IP for other verifications on the same guild (only if IP saving is enabled)
  const sameIpVerifications = ipToStore ? await prisma.securityVerification.findMany({
    where: {
      guildId: verification.guildId,
      ipAddress: ipToStore,
      userId: { not: verifiedDiscordId },
      status: { in: [VerificationStatus.VERIFIED, VerificationStatus.FLAGGED] },
    },
    take: 5,
  }) : [];

  const sameDeviceVerifications = deviceToStore ? await prisma.securityVerification.findMany({
    where: {
      guildId: verification.guildId,
      deviceInfo: { equals: deviceToStore },
      userId: { not: verifiedDiscordId },
      status: { in: [VerificationStatus.VERIFIED, VerificationStatus.FLAGGED] },
    },
    take: 5,
  }) : [];

  let duplicateDetected = false;
  let duplicateUserId: string | undefined;
  let evidence: any = null;

  if (sameIpVerifications.length > 0) {
    duplicateDetected = true;
    duplicateUserId = sameIpVerifications[0].userId;

    evidence = {
      sharedIp: ipToStore,
      matchedUserIds: sameIpVerifications.map(v => v.userId),
      detectedAt: new Date().toISOString(),
      method: 'ip_match',
    };
  } else if (sameDeviceVerifications.length > 0) {
    duplicateDetected = true;
    duplicateUserId = sameDeviceVerifications[0].userId;

    evidence = {
      sharedDevice: deviceToStore,
      matchedUserIds: sameDeviceVerifications.map(v => v.userId),
      detectedAt: new Date().toISOString(),
      method: 'device_match',
    };
  }

  if (duplicateDetected && duplicateUserId && evidence) {
    const action = guildConfig?.verificationAction || 'NOTIFY_STAFF';

    if (action === 'AUTO_LINK') {
      await altAccountService.linkAccounts({
        guildId: verification.guildId,
        user1Id: verifiedDiscordId,
        user2Id: duplicateUserId,
        type: LinkedAccountType.AUTOMATIC,
        status: LinkedAccountStatus.VALIDATED,
        reason: `Détecté automatiquement via vérification de sécurité (${evidence.method === 'ip_match' ? 'même IP' : 'même appareil/navigateur'}).`,
        metadata: evidence,
      });
    }

    await notifyStaffOfDuplicate(
      client,
      verification.guildId,
      verifiedDiscordId,
      duplicateUserId,
      evidence,
      guildConfig?.verificationLogChannelId || guildConfig?.logChannelId,
      action === 'AUTO_LINK',
    );

    await prisma.securityVerification.update({
      where: { id: verification.id },
      data: {
        status: VerificationStatus.FLAGGED,
        verifiedDiscordId,
        ipAddress: ipToStore,
        deviceInfo: deviceToStore || undefined,
        verifiedAt: new Date(),
        duplicateDetected: true,
        duplicateUserId,
        duplicateEvidence: evidence,
        email: params.email,
        connections: params.connections ? JSON.parse(JSON.stringify(params.connections)) : undefined,
        guilds: params.guilds ? JSON.parse(JSON.stringify(params.guilds)) : undefined,
        userFetched: params.userFetched ? JSON.parse(JSON.stringify(params.userFetched)) : undefined,
      },
    });
  } else {
    await prisma.securityVerification.update({
      where: { id: verification.id },
      data: {
        status: VerificationStatus.VERIFIED,
        verifiedDiscordId,
        ipAddress: ipToStore,
        deviceInfo: deviceToStore || undefined,
        verifiedAt: new Date(),
        email: params.email,
        connections: params.connections ? JSON.parse(JSON.stringify(params.connections)) : undefined,
        guilds: params.guilds ? JSON.parse(JSON.stringify(params.guilds)) : undefined,
        userFetched: params.userFetched ? JSON.parse(JSON.stringify(params.userFetched)) : undefined,
      },
    });
  }

  // Grant role & remove timeout if applicable
  let inviteUrl: string | null = null;
  try {
    const guild = await client.guilds.fetch(verification.guildId).catch(() => null);
    if (guild) {
      if (verification.appealId && !duplicateDetected) {
        await guild.members.unban(verification.userId, 'Appel accepté et identité vérifiée via OAuth.').catch((err) => {
          logger.error('SecurityVerif', `Failed to unban ${verification.userId} after verification:`, err);
        });

        const appeal = await prisma.banAppeal.findUnique({
          where: { id: verification.appealId },
        });

        const appealConfig = await prisma.banAppealConfig.findUnique({
          where: { guildId: verification.guildId },
        });

        const { createReturnInvite } = await import('./banAppealService.js');
        inviteUrl = await createReturnInvite(client, verification.guildId, appealConfig?.inviteChannelId);

        const serverName = guild.name || 'le serveur';
        const defaultAcceptMsg = 'Félicitations ! Ton identité a été vérifiée avec succès. Tu peux rejoindre le serveur à nouveau en utilisant ce lien : {invite}';
        const acceptTemplate = appealConfig?.acceptMessage || defaultAcceptMsg;
        const { renderTemplate, sendMemberDM } = await import('./banAppealService.js');
        const dmMsg = renderTemplate(acceptTemplate, {
          server: serverName,
          invite: inviteUrl || '(invitation indisponible)',
          reason: appeal?.decisionReason || '',
        });
        await sendMemberDM(client, verification.userId, dmMsg);
      }

      const member = await guild.members.fetch(verifiedDiscordId).catch(() => null);
      if (member) {
        // Remove Timeout
        if (member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
          await member.timeout(null, 'Vérification de sécurité réussie (OAuth)').catch(() => null);
          logger.info('SecurityVerif', `Timeout retiré pour ${verifiedDiscordId} après vérification.`);
        }

        // Grant role
        if (guildConfig?.verificationRoleId && !duplicateDetected) {
          await member.roles.add(guildConfig.verificationRoleId).catch(() => null);
        }
      }
    }
  } catch (err) {
    logger.warn('SecurityVerif', `Impossible d'ajuster les rôles/timeout/débannissement pour ${verifiedDiscordId}:`, err);
  }

  // Le lien avait été déposé en serveur (MP fermés) : on referme le salon de repli.
  await closeFallbackChannel({
    client,
    guildId: verification.guildId,
    fallbackChannelId: verification.fallbackChannelId,
    fallbackKind: verification.fallbackKind,
  });

  await notifyStaffVerificationCompleted({
    client,
    guildId: verification.guildId,
    userId: verifiedDiscordId,
    status: duplicateDetected ? VerificationStatus.FLAGGED : VerificationStatus.VERIFIED,
    duplicateDetected,
    origin: verification.appealId ? "Appel de bannissement" : 'Vérification de sécurité',
  });

  return {
    success: true,
    message: duplicateDetected
      ? 'Vérification terminée. Un double compte potentiel a été détecté.'
      : (verification.appealId ? 'Vérification réussie ! Vous avez été débanni.' : 'Vérification réussie ! Votre identité a été confirmée.'),
    duplicateDetected,
    duplicateUserId,
    inviteUrl,
  };
}

async function notifyStaffOfDuplicate(
  client: Client,
  guildId: string,
  userId1: string,
  userId2: string,
  evidence: Record<string, unknown>,
  logChannelId: string | null | undefined,
  autoLinked: boolean,
): Promise<void> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const method = evidence.method === 'oauth_mismatch'
    ? "L'utilisateur s'est authentifié avec un compte Discord différent de celui attendu."
    : evidence.method === 'device_match'
      ? 'Les deux comptes partagent le même appareil ou navigateur.'
      : 'Les deux comptes partagent la même adresse IP.';

  const embed = new EmbedBuilder()
    .setTitle(autoLinked ? '🔗 Double compte détecté et lié' : '⚠️ Double compte potentiel détecté')
    .setColor(autoLinked ? 0x57F287 : 0xFFA500)
    .setDescription(`Un double compte a été détecté via la vérification de sécurité.`)
    .addFields(
      { name: 'Compte 1', value: `<@${userId1}> (\`${userId1}\`)`, inline: true },
      { name: 'Compte 2', value: `<@${userId2}> (\`${userId2}\`)`, inline: true },
      { name: 'Méthode de détection', value: method },
      { name: 'Statut', value: autoLinked ? '✅ Comptes liés automatiquement' : '⏳ En attente de validation par le staff' },
    )
    .setTimestamp();

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (!autoLinked) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`secverif_validate:${userId1}:${userId2}`)
          .setLabel('Valider la liaison')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`secverif_reject:${userId1}:${userId2}`)
          .setLabel('Faux positif')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('❌'),
      ),
    );
  }

  const targetChannelId = logChannelId;
  if (targetChannelId) {
    const channel = await guild.channels.fetch(targetChannelId).catch(() => null) as TextChannel | null;
    if (channel) {
      await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } }).catch(() => null);
    }
  }

  // Notify managers via dashboard notifications
  const managers = await prisma.staffMember.findMany({
    where: {
      guildId,
      grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction'] },
    },
  });

  await notifyMany(managers.map(m => m.userId), {
    guildId,
    kind: 'security.alt_detected',
    title: autoLinked ? '🔗 DC détecté et lié' : '⚠️ DC potentiel détecté',
    message: `Double compte détecté : <@${userId1}> ↔ <@${userId2}> (${evidence.method === 'oauth_mismatch' ? 'OAuth mismatch' : evidence.method === 'device_match' ? 'même appareil' : 'même IP'}).`,
    severity: autoLinked ? 'SUCCESS' : 'WARNING',
    link: '/double-accounts',
    groupKey: 'security.alt_detected',
    dm: false,
  });
}

export async function handleVerificationStaffAction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const parts = interaction.customId.split(':');
  const action = parts[0];
  const userId1 = parts[1];
  const userId2 = parts[2];

  if (action === 'secverif_validate') {
    await altAccountService.linkAccounts({
      guildId: interaction.guildId!,
      user1Id: userId1,
      user2Id: userId2,
      type: LinkedAccountType.AUTOMATIC,
      status: LinkedAccountStatus.VALIDATED,
      reason: 'Validé par le staff via vérification de sécurité.',
      linkedByUserId: interaction.user.id,
    });

    await interaction.update({
      content: `✅ Comptes <@${userId1}> et <@${userId2}> liés par <@${interaction.user.id}>.`,
      embeds: [],
      components: [],
    });
  } else if (action === 'secverif_reject') {
    // Mark the verification as not a duplicate
    await prisma.securityVerification.updateMany({
      where: {
        guildId: interaction.guildId!,
        userId: userId1,
        duplicateUserId: userId2,
        status: VerificationStatus.FLAGGED,
      },
      data: {
        status: VerificationStatus.VERIFIED,
        duplicateDetected: false,
        duplicateUserId: null,
      },
    });

    // Grant verification role since it was a false positive
    const guildConfig = await prisma.guild.findUnique({
      where: { id: interaction.guildId! },
      select: { verificationRoleId: true },
    });

    if (guildConfig?.verificationRoleId) {
      const guild = interaction.guild;
      if (guild) {
        const member = await guild.members.fetch(userId1).catch(() => null);
        if (member) {
          await member.roles.add(guildConfig.verificationRoleId).catch(() => null);
        }
      }
    }

    await interaction.update({
      content: `⚠️ Faux positif confirmé par <@${interaction.user.id}>. Alerte ignorée.`,
      embeds: [],
      components: [],
    });
  }
}

export async function cleanupExpiredVerifications(): Promise<number> {
  const result = await prisma.securityVerification.updateMany({
    where: {
      status: VerificationStatus.PENDING,
      expiresAt: { lt: new Date() },
    },
    data: { status: VerificationStatus.EXPIRED },
  });
  return result.count;
}

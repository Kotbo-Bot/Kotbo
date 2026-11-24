/**
 * verificationWarnThresholdService.ts
 *
 * Vérifie si un membre a atteint le seuil configurable d'avertissements (warns)
 * et déclenche automatiquement une vérification de sécurité si tel est le cas.
 *
 * Modes :
 *  - FULL_AUTO   : timeout 28j + DM de vérification envoyé immédiatement
 *  - NOTIFY_STAFF: un embed est posté dans le canal de log pour prévenir le staff
 */

import type { Client, GuildMember, User } from 'discord.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { VerificationStatus } from '@prisma/client';
import {
  createVerificationSessionRecord,
  buildVerificationUrl,
  buildVerificationEmbed,
} from './securityVerificationService.js';
import { deliverVerification } from './verificationDeliveryService.js';
import { getWarnScore } from './sanctionService.js';
import { queueAuditLog } from '../../utils/auditLogger.js';
import { getDashboardUrl } from '../../api/shared.js';
import { resolveEventLogChannel } from '../../utils/logDispatch.js';

const TIMEOUT_DURATION_MS = 28 * 24 * 60 * 60 * 1000; // 28 jours (max Discord)

/**
 * Appelé après chaque warn enregistré.
 * Si le seuil est atteint et qu'aucune vérification n'est déjà en cours, déclenche la vérif.
 */
export async function checkAndTriggerVerificationThreshold(params: {
  client: Client;
  guildId: string;
  targetUser: User;
  targetMember: GuildMember | null;
}): Promise<void> {
  const { client, guildId, targetUser, targetMember } = params;

  try {
    const guildConfig = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        verificationEnabled: true,
        verificationWarnThreshold: true,
        verificationWarnAutoMode: true,
        verificationWarnReason: true,
        verificationEmbedTitle: true,
        verificationEmbedDesc: true,
        verificationEmbedColor: true,
        verificationLogChannelId: true,
        logChannelId: true,
        verificationLevelCommand: true,
      },
    });

    // Fonctionnalité désactivée si : vérif globale off, ou seuil non configuré
    if (!guildConfig?.verificationEnabled || !guildConfig.verificationWarnThreshold) return;

    const threshold = guildConfig.verificationWarnThreshold;

    // Score de warns (pondéré si warnWeightingEnabled, sinon compte brut)
    const warnCount = await getWarnScore(guildId, targetUser.id);
    if (warnCount < threshold) return;

    // Ne pas relancer si une vérification PENDING existe déjà
    const existing = await prisma.securityVerification.findFirst({
      where: {
        guildId,
        userId: targetUser.id,
        status: VerificationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
    });
    if (existing) {
      logger.debug(
        'VerifThreshold',
        `Vérification déjà en cours pour ${targetUser.tag} sur ${guildId} - pas de double déclenchement.`,
      );
      return;
    }

    const autoMode = guildConfig.verificationWarnAutoMode;
    const reason =
      guildConfig.verificationWarnReason ||
      `Seuil de ${threshold} avertissements atteint - vérification de sécurité requise.`;

    logger.info(
      'VerifThreshold',
      `Seuil de warns atteint (${warnCount}/${threshold}) pour ${targetUser.tag} sur ${guildId}. Mode: ${autoMode}`,
    );

    if (autoMode === 'FULL_AUTO') {
      await triggerFullAuto({ client, guildId, targetUser, targetMember, guildConfig, reason, threshold });
    } else {
      await triggerNotifyStaff({ client, guildId, targetUser, guildConfig, reason, threshold, warnCount });
    }
  } catch (err) {
    logger.error('VerifThreshold', `Erreur lors de la vérification du seuil de warns pour ${targetUser.tag}:`, err);
  }
}

// ---------------------------------------------------------------------------

async function triggerFullAuto(params: {
  client: Client;
  guildId: string;
  targetUser: User;
  targetMember: GuildMember | null;
  guildConfig: {
    verificationEmbedTitle: string;
    verificationEmbedDesc: string;
    verificationEmbedColor: string;
    verificationLevelCommand: string;
  };
  reason: string;
  threshold: number;
}): Promise<void> {
  const { client, guildId, targetUser, targetMember, guildConfig, reason, threshold } = params;

  // 1. Créer la session de vérification
  const dashboardUrl = getDashboardUrl();
  const verification = await createVerificationSessionRecord(
    guildId,
    targetUser.id,
    (guildConfig.verificationLevelCommand as any) || 'HIGH',
  );
  const verifyUrl = buildVerificationUrl(dashboardUrl, guildId, verification.token);

  // 2. Appliquer le timeout (28j)
  let timeoutSuccess = false;
  if (targetMember && targetMember.moderatable) {
    await targetMember
      .timeout(
        TIMEOUT_DURATION_MS,
        `Seuil de ${threshold} avertissements atteint - vérification de sécurité automatique.`,
      )
      .then(() => {
        timeoutSuccess = true;
      })
      .catch((err) => {
        logger.warn('VerifThreshold', `Impossible d'appliquer le timeout à ${targetUser.tag}:`, err);
      });
  }

  // 3. Envoyer le DM
  const { embed, row } = buildVerificationEmbed(
    targetMember?.guild.name ?? 'Serveur',
    guildConfig.verificationEmbedTitle,
    guildConfig.verificationEmbedDesc,
    guildConfig.verificationEmbedColor,
    verifyUrl,
  );

  // Ajouter le contexte de la raison dans le DM
  const dmEmbed = embed.addFields({
    name: '⚠️ Raison',
    value: reason,
    inline: false,
  });

  // Repli automatique (thread privé ou ticket) si les MP sont fermés + notification staff.
  const { dmSent, fallbackChannelId, fallbackKind } = await deliverVerification({
    client,
    guildId,
    user: targetUser,
    member: targetMember,
    embed: dmEmbed,
    row,
    reason,
    verificationId: verification.id,
  });

  // 4. Audit log
  const deliveryDetail = dmSent
    ? 'DM: Oui.'
    : fallbackChannelId
      ? `DM: Non (MP fermés). Repli: ${fallbackKind === 'THREAD' ? 'thread privé' : 'ticket'} <#${fallbackChannelId}>.`
      : 'DM: Non (MP fermés). Repli: aucun (échec de création).';

  queueAuditLog({
    guildId,
    user: 'Bot (automatique)',
    action: 'Vérification de sécurité auto (seuil warns)',
    context: `${targetUser.tag} (${targetUser.id})`,
    module: 'Vérification',
    eventType: 'Automatique',
    details: `Seuil atteint. Timeout: ${timeoutSuccess ? 'Oui' : 'Non'}. ${deliveryDetail}`,
  });

  logger.info(
    'VerifThreshold',
    `FULL_AUTO déclenché pour ${targetUser.tag}. Timeout: ${timeoutSuccess}, DM: ${dmSent}, repli: ${fallbackChannelId ?? 'aucun'}.`,
  );
}

// ---------------------------------------------------------------------------

async function triggerNotifyStaff(params: {
  client: Client;
  guildId: string;
  targetUser: User;
  guildConfig: {
    verificationLogChannelId: string | null;
    logChannelId: string | null;
  };
  reason: string;
  threshold: number;
  warnCount: number;
}): Promise<void> {
  const { client, guildId, targetUser, guildConfig, reason, threshold, warnCount } = params;

  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const channel = await resolveEventLogChannel(guild, 'verification_warn_threshold', 'VerifThreshold', {
      moduleChannelId: guildConfig.verificationLogChannelId,
    });
    if (!channel) {
      logger.warn(
        'VerifThreshold',
        `NOTIFY_STAFF: aucun salon de log utilisable (ou type désactivé) pour ${guildId}. Impossible de notifier le staff.`,
      );
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle('⚠️ Seuil d\'avertissements atteint')
      .setDescription(
        `<@${targetUser.id}> a atteint **${warnCount}** avertissements (seuil : **${threshold}**).\nUne vérification de sécurité peut être requise.`,
      )
      .addFields(
        { name: 'Membre', value: `${targetUser.tag} (\`${targetUser.id}\`)`, inline: true },
        { name: 'Nombre de warns', value: `${warnCount} / ${threshold}`, inline: true },
        { name: 'Raison automatique', value: reason, inline: false },
      )
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`verif_threshold_trigger:${targetUser.id}`)
        .setLabel('Lancer la vérification maintenant')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔐'),
    );

    await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });

    queueAuditLog({
      guildId,
      user: 'Bot (automatique)',
      action: 'Notification staff - seuil warns',
      context: `${targetUser.tag} (${targetUser.id})`,
      module: 'Vérification',
      eventType: 'Automatique',
      details: `Seuil ${threshold} atteint (${warnCount} warns). Notification envoyée dans <#${channel.id}>.`,
    });
  } catch (err) {
    logger.error('VerifThreshold', `Erreur lors de la notification du staff pour ${targetUser.tag}:`, err);
  }
}

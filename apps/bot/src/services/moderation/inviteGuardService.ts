import {
  type Client,
  type Guild,
  type Invite,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type TextChannel,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { notify } from '../notifications/notifyService.js';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import { getRaidProtectionConfig, upsertRaidProtectionConfig } from './raidProtectionService.js';
import { INVITE_SOURCE, recordBotInvite } from '../analytics/inviteService.js';
import type { InviteApprovalRequest, RaidProtectionConfig } from '@prisma/client';

// ── Anti-spam de création d'invitations (fenêtre glissante en mémoire) ────────
const inviteCreations = new Map<string, number[]>(); // `${guildId}:${userId}` -> timestamps
const spamAlertCooldown = new Map<string, number>(); // même clé -> dernier envoi d'alerte
const SPAM_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

async function sendInviteAlert(guild: Guild, config: RaidProtectionConfig, embed: EmbedBuilder): Promise<void> {
  const channelId = config.inviteAlertChannelId ?? config.antiRaidAlertChannelId;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) {
    await (channel as TextChannel).send({ embeds: [embed] }).catch(() => null);
  }
}

async function notifyCreator(guildId: string, creatorId: string, message: string): Promise<void> {
  await notify({ guildId, userId: creatorId, kind: 'security.invite_update', title: 'Ton invitation', message }).catch(() => null);
}

/**
 * Traite la création d'une invitation selon la configuration :
 * urgence → règle unitaire → validation staff → suivi anti-spam.
 */
export async function handleInviteCreate(invite: Invite): Promise<void> {
  const guild = invite.guild;
  if (!guild || !('members' in guild)) return;
  const fullGuild = guild as Guild;
  const client = invite.client as Client;

  const config = await getRaidProtectionConfig(fullGuild.id);
  if (!config?.inviteGuardEnabled) return;

  const creatorId = invite.inviterId;
  // Invitations créées par le bot lui-même (ex. réinvitation honeypot) : toujours autorisées
  if (!creatorId || creatorId === client.user?.id) return;

  // ── 1. Mode urgence : tout est supprimé, sans exception ────────────────────
  if (config.inviteEmergencyEnabled) {
    await invite.delete('Mode urgence invitations actif').catch(() => null);
    await notifyCreator(fullGuild.id, creatorId,
      'La création d\'invitations est **suspendue** (mode urgence). Ton invitation a été supprimée.');
    await sendInviteAlert(fullGuild, config, new EmbedBuilder()
      .setColor(COLORS.danger)
      .setTitle('🚨 Invitation supprimée (mode urgence)')
      .setDescription(`<@${creatorId}> a tenté de créer une invitation pendant le mode urgence.`)
      .setTimestamp());
    return;
  }

  // ── Exemptions : admins et rôles bypass ────────────────────────────────────
  const member = await fullGuild.members.fetch(creatorId).catch(() => null);
  const isBypassed = Boolean(
    member &&
    (member.permissions.has(PermissionFlagsBits.Administrator) ||
      config.inviteBypassRoleIds.some((roleId) => member.roles.cache.has(roleId)))
  );

  // ── 2. Suivi anti-spam (même pour les invitations ensuite supprimées) ─────
  if (!isBypassed) {
    await trackInviteSpam(fullGuild, config, creatorId);
  }

  if (isBypassed) return;

  // ── 3. Règle unitaire : seules les invitations à 1 usage sont autorisées ──
  if (config.inviteRequireUnitary && invite.maxUses !== 1) {
    await invite.delete('Invitation non unitaire (seules les invitations à 1 usage sont autorisées)').catch(() => null);
    await notifyCreator(fullGuild.id, creatorId,
      `Ton invitation \`${invite.code}\` a été supprimée : seules les invitations à **1 usage** sont autorisées sur ce serveur (pas de 0/∞).`);
    await sendInviteAlert(fullGuild, config, new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('🔗 Invitation non unitaire supprimée')
      .setDescription(`Invitation \`${invite.code}\` de <@${creatorId}> (max uses: ${invite.maxUses === 0 ? '∞' : invite.maxUses}) supprimée automatiquement.`)
      .setTimestamp());
    return;
  }

  // ── 4. Validation staff : suppression + demande d'approbation ─────────────
  if (config.inviteValidationEnabled) {
    await invite.delete('Invitation en attente de validation staff').catch(() => null);

    const request = await prisma.inviteApprovalRequest.create({
      data: {
        guildId: fullGuild.id,
        creatorId,
        channelId: invite.channelId ?? fullGuild.systemChannelId ?? '',
        inviteCode: invite.code,
        maxUses: invite.maxUses ?? 1,
        maxAgeSec: invite.maxAge ?? 86400,
        temporary: invite.temporary ?? false,
      },
    });

    await notifyCreator(fullGuild.id, creatorId,
      'Ton invitation est **en attente de validation** par le staff. Tu recevras le lien si elle est approuvée.');

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('🔗 Invitation en attente de validation')
      .addFields(
        { name: 'Créateur', value: `<@${creatorId}> (\`${creatorId}\`)`, inline: true },
        { name: 'Salon', value: invite.channelId ? `<#${invite.channelId}>` : '-', inline: true },
        { name: 'Paramètres', value: `Usages max : ${(invite.maxUses ?? 1) === 0 ? '∞' : invite.maxUses ?? 1} · Expire : ${(invite.maxAge ?? 86400) === 0 ? 'jamais' : `${Math.round((invite.maxAge ?? 86400) / 3600)}h`}`, inline: false },
      )
      .setFooter({ text: `Demande ID: ${request.id}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rprot:invite_approve:${request.id}`).setLabel('Approuver').setStyle(ButtonStyle.Success).setEmoji('✅'),
      new ButtonBuilder().setCustomId(`rprot:invite_reject:${request.id}`).setLabel('Rejeter').setStyle(ButtonStyle.Danger).setEmoji('❌'),
    );

    const channelId = config.inviteAlertChannelId ?? config.antiRaidAlertChannelId;
    if (channelId) {
      const channel = await fullGuild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({ embeds: [embed], components: [row] }).catch(() => null);
      }
    }
    return;
  }
}

async function trackInviteSpam(guild: Guild, config: RaidProtectionConfig, creatorId: string): Promise<void> {
  const key = `${guild.id}:${creatorId}`;
  const now = Date.now();
  const windowMs = config.inviteSpamWindowSec * 1000;
  const timestamps = (inviteCreations.get(key) ?? []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  inviteCreations.set(key, timestamps);

  if (timestamps.length < config.inviteSpamThreshold) return;

  const lastAlert = spamAlertCooldown.get(key) ?? 0;
  if (now - lastAlert < SPAM_ALERT_COOLDOWN_MS) return;
  spamAlertCooldown.set(key, now);

  logger.warn('InviteGuard', `Spam d'invitations détecté sur ${guild.id} par ${creatorId} (${timestamps.length} en ${config.inviteSpamWindowSec}s)`);
  await sendInviteAlert(guild, config, new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('⚠️ Spam de création d\'invitations')
    .setDescription(`<@${creatorId}> a créé **${timestamps.length} invitations** en moins de **${config.inviteSpamWindowSec}s**.\nVérifiez ce compte (compromis ?).`)
    .setTimestamp());
}

// ── Mode urgence ──────────────────────────────────────────────────────────────

/** Active le mode urgence : supprime toutes les invitations existantes du serveur. */
export async function enableInviteEmergency(guild: Guild): Promise<number> {
  await upsertRaidProtectionConfig(guild.id, { inviteGuardEnabled: true, inviteEmergencyEnabled: true });

  let deleted = 0;
  const invites = await guild.invites.fetch().catch(() => null);
  if (invites) {
    for (const invite of invites.values()) {
      // On préserve les invitations du bot (réinvitations honeypot) et l'URL vanity
      if (invite.inviterId === guild.client.user?.id) continue;
      const ok = await invite.delete('Mode urgence invitations activé').then(() => true).catch(() => false);
      if (ok) deleted++;
    }
  }
  logger.warn('InviteGuard', `Mode urgence activé sur ${guild.id} - ${deleted} invitation(s) supprimée(s)`);
  return deleted;
}

export async function disableInviteEmergency(guild: Guild): Promise<void> {
  await upsertRaidProtectionConfig(guild.id, { inviteEmergencyEnabled: false });
  logger.info('InviteGuard', `Mode urgence désactivé sur ${guild.id}`);
}

// ── Validation staff (boutons) ────────────────────────────────────────────────

export async function approveInviteRequest(client: Client, requestId: string, staffId: string): Promise<InviteApprovalRequest | null> {
  const request = await prisma.inviteApprovalRequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== 'PENDING') return null;

  const guild = client.guilds.cache.get(request.guildId);
  if (!guild) return null;

  // Recrée l'invitation avec les paramètres d'origine
  let inviteUrl: string | null = null;
  let approvedCode: string | null = null;
  const channel = await guild.channels.fetch(request.channelId).catch(() => null);
  if (channel && 'createInvite' in channel && typeof channel.createInvite === 'function') {
    const invite = await channel.createInvite({
      maxUses: request.maxUses,
      maxAge: request.maxAgeSec,
      temporary: request.temporary,
      unique: true,
      reason: `Invitation approuvée par le staff (demande ${request.id})`,
    }).catch(() => null);
    if (invite) {
      inviteUrl = invite.url;
      approvedCode = invite.code;
      // Recréée par le bot pour le compte du demandeur : on trace l'origine « validation staff ».
      await recordBotInvite(invite, INVITE_SOURCE.inviteApproval());
    }
  }

  const updated = await prisma.inviteApprovalRequest.update({
    where: { id: requestId },
    data: { status: 'APPROVED', handledById: staffId, handledAt: new Date(), approvedInviteCode: approvedCode },
  });

  await notifyCreator(request.guildId, request.creatorId,
    inviteUrl
      ? `Ton invitation a été **approuvée** par le staff ! Voici ton lien : ${inviteUrl}`
      : 'Ton invitation a été approuvée, mais la recréation a échoué. Contacte le staff.');

  return updated;
}

export async function rejectInviteRequest(client: Client, requestId: string, staffId: string): Promise<InviteApprovalRequest | null> {
  const request = await prisma.inviteApprovalRequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== 'PENDING') return null;

  const updated = await prisma.inviteApprovalRequest.update({
    where: { id: requestId },
    data: { status: 'REJECTED', handledById: staffId, handledAt: new Date() },
  });

  await notifyCreator(request.guildId, request.creatorId,
    'Ton invitation a été **rejetée** par le staff.');

  return updated;
}

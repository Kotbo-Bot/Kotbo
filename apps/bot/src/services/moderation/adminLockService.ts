import type { Prisma } from '@prisma/client';
// ============================================================================
// ADMIN PERMISSION LOCK
// Empêche l'octroi non autorisé de la permission ADMINISTRATOR (défense contre
// un compte staff/admin compromis). Deux voies :
//  - bot-mediated (slash commands, MCP, dashboard) : bloquée avant application,
//    remplacée par une demande d'approbation (owner + rôles "sécurité").
//  - native Discord (hors bot) : impossible à bloquer a priori, détectée via
//    l'audit log puis annulée automatiquement (auto-revert).
// Sous-fonctionnalité additionnelle : suspension automatique des rôles admin
// d'un exécutant en cas de rafale d'actions destructrices (signe de raid).
// ============================================================================

import { type GuildMember,
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildAuditLogsEntry,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { AdminPermissionRequest, AdminPermissionRequestType } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { notify } from '../notifications/notifyService.js';
import { publicErrorMessage } from '../../utils/publicError.js';
import { resolveLogChannel } from '../../utils/logChannel.js';
import { getOrCreateAutoModConfig, invalidateAutoModCache } from './autoModService.js';
import { mirrorModlogToStaffServer } from '../staff/staffServerService.js';
import { recordAndCheckBurst, type BurstWindow } from '../../utils/burstTracker.js';
import { roleGrantsAdministrator, isAdminLockBypassedCore } from '../../utils/adminLockPermissions.js';

export { roleGrantsAdministrator, isAdminLockBypassedCore };

/**
 * Résout le bypass à partir d'un objet Guild réel. Un `actorId` null (ex:
 * appel MCP sans identité Discord fiable) n'est jamais bypassé.
 */
export function isAdminLockBypassed(guild: Guild, actorId: string | null, securityRoleIds: string[]): boolean {
  if (!actorId) return false;
  if (actorId === guild.ownerId) return true;
  const member = guild.members.cache.get(actorId);
  const actorRoleIds = member ? [...member.roles.cache.keys()] : [];
  return isAdminLockBypassedCore(actorId, guild.ownerId, actorRoleIds, securityRoleIds);
}

// ============================================================================
// DEMANDE D'APPROBATION - création + fan-out (DM + salon + dashboard)
// ============================================================================

export type RequestedVia = 'SLASH_COMMAND' | 'MCP' | 'DASHBOARD';

export type GuardAdminGrantParams = {
  client: Client;
  guild: Guild;
  actorId: string | null;
  requestedByTag?: string;
  requestedVia: RequestedVia;
  type: AdminPermissionRequestType;
  permissionBits: bigint;
  targetRoleId?: string;
  targetRoleName?: string;
  targetMemberId?: string;
  pendingRoleCreatePayload?: Record<string, unknown>;
  requestReason?: string;
};

export type GuardAdminGrantResult = { blocked: false } | { blocked: true; requestId: string };

/**
 * Point de passage unique pour toute mutation bot-mediated pouvant accorder
 * ADMINISTRATOR. Si la permission demandée n'inclut pas Administrator, ou si
 * la fonctionnalité est désactivée, ou si l'acteur est bypass (owner / rôle
 * sécurité), retourne { blocked: false } et l'appelant applique la mutation
 * normalement. Sinon crée une demande d'approbation et retourne son ID.
 */
export async function guardAdminGrant(params: GuardAdminGrantParams): Promise<GuardAdminGrantResult> {
  if (!roleGrantsAdministrator(params.permissionBits)) return { blocked: false };

  const config = await getOrCreateAutoModConfig(params.guild.id);
  if (!config.adminLockEnabled) return { blocked: false };

  // Un appel MCP n'a pas d'identité Discord fiable : jamais de bypass.
  const bypassed =
    params.requestedVia !== 'MCP' && isAdminLockBypassed(params.guild, params.actorId, config.adminLockSecurityRoleIds);
  if (bypassed) return { blocked: false };

  const request = await prisma.adminPermissionRequest.create({
    data: {
      guildId: params.guild.id,
      type: params.type,
      targetRoleId: params.targetRoleId ?? null,
      targetRoleName: params.targetRoleName ?? null,
      targetMemberId: params.targetMemberId ?? null,
      requestedPermissionBits: params.permissionBits.toString(),
      pendingRoleCreatePayload: (params.pendingRoleCreatePayload ?? undefined) as Prisma.InputJsonValue | undefined,
      requestedByUserId: params.actorId ?? 'mcp',
      requestedByTag: params.requestedByTag ?? null,
      requestedVia: params.requestedVia,
      requestReason: params.requestReason ?? null,
    },
  });

  await notifyAdminLockRequest(params.client, params.guild, request, config).catch((err) => {
    logger.error('AdminLockService', 'Erreur lors de la notification de la demande admin-lock:', err);
  });

  return { blocked: true, requestId: request.id };
}

const TYPE_LABELS: Record<AdminPermissionRequestType, string> = {
  ROLE_CREATE: 'Création de rôle',
  ROLE_PERMISSION_EDIT: 'Modification de permissions',
  MEMBER_ROLE_GRANT: 'Attribution de rôle à un membre',
};

const STATUS_COLORS: Record<string, number> = {
  PENDING: 0xf59e0b,
  APPROVED: 0x22c55e,
  REJECTED: 0xef4444,
  EXPIRED: 0x7f1d1d,
};

function buildRequestEmbed(guild: Guild, request: AdminPermissionRequest): EmbedBuilder {
  const perms = new PermissionsBitField(BigInt(request.requestedPermissionBits)).toArray();
  const lines = [
    `**Type :** ${TYPE_LABELS[request.type]}`,
    request.targetRoleName
      ? `**Rôle :** ${request.targetRoleName}${request.targetRoleId ? ` (\`${request.targetRoleId}\`)` : ''}`
      : null,
    request.targetMemberId ? `**Membre ciblé :** <@${request.targetMemberId}>` : null,
    `**Demandé par :** ${request.requestedByUserId === 'mcp' ? '_agent MCP (sans identité Discord)_' : `<@${request.requestedByUserId}>${request.requestedByTag ? ` (${request.requestedByTag})` : ''}`}`,
    `**Via :** ${request.requestedVia}`,
    request.requestReason ? `**Raison :** ${request.requestReason}` : null,
    `**Permissions incluant ADMINISTRATOR :** ${perms.slice(0, 15).join(', ')}`,
  ].filter((l): l is string => Boolean(l));

  if (request.status !== 'PENDING' && request.decidedByUserId) {
    lines.push(`**Décision :** ${request.status} par <@${request.decidedByUserId}>${request.decisionReason ? ` - ${request.decisionReason}` : ''}`);
  }

  return new EmbedBuilder()
    .setTitle("🔒 Demande d'octroi ADMINISTRATOR")
    .setDescription(lines.join('\n'))
    .setColor(STATUS_COLORS[request.status] ?? 0xf59e0b)
    .setFooter({ text: `Demande ID: ${request.id} - ${guild.name}` })
    .setTimestamp(request.createdAt);
}

function buildRequestButtons(requestId: string, status: string): ActionRowBuilder<ButtonBuilder>[] {
  const decided = status !== 'PENDING';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`adminlock:approve:${requestId}`).setLabel('Approuver').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(decided),
    new ButtonBuilder().setCustomId(`adminlock:reject:${requestId}`).setLabel('Rejeter').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(decided),
  );
  return [row];
}

// Les messages DM (potentiellement plusieurs approbateurs) ne sont pas
// persistés en base - un redémarrage du bot entre l'envoi et la décision
// laisse des boutons DM obsolètes non désactivés, mais le guard atomique de
// decideAdminLockRequest empêche tout double-traitement.
const dmMessagesByRequestId = new Map<string, { userId: string; messageId: string }[]>();

async function resolveApprovers(guild: Guild, securityRoleIds: string[]) {
  const approvers = new Map<string, GuildMember>();
  const owner = await guild.members.fetch(guild.ownerId).catch(() => guild.members.cache.get(guild.ownerId) ?? null);
  if (owner) approvers.set(owner.id, owner);
  for (const roleId of securityRoleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    for (const member of role.members.values()) approvers.set(member.id, member);
  }
  return [...approvers.values()];
}

async function notifyAdminLockRequest(
  client: Client,
  guild: Guild,
  request: AdminPermissionRequest,
  config: { adminLockNotifyChannelId: string | null; adminLockSecurityRoleIds: string[] }
): Promise<void> {
  const embed = buildRequestEmbed(guild, request);
  const components = buildRequestButtons(request.id, request.status);

  const channelId =
    config.adminLockNotifyChannelId ||
    (await prisma.guild.findUnique({ where: { id: guild.id }, select: { logChannelId: true } }))?.logChannelId;

  if (channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (channel?.isTextBased()) {
      const message = await channel.send({ embeds: [embed], components }).catch(() => null);
      if (message) {
        await prisma.adminPermissionRequest
          .update({ where: { id: request.id }, data: { staffChannelId: channel.id, staffMessageId: message.id } })
          .catch(() => null);
      }
    }
  }

  const approvers = await resolveApprovers(guild, config.adminLockSecurityRoleIds);
  const dmEntries: { userId: string; messageId: string }[] = [];
  for (const approver of approvers) {
    const message = (await approver.send({ embeds: [embed], components }).catch(() => null)) as { id: string } | null;
    if (message) dmEntries.push({ userId: approver.id, messageId: message.id });
  }
  if (dmEntries.length > 0) dmMessagesByRequestId.set(request.id, dmEntries);
}

async function refreshAdminLockSurfaces(client: Client, guild: Guild, request: AdminPermissionRequest): Promise<void> {
  const embed = buildRequestEmbed(guild, request);
  const components = buildRequestButtons(request.id, request.status);

  if (request.staffChannelId && request.staffMessageId) {
    const channel = guild.channels.cache.get(request.staffChannelId);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(request.staffMessageId).catch(() => null);
      await message?.edit({ embeds: [embed], components }).catch(() => null);
    }
  }

  const dmEntries = dmMessagesByRequestId.get(request.id) ?? [];
  for (const entry of dmEntries) {
    try {
      const user = await client.users.fetch(entry.userId);
      const dm = await user.createDM();
      const message = await dm.messages.fetch(entry.messageId).catch(() => null);
      await message?.edit({ embeds: [embed], components }).catch(() => null);
    } catch {
      // DM inaccessible entre-temps, tant pis
    }
  }
  dmMessagesByRequestId.delete(request.id);
}

// ============================================================================
// DÉCISION (approbation / rejet) - race-safe
// ============================================================================

export type AdminLockDecision = 'APPROVED' | 'REJECTED';

async function applyApprovedRequest(guild: Guild, request: AdminPermissionRequest): Promise<string | null> {
  try {
    const bits = BigInt(request.requestedPermissionBits);

    if (request.type === 'MEMBER_ROLE_GRANT') {
      if (!request.targetRoleId || !request.targetMemberId) return 'Cible manquante';
      const member = await guild.members.fetch(request.targetMemberId).catch(() => null);
      if (!member) return 'Membre introuvable';
      await member.roles.add(request.targetRoleId, '[AdminLock] Demande approuvée');
    } else if (request.type === 'ROLE_PERMISSION_EDIT') {
      if (!request.targetRoleId) return 'Rôle cible manquant';
      const role = await guild.roles.fetch(request.targetRoleId).catch(() => null);
      if (!role) return 'Rôle introuvable';
      await role.setPermissions(bits, '[AdminLock] Demande approuvée');
    } else if (request.type === 'ROLE_CREATE') {
      const payload = (request.pendingRoleCreatePayload ?? {}) as Record<string, unknown>;
      await guild.roles.create({ ...payload, permissions: bits, reason: '[AdminLock] Demande approuvée' } as Parameters<typeof guild.roles.create>[0]);
    }

    return null;
  } catch (e) {
    return publicErrorMessage(e, "La demande n'a pas pu être appliquée.", 'AdminLock');
  }
}

export async function decideAdminLockRequest(
  client: Client,
  params: {
    requestId: string;
    guildId: string;
    decision: AdminLockDecision;
    staffUserId: string;
    staffTag?: string;
    reason?: string;
  }
): Promise<{ ok: true; request: AdminPermissionRequest } | { ok: false; error: string }> {
  const guardResult = await prisma.adminPermissionRequest.updateMany({
    where: { id: params.requestId, guildId: params.guildId, status: 'PENDING' },
    data: {
      status: params.decision,
      decidedByUserId: params.staffUserId,
      decidedByTag: params.staffTag ?? null,
      decisionReason: params.reason ?? null,
      decidedAt: new Date(),
    },
  });

  if (guardResult.count === 0) return { ok: false, error: 'Cette demande a déjà été traitée.' };

  const request = await prisma.adminPermissionRequest.findUniqueOrThrow({ where: { id: params.requestId } });

  const guild = client.guilds.cache.get(params.guildId) ?? (await client.guilds.fetch(params.guildId).catch(() => null));
  if (!guild) return { ok: true, request };

  if (params.decision === 'APPROVED') {
    const applyError = await applyApprovedRequest(guild, request);
    if (applyError) {
      logger.error('AdminLockService', `Demande ${request.id} approuvée mais application échouée: ${applyError}`);
    }
  }

  await refreshAdminLockSurfaces(client, guild, request).catch((err) => {
    logger.warn('AdminLockService', 'Erreur lors du rafraîchissement des surfaces admin-lock:', err);
  });

  return { ok: true, request };
}

// ============================================================================
// INTERACTIONS DISCORD (boutons + modals du salon staff / DM)
// ============================================================================

export async function handleAdminLockButton(client: Client, customId: string, interaction: ButtonInteraction): Promise<void> {
  const [, action, requestId] = customId.split(':');
  if (!requestId || (action !== 'approve' && action !== 'reject')) return;

  const request = await prisma.adminPermissionRequest.findUnique({ where: { id: requestId } });
  if (!request) {
    await interaction.reply({ content: '❌ Demande introuvable (peut-être déjà traitée après un redémarrage du bot).', flags: [MessageFlags.Ephemeral] });
    return;
  }

  const guild = client.guilds.cache.get(request.guildId) ?? (await client.guilds.fetch(request.guildId).catch(() => null));
  if (!guild) {
    await interaction.reply({ content: '❌ Serveur introuvable.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  const config = await getOrCreateAutoModConfig(guild.id);
  if (!isAdminLockBypassed(guild, interaction.user.id, config.adminLockSecurityRoleIds)) {
    await interaction.reply({ content: '❌ Seul le propriétaire du serveur ou un rôle sécurité peut traiter cette demande.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (request.status !== 'PENDING') {
    await interaction.reply({ content: 'ℹ️ Cette demande a déjà été traitée.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  const input = new TextInputBuilder()
    .setCustomId('adminlock_input')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setLabel(action === 'approve' ? 'Note (optionnelle)' : 'Raison du rejet')
    .setRequired(action === 'reject');

  const modal = new ModalBuilder()
    .setCustomId(`adminlock_modal:${action}:${requestId}`)
    .setTitle(action === 'approve' ? 'Approuver la demande' : 'Rejeter la demande')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

  await interaction.showModal(modal);
}

export async function handleAdminLockModalSubmit(client: Client, customId: string, interaction: ModalSubmitInteraction): Promise<void> {
  const [, action, requestId] = customId.split(':');
  if (!requestId) return;

  const request = await prisma.adminPermissionRequest.findUnique({ where: { id: requestId } });
  if (!request) {
    await interaction.reply({ content: '❌ Demande introuvable.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  const guild = client.guilds.cache.get(request.guildId) ?? (await client.guilds.fetch(request.guildId).catch(() => null));
  if (!guild) {
    await interaction.reply({ content: '❌ Serveur introuvable.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  const config = await getOrCreateAutoModConfig(guild.id);
  if (!isAdminLockBypassed(guild, interaction.user.id, config.adminLockSecurityRoleIds)) {
    await interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const text = interaction.fields.getTextInputValue('adminlock_input') || undefined;

  const result = await decideAdminLockRequest(client, {
    requestId,
    guildId: request.guildId,
    decision: action === 'approve' ? 'APPROVED' : 'REJECTED',
    staffUserId: interaction.user.id,
    staffTag: interaction.user.tag,
    reason: text,
  });

  if (!result.ok) {
    await interaction.editReply({ content: `❌ ${result.error}` });
    return;
  }

  await interaction.editReply({
    content: action === 'approve' ? '✅ Demande approuvée et appliquée.' : '❌ Demande rejetée.',
  });
}

// ============================================================================
// DÉTECTION NATIVE + AUTO-REVERT + ANTI-RAFALE
// (un seul listener GuildAuditLogEntryCreate couvre les deux, sans intent
// supplémentaire : RoleCreate/RoleUpdate/MemberRoleUpdate pour le revert,
// ChannelDelete/MemberBanAdd/MemberKick/RoleUpdate/WebhookCreate/InviteCreate
// pour l'anti-rafale)
// ============================================================================

// Garde secondaire anti-boucle (ceinture-bretelles) : la garde primaire est
// `executorId === client.user.id`, suffisante en pratique puisque le revert
// du bot génère lui-même la prochaine entrée d'audit log attribuée au bot.
const recentBotRevertKeys = new Map<string, number>();
const REVERT_SUPPRESS_TTL_MS = 5000;

function markBotRevert(key: string): void {
  recentBotRevertKeys.set(key, Date.now() + REVERT_SUPPRESS_TTL_MS);
}

function wasRecentBotRevert(key: string): boolean {
  const expiry = recentBotRevertKeys.get(key);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    recentBotRevertKeys.delete(key);
    return false;
  }
  return true;
}

const CIRCUIT_BREAKER_WINDOWS: BurstWindow[] = [{ limit: 10, windowMs: 60_000 }];

async function tripCircuitBreakerIfNeeded(client: Client, guild: Guild): Promise<void> {
  const tripped = recordAndCheckBurst(`${guild.id}:revert_circuit_breaker`, Date.now(), CIRCUIT_BREAKER_WINDOWS);
  if (!tripped) return;

  await prisma.autoModConfig
    .update({ where: { guildId: guild.id }, data: { adminLockEnabled: false } })
    .catch((err) => logger.error('AdminLockService', 'Impossible de désactiver adminLockEnabled via le coupe-circuit:', err));
  invalidateAutoModCache(guild.id);

  const embed = new EmbedBuilder()
    .setTitle('🚨 Admin Permission Lock désactivé automatiquement (coupe-circuit)')
    .setColor(0xed4245)
    .setDescription("Plus de 10 annulations en 60 secondes ont été détectées. La fonctionnalité a été désactivée pour éviter une boucle. Réactivez-la manuellement depuis le dashboard après vérification.")
    .setTimestamp();

  await notifyAdminLock(guild.id, guild.ownerId, embedToNotice(embed));

  const guildDb = await prisma.guild.findUnique({ where: { id: guild.id }, select: { logChannelId: true } });
  const logChannel = await resolveLogChannel(guild, guildDb?.logChannelId, 'AdminLockService');
  if (logChannel) await logChannel.send({ embeds: [embed] }).catch(() => null);

  logger.warn('AdminLockService', `Coupe-circuit admin-lock déclenché pour la guilde ${guild.id}`);
}

async function notifyNativeRevert(
  client: Client,
  guild: Guild,
  config: { adminLockNotifyChannelId: string | null },
  params: { title: string; executorId: string; details: string }
): Promise<void> {
  await tripCircuitBreakerIfNeeded(client, guild);

  const embed = new EmbedBuilder()
    .setTitle(params.title)
    .setColor(0xed4245)
    .addFields(
      { name: 'Exécutant', value: `<@${params.executorId}>`, inline: true },
      { name: 'Action', value: 'Annulée automatiquement', inline: true },
      { name: 'Détails', value: params.details, inline: false },
    )
    .setTimestamp();

  const channelId =
    config.adminLockNotifyChannelId ||
    (await prisma.guild.findUnique({ where: { id: guild.id }, select: { logChannelId: true } }))?.logChannelId;
  const logChannel = await resolveLogChannel(guild, channelId, 'AdminLockService');
  if (logChannel) {
    await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  }

  await mirrorModlogToStaffServer(client, guild.id, embed).catch(() => null);

  await notifyAdminLock(guild.id, params.executorId, {
    title: 'Action annulée',
    message: `Une action que vous avez effectuée sur **${guild.name}** a été annulée automatiquement : ce serveur protège l'octroi de la permission ADMINISTRATOR (Admin Permission Lock).`,
  });

  if (guild.ownerId !== params.executorId) {
    await notifyAdminLock(guild.id, guild.ownerId, {
      title: 'Admin Permission Lock',
      message: `Admin Permission Lock a annulé une action potentiellement dangereuse effectuée par <@${params.executorId}>.\n${params.details}`,
    });
  }
}

function embedToNotice(embed: EmbedBuilder): { title: string; message: string } {
  const fields = (embed.data.fields ?? []).map((f) => `**${f.name}** : ${f.value}`);
  return { title: embed.data.title ?? 'Admin Permission Lock', message: [embed.data.description ?? '', ...fields].filter(Boolean).join('\n') };
}

async function notifyAdminLock(guildId: string, userId: string, notice: { title: string; message: string }): Promise<void> {
  await notify({ guildId, userId, kind: 'security.admin_lock', severity: 'CRITICAL', ...notice }).catch(() => null);
}

function findChange(entry: GuildAuditLogsEntry, key: string): { old?: unknown; new?: unknown } | undefined {
  return entry.changes?.find((c) => (c as { key: string }).key === key) as { old?: unknown; new?: unknown } | undefined;
}

async function handleNativeAdminChange(
  client: Client,
  guild: Guild,
  entry: GuildAuditLogsEntry,
  config: { adminLockSecurityRoleIds: string[]; adminLockNotifyChannelId: string | null }
): Promise<void> {
  const executorId = entry.executorId;
  if (!executorId) return;
  if (isAdminLockBypassed(guild, executorId, config.adminLockSecurityRoleIds)) return;

  if (entry.action === AuditLogEvent.RoleCreate) {
    const roleId = typeof entry.targetId === 'string' ? entry.targetId : null;
    if (!roleId) return;

    const permsChange = findChange(entry, 'permissions');
    const newBits = permsChange?.new != null ? BigInt(String(permsChange.new)) : null;
    if (newBits === null || !roleGrantsAdministrator(newBits)) return;

    const revertKey = `${guild.id}:${roleId}:role_create`;
    if (wasRecentBotRevert(revertKey)) return;

    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return;

    markBotRevert(revertKey);
    await role.delete('[AdminLock] Rôle créé avec ADMINISTRATOR par un exécutant non autorisé').catch((err) => {
      logger.error('AdminLockService', `Impossible de supprimer le rôle ${roleId} (revert admin-lock):`, err);
    });

    await notifyNativeRevert(client, guild, config, {
      title: '🔒 Rôle créé avec ADMINISTRATOR - supprimé automatiquement',
      executorId,
      details: `Rôle : ${role.name} (\`${roleId}\`)`,
    });
    return;
  }

  if (entry.action === AuditLogEvent.RoleUpdate) {
    const roleId = typeof entry.targetId === 'string' ? entry.targetId : null;
    if (!roleId) return;

    const permsChange = findChange(entry, 'permissions');
    if (!permsChange) return;
    const oldBits = permsChange.old != null ? BigInt(String(permsChange.old)) : 0n;
    const newBits = permsChange.new != null ? BigInt(String(permsChange.new)) : 0n;
    // Seul un octroi NOUVEAU d'Administrator déclenche le revert (pas déjà admin avant).
    if (roleGrantsAdministrator(oldBits) || !roleGrantsAdministrator(newBits)) return;

    const revertKey = `${guild.id}:${roleId}:role_update`;
    if (wasRecentBotRevert(revertKey)) return;

    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return;

    markBotRevert(revertKey);
    await role
      .setPermissions(oldBits, "[AdminLock] Octroi ADMINISTRATOR non autorisé - restauration des permissions précédentes")
      .catch((err) => {
        logger.error('AdminLockService', `Impossible de restaurer les permissions du rôle ${roleId} (revert admin-lock):`, err);
      });

    await notifyNativeRevert(client, guild, config, {
      title: '🔒 ADMINISTRATOR ajouté à un rôle - annulé automatiquement',
      executorId,
      details: `Rôle : ${role.name} (\`${roleId}\`)`,
    });
    return;
  }

  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const memberId = typeof entry.targetId === 'string' ? entry.targetId : null;
    if (!memberId) return;

    const addedChange = findChange(entry, '$add');
    const addedRoles = Array.isArray(addedChange?.new) ? (addedChange!.new as { id: string; name: string }[]) : [];
    if (addedRoles.length === 0) return;

    const adminRoles = addedRoles.filter((r) => {
      const role = guild.roles.cache.get(r.id);
      return role ? roleGrantsAdministrator(role.permissions.bitfield) : false;
    });
    if (adminRoles.length === 0) return;

    const member = await guild.members.fetch(memberId).catch(() => null);
    if (!member) return;

    const revertedRoleNames: string[] = [];
    for (const r of adminRoles) {
      const revertKey = `${guild.id}:${memberId}:${r.id}:member_role_update`;
      if (wasRecentBotRevert(revertKey)) continue;

      markBotRevert(revertKey);
      await member.roles.remove(r.id, "[AdminLock] Attribution non autorisée d'un rôle ADMINISTRATOR").catch((err) => {
        logger.error('AdminLockService', `Impossible de retirer le rôle ${r.id} de ${memberId} (revert admin-lock):`, err);
      });
      revertedRoleNames.push(r.name);
    }

    if (revertedRoleNames.length === 0) return;

    await notifyNativeRevert(client, guild, config, {
      title: '🔒 Rôle ADMINISTRATOR attribué à un membre - retiré automatiquement',
      executorId,
      details: `Membre : <@${memberId}>\nRôle(s) : ${revertedRoleNames.join(', ')}`,
    });
  }
}

const BURST_ACTION_TYPES = new Set<AuditLogEvent>([
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberKick,
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.InviteCreate,
]);

const burstSuspendCooldown = new Map<string, number>();

async function handleBurstSuspendCheck(
  client: Client,
  guild: Guild,
  executorId: string,
  config: {
    adminLockSecurityRoleIds: string[];
    adminLockNotifyChannelId: string | null;
    burstSuspendFastLimit: number;
    burstSuspendFastWindowSec: number;
    burstSuspendSlowLimit: number;
    burstSuspendSlowWindowSec: number;
  }
): Promise<void> {
  if (isAdminLockBypassed(guild, executorId, config.adminLockSecurityRoleIds)) return;

  const windows: BurstWindow[] = [
    { limit: config.burstSuspendFastLimit, windowMs: config.burstSuspendFastWindowSec * 1000 },
    { limit: config.burstSuspendSlowLimit, windowMs: config.burstSuspendSlowWindowSec * 1000 },
  ];
  const tripped = recordAndCheckBurst(`${guild.id}:${executorId}:burst_suspend`, Date.now(), windows);
  if (!tripped) return;

  const cooldownKey = `${guild.id}:${executorId}`;
  const nextAllowed = burstSuspendCooldown.get(cooldownKey) ?? 0;
  if (Date.now() < nextAllowed) return;
  burstSuspendCooldown.set(cooldownKey, Date.now() + 5 * 60 * 1000);

  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return;

  const adminRoles = [...member.roles.cache.filter((r) => roleGrantsAdministrator(r.permissions.bitfield)).values()];
  if (adminRoles.length === 0) return;

  for (const role of adminRoles) {
    await member.roles.remove(role.id, "[AdminLock] Suspension automatique - activité destructrice suspecte détectée").catch((err) => {
      logger.error('AdminLockService', `Impossible de retirer le rôle ${role.id} de ${executorId} (anti-rafale):`, err);
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🚨 Suspension automatique - activité destructrice en rafale détectée')
    .setColor(0xed4245)
    .addFields(
      { name: 'Membre', value: `<@${executorId}>`, inline: true },
      { name: 'Rôles retirés', value: adminRoles.map((r) => r.name).join(', '), inline: true },
    )
    .setDescription("Ce membre a effectué un grand nombre d'actions destructrices en peu de temps. Ses rôles donnant la permission ADMINISTRATOR ont été retirés par précaution. Aucune expulsion n'a été effectuée.")
    .setTimestamp();

  const channelId =
    config.adminLockNotifyChannelId ||
    (await prisma.guild.findUnique({ where: { id: guild.id }, select: { logChannelId: true } }))?.logChannelId;
  if (channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(() => null);
  }
  await mirrorModlogToStaffServer(client, guild.id, embed).catch(() => null);

  if (guild.ownerId !== executorId) await notifyAdminLock(guild.id, guild.ownerId, embedToNotice(embed));
}

export function registerAdminLockAuditListener(client: Client): void {
  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    try {
      const executorId = entry.executorId;
      if (!executorId) return;
      // Garde primaire anti-boucle - le revert du bot génère lui-même une nouvelle entrée d'audit log attribuée au bot.
      if (executorId === client.user?.id) return;

      const config = await getOrCreateAutoModConfig(guild.id);

      if (config.adminLockEnabled) {
        await handleNativeAdminChange(client, guild, entry, config).catch((err) => {
          logger.error('AdminLockService', 'Erreur détection native admin-lock:', err);
        });
      }

      if (config.burstSuspendEnabled && BURST_ACTION_TYPES.has(entry.action)) {
        await handleBurstSuspendCheck(client, guild, executorId, config).catch((err) => {
          logger.error('AdminLockService', 'Erreur anti-rafale admin-lock:', err);
        });
      }
    } catch (err) {
      logger.error('AdminLockService', 'Erreur listener admin-lock GuildAuditLogEntryCreate:', err);
    }
  });

  logger.info('Modules', 'Listener admin-lock (GuildAuditLogEntryCreate) enregistré.');
}

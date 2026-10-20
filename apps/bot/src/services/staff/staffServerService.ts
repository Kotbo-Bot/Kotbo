import {
  type Client,
  type GuildMember,
  type ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveLogChannel } from '../../utils/logChannel.js';
import { COLORS } from '../../utils/embeds.js';
import { cache } from '../../utils/cache.js';
import { reconcileStaffGuildActivation } from '../../utils/activation.js';
import { INVITE_SOURCE, recordBotInvite } from '../analytics/inviteService.js';
import type { StaffServerLink, StaffServerRoleMapping } from '@prisma/client';

const TAG = 'StaffServer';

type StaffServerLinkWithMappings = StaffServerLink & {
  roleMappings: StaffServerRoleMapping[];
};

// ── Cache ───────────────────────────────────────────────────

function staffLinksCacheKey(guildId: string) {
  return `staffserverlinks:${guildId}`;
}

export async function getStaffLinksForGuild(guildId: string): Promise<StaffServerLinkWithMappings[]> {
  const key = staffLinksCacheKey(guildId);
  const cached = await cache.get<StaffServerLinkWithMappings[]>(key);
  if (cached) return cached;

  const links = await prisma.staffServerLink.findMany({
    where: {
      enabled: true,
      OR: [{ mainGuildId: guildId }, { staffGuildId: guildId }],
    },
    include: { roleMappings: true },
  });

  if (links.length > 0) {
    await cache.set(key, links, 120);
  }
  return links;
}

export async function invalidateStaffLinkCache(link: StaffServerLink) {
  await cache.delete(staffLinksCacheKey(link.mainGuildId));
  await cache.delete(staffLinksCacheKey(link.staffGuildId));
}

// ── Link management ─────────────────────────────────────────

export async function createStaffServerLink(opts: {
  mainGuildId: string;
  staffGuildId: string;
  syncMode: 'MAIN_TO_STAFF' | 'STAFF_TO_MAIN' | 'BIDIRECTIONAL';
  hierarchyId?: string;
  simpleStaffRoleId?: string;
  mainLogChannelId?: string;
  staffLogChannelId?: string;
  createdByUserId: string;
}): Promise<StaffServerLink | { error: string }> {
  if (opts.mainGuildId === opts.staffGuildId) {
    return { error: 'Le serveur principal et le serveur staff doivent être différents.' };
  }

  const mainGuild = await prisma.guild.findUnique({
    where: { id: opts.mainGuildId },
    select: { activated: true },
  });

  if (!mainGuild?.activated) {
    return { error: 'Le serveur principal doit être activé avant de pouvoir lier un serveur staff.' };
  }

  const existing = await prisma.staffServerLink.findFirst({
    where: {
      mainGuildId: opts.mainGuildId,
      staffGuildId: opts.staffGuildId,
      hierarchyId: opts.hierarchyId ?? null,
    },
  });

  if (existing) {
    return { error: 'Un lien staff existe déjà entre ces deux serveurs pour cette hiérarchie.' };
  }

  const link = await prisma.staffServerLink.create({
    data: {
      mainGuildId: opts.mainGuildId,
      staffGuildId: opts.staffGuildId,
      syncMode: opts.syncMode,
      hierarchyId: opts.hierarchyId,
      simpleStaffRoleId: opts.simpleStaffRoleId,
      mainLogChannelId: opts.mainLogChannelId,
      staffLogChannelId: opts.staffLogChannelId,
      createdByUserId: opts.createdByUserId,
    },
  });

  await reconcileStaffGuildActivation(opts.staffGuildId);

  return link;
}

export async function removeStaffServerLink(linkId: string): Promise<StaffServerLink | null> {
  const link = await prisma.staffServerLink.findUnique({ where: { id: linkId } });
  if (!link) return null;

  await invalidateStaffLinkCache(link);
  const removed = await prisma.staffServerLink.delete({ where: { id: linkId } });

  await reconcileStaffGuildActivation(link.staffGuildId);

  return removed;
}

/**
 * Un serveur est considéré "serveur staff" s'il apparaît comme staffGuildId dans au moins
 * un StaffServerLink actif - détection implicite, sans champ de type dédié sur Guild.
 */
export async function isStaffServerGuild(guildId: string): Promise<boolean> {
  const count = await prisma.staffServerLink.count({
    where: { staffGuildId: guildId, enabled: true },
  });
  return count > 0;
}

// ── Notifications cross-serveur vers le serveur staff ──────

export type StaffNotifyKind = 'modlog' | 'sanctionReport' | 'recruitment' | 'offboarding' | 'onboardingInvite';

const NOTIFY_KIND_TO_FIELD: Record<StaffNotifyKind, keyof StaffServerLink> = {
  modlog: 'modlogMirrorChannelId',
  sanctionReport: 'sanctionReportChannelId',
  recruitment: 'recruitmentAlertChannelId',
  offboarding: 'offboardingAlertChannelId',
  onboardingInvite: 'onboardingInviteChannelId',
};

/**
 * Partie pure de la résolution : sélectionne le premier lien actif côté serveur principal
 * dont le salon correspondant au kind est configuré. Testable sans Discord.
 */
export function resolveStaffNotifyChannelId(
  links: StaffServerLink[],
  mainGuildId: string,
  kind: StaffNotifyKind,
): { staffGuildId: string; channelId: string } | null {
  const field = NOTIFY_KIND_TO_FIELD[kind];
  for (const link of links) {
    if (!link.enabled || link.mainGuildId !== mainGuildId) continue;
    const channelId = link[field];
    if (typeof channelId === 'string' && channelId) {
      return { staffGuildId: link.staffGuildId, channelId };
    }
  }
  return null;
}

/**
 * Résout le salon texte configuré sur le serveur STAFF lié au serveur principal donné.
 * Retourne null si pas de lien actif, champ non configuré, ou salon introuvable/hors du staff.
 */
export async function getStaffServerNotifyChannel(
  client: Client,
  mainGuildId: string,
  kind: StaffNotifyKind,
): Promise<TextChannel | null> {
  const links = await getStaffLinksForGuild(mainGuildId);
  const resolved = resolveStaffNotifyChannelId(links, mainGuildId, kind);
  if (!resolved) return null;

  const channel = await client.channels.fetch(resolved.channelId).catch(() => null);
  if (!(channel instanceof TextChannel)) return null;
  if (channel.guildId !== resolved.staffGuildId) return null;

  return channel;
}

/**
 * Duplique un embed de modération sur le salon "miroir modlog" du serveur staff lié.
 * Miroir uniquement - l'envoi dans le modlog du serveur principal reste inchangé.
 */
export async function mirrorModlogToStaffServer(
  client: Client,
  mainGuildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  const channel = await getStaffServerNotifyChannel(client, mainGuildId, 'modlog');
  if (!channel) return;

  const mainGuildName = client.guilds.cache.get(mainGuildId)?.name ?? mainGuildId;
  const mirrored = EmbedBuilder.from(embed.toJSON()).setFooter({ text: `Depuis ${mainGuildName}` });

  await channel.send({ embeds: [mirrored], allowedMentions: { parse: [] } }).catch(() => null);
}

export async function listStaffServerLinks(guildId: string): Promise<StaffServerLinkWithMappings[]> {
  return prisma.staffServerLink.findMany({
    where: {
      OR: [{ mainGuildId: guildId }, { staffGuildId: guildId }],
    },
    include: { roleMappings: true },
    orderBy: { createdAt: 'desc' },
  });
}

// ── Role mapping management ─────────────────────────────────

export async function addRoleMapping(opts: {
  staffServerLinkId: string;
  staffRoleId?: string;
  mainDiscordRoleId?: string;
  staffDiscordRoleId?: string;
}): Promise<StaffServerRoleMapping> {
  const mapping = await prisma.staffServerRoleMapping.create({
    data: {
      staffServerLinkId: opts.staffServerLinkId,
      staffRoleId: opts.staffRoleId,
      mainDiscordRoleId: opts.mainDiscordRoleId,
      staffDiscordRoleId: opts.staffDiscordRoleId,
    },
  });

  const link = await prisma.staffServerLink.findUnique({ where: { id: opts.staffServerLinkId } });
  if (link) await invalidateStaffLinkCache(link);

  return mapping;
}

export async function removeRoleMapping(mappingId: string): Promise<void> {
  const mapping = await prisma.staffServerRoleMapping.findUnique({
    where: { id: mappingId },
    include: { staffServerLink: true },
  });
  if (!mapping) return;

  await prisma.staffServerRoleMapping.delete({ where: { id: mappingId } });
  await invalidateStaffLinkCache(mapping.staffServerLink);
}

// ── Role sync logic ─────────────────────────────────────────

export async function syncMemberRoles(
  member: GuildMember,
  oldRoles: string[],
  newRoles: string[],
  client: Client,
): Promise<void> {
  const guildId = member.guild.id;
  const links = await getStaffLinksForGuild(guildId);
  if (links.length === 0) return;

  const addedRoles = newRoles.filter((r) => !oldRoles.includes(r));
  const removedRoles = oldRoles.filter((r) => !newRoles.includes(r));

  if (addedRoles.length === 0 && removedRoles.length === 0) return;

  for (const link of links) {
    try {
      const isMainGuild = link.mainGuildId === guildId;
      const isStaffGuild = link.staffGuildId === guildId;
      if (!isMainGuild && !isStaffGuild) continue;

      // Cycle de vie staff : détection AVANT le fetch du membre distant - à l'onboarding,
      // le membre n'est typiquement pas encore présent sur le serveur staff.
      if (isMainGuild) {
        const transition = computeStaffRoleTransition(link, oldRoles, newRoles, true);
        if (transition === 'gained-first') {
          await sendOnboardingInvite(client, link, member).catch((err) =>
            logger.warn(TAG, `Erreur d'onboarding pour ${member.user.tag} sur link ${link.id}`, err),
          );
        } else if (transition === 'lost-all') {
          await sendOffboardingAlert(client, link, member).catch((err) =>
            logger.warn(TAG, `Erreur d'alerte offboarding pour ${member.user.tag} sur link ${link.id}`, err),
          );
        }
      }

      const shouldSync = shouldSyncFromGuild(link.syncMode, isMainGuild);
      if (!shouldSync) continue;

      const otherGuildId = isMainGuild ? link.staffGuildId : link.mainGuildId;
      const otherGuild = client.guilds.cache.get(otherGuildId);
      if (!otherGuild) continue;

      let otherMember: GuildMember | null = null;
      try {
        otherMember = await otherGuild.members.fetch(member.user.id);
      } catch {
        continue;
      }

      if (link.syncMode === 'BIDIRECTIONAL' || hasMappingsForRoles(link, addedRoles, removedRoles, isMainGuild)) {
        await applyRoleSync(link, member, otherMember, addedRoles, removedRoles, isMainGuild, client);
      } else if (link.simpleStaffRoleId) {
        await applySimpleStaffRole(link, member, otherMember, addedRoles, removedRoles, isMainGuild);
      }
    } catch (err) {
      logger.error(TAG, `Erreur sync rôles pour ${member.user.tag} sur link ${link.id}`, err);
    }
  }
}

// ── Cycle de vie staff (onboarding / offboarding) ───────────

/**
 * Détecte la transition de statut staff d'un membre à partir des rôles mappés du lien.
 * Fonction pure - testable sans Discord.
 */
export function computeStaffRoleTransition(
  link: StaffServerLinkWithMappings,
  oldRoles: string[],
  newRoles: string[],
  isMainGuild: boolean,
): 'gained-first' | 'lost-all' | 'none' {
  const roleField = isMainGuild ? 'mainDiscordRoleId' : 'staffDiscordRoleId';
  const staffRoleIds = new Set(
    link.roleMappings.map((m) => m[roleField]).filter(Boolean) as string[],
  );
  if (staffRoleIds.size === 0) return 'none';

  const hadAny = oldRoles.some((r) => staffRoleIds.has(r));
  const hasAny = newRoles.some((r) => staffRoleIds.has(r));

  if (!hadAny && hasAny) return 'gained-first';
  if (hadAny && !hasAny) return 'lost-all';
  return 'none';
}

/**
 * Envoie en DM une invitation au serveur staff au membre qui vient d'obtenir son premier rôle staff.
 */
async function sendOnboardingInvite(
  client: Client,
  link: StaffServerLinkWithMappings,
  member: GuildMember,
): Promise<void> {
  if (!link.onboardingInviteEnabled) return;

  const staffGuild = client.guilds.cache.get(link.staffGuildId);
  if (!staffGuild) return;

  // Déjà membre du serveur staff → rien à faire
  const existing = await staffGuild.members.fetch(member.user.id).catch(() => null);
  if (existing) return;

  // Anti-doublon (Discord peut émettre plusieurs updates de rôles rapprochés)
  const dedupeKey = `staffserver:onboard:${link.id}:${member.user.id}`;
  if (await cache.get(dedupeKey)) return;
  await cache.set(dedupeKey, true, 3600);

  // Salon source de l'invitation : configuré, sinon rules/system, sinon premier salon texte invitable
  let inviteChannel: TextChannel | null = null;
  if (link.onboardingInviteChannelId) {
    const ch = staffGuild.channels.cache.get(link.onboardingInviteChannelId);
    if (ch instanceof TextChannel) inviteChannel = ch;
  }
  if (!inviteChannel) {
    const fallback = staffGuild.rulesChannel
      ?? staffGuild.systemChannel
      ?? staffGuild.channels.cache.find(
        (c): c is TextChannel =>
          c instanceof TextChannel &&
          !!staffGuild.members.me &&
          c.permissionsFor(staffGuild.members.me).has(PermissionFlagsBits.CreateInstantInvite),
      );
    if (fallback instanceof TextChannel) inviteChannel = fallback;
  }
  if (!inviteChannel) {
    logger.warn(TAG, `Onboarding: aucun salon invitable trouvé sur ${staffGuild.name} pour ${member.user.tag}`);
    return;
  }

  const invite = await inviteChannel.createInvite({
    maxAge: 7 * 24 * 60 * 60,
    maxUses: 1,
    unique: true,
    reason: 'Kotbo StaffServer: onboarding staff',
  }).catch(() => null);
  if (!invite) return;

  // Provenance = le serveur principal d'où vient le staff onboardé.
  await recordBotInvite(invite, INVITE_SOURCE.staffOnboarding(member.guild.name));

  const { notify } = await import('../notifications/notifyService.js');
  const dmSent = await notify({
    guildId: member.guild.id,
    userId: member.id,
    kind: 'staff.staff_server_invite',
    title: `Bienvenue dans l'équipe staff de ${member.guild.name}`,
    message: `Voici ton invitation au serveur staff : ${invite.url}\n*(valable 7 jours, 1 utilisation)*`,
    severity: 'SUCCESS',
    link: invite.url,
  }).then((r) => r.dm === 'sent').catch(() => false);

  const logChannel = await resolveLogChannel(member.guild, link.mainLogChannelId, TAG);
  if (logChannel) {
    await logChannel.send({
      content: dmSent
        ? `📨 Invitation au serveur staff envoyée en DM à **${member.user.tag}** (<@${member.user.id}>).`
        : `⚠️ Impossible d'envoyer l'invitation au serveur staff en DM à **${member.user.tag}** (<@${member.user.id}>) - DM fermés. Invitation : ${invite.url}`,
      allowedMentions: { parse: [] },
    }).catch(() => null);
  } else if (!dmSent) {
    logger.warn(TAG, `Onboarding: DM fermés pour ${member.user.tag}, invitation non délivrée (${invite.url})`);
  }
}

/**
 * Poste une alerte sur le serveur staff quand un membre perd tous ses rôles staff,
 * avec boutons d'expulsion (jamais d'auto-kick).
 */
async function sendOffboardingAlert(
  client: Client,
  link: StaffServerLinkWithMappings,
  member: GuildMember,
): Promise<void> {
  const channel = await getStaffServerNotifyChannel(client, link.mainGuildId, 'offboarding');
  if (!channel) return;

  const staffGuild = client.guilds.cache.get(link.staffGuildId);
  if (!staffGuild) return;

  // Si la personne n'est pas sur le serveur staff, aucune action n'est nécessaire
  const staffMember = await staffGuild.members.fetch(member.user.id).catch(() => null);
  if (!staffMember) return;

  const embed = new EmbedBuilder()
    .setTitle('👋 Départ du staff')
    .setDescription(
      `**${member.user.tag}** (<@${member.user.id}>) a perdu tous ses rôles staff sur **${member.guild.name}**.\n` +
      `Il est toujours présent sur ce serveur staff.`,
    )
    .setColor(COLORS.warning)
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`staffserver:kick:${link.id}:${member.user.id}`)
      .setLabel('Expulser du serveur staff')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`staffserver:keep:${link.id}:${member.user.id}`)
      .setLabel('Conserver')
      .setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => null);
}

/**
 * Gère les boutons `staffserver:*` (offboarding). Confirmation en deux temps, jamais d'auto-kick.
 */
export async function handleStaffServerButton(
  client: Client,
  customId: string,
  interaction: ButtonInteraction,
): Promise<void> {
  const [, action, linkId, userId] = customId.split(':');
  if (!action || !linkId || !userId) return;

  const link = await prisma.staffServerLink.findUnique({ where: { id: linkId } });
  if (!link) {
    await interaction.reply({ content: '❌ Lien serveur staff introuvable.', flags: [MessageFlags.Ephemeral] }).catch(() => null);
    return;
  }

  // Le bouton ne vit que sur le serveur staff
  if (interaction.guildId !== link.staffGuildId) {
    await interaction.reply({ content: '❌ Cette action doit être effectuée sur le serveur staff.', flags: [MessageFlags.Ephemeral] }).catch(() => null);
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.KickMembers)) {
    await interaction.reply({ content: "❌ Vous n'avez pas la permission d'expulser des membres.", flags: [MessageFlags.Ephemeral] }).catch(() => null);
    return;
  }

  if (action === 'keep') {
    await interaction.update({
      components: [],
      embeds: interaction.message.embeds.map((e) =>
        EmbedBuilder.from(e).setFooter({ text: `Conservé par ${interaction.user.tag}` }).toJSON(),
      ),
    }).catch(() => null);
    return;
  }

  if (action === 'kick') {
    // Premier clic : demander confirmation sur le message d'origine
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`staffserver:kickconfirm:${linkId}:${userId}`)
        .setLabel("Confirmer l'expulsion")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`staffserver:keep:${linkId}:${userId}`)
        .setLabel('Annuler')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({ components: [confirmRow] }).catch(() => null);
    return;
  }

  if (action === 'kickconfirm') {
    const staffGuild = client.guilds.cache.get(link.staffGuildId);
    if (!staffGuild) {
      await interaction.reply({ content: '❌ Serveur staff introuvable.', flags: [MessageFlags.Ephemeral] }).catch(() => null);
      return;
    }

    const kicked = await staffGuild.members
      .kick(userId, `Kotbo StaffServer: départ du staff (validé par ${interaction.user.tag})`)
      .then(() => true)
      .catch(() => false);

    await interaction.update({
      components: [],
      embeds: interaction.message.embeds.map((e) =>
        EmbedBuilder.from(e).setFooter({
          text: kicked
            ? `✅ Expulsé par ${interaction.user.tag}`
            : `⚠️ Expulsion impossible (membre déjà parti ou permissions insuffisantes) - ${interaction.user.tag}`,
        }).toJSON(),
      ),
    }).catch(() => null);
  }
}

function shouldSyncFromGuild(syncMode: string, isMainGuild: boolean): boolean {
  if (syncMode === 'BIDIRECTIONAL') return true;
  if (syncMode === 'MAIN_TO_STAFF' && isMainGuild) return true;
  if (syncMode === 'STAFF_TO_MAIN' && !isMainGuild) return true;
  return false;
}

function hasMappingsForRoles(
  link: StaffServerLinkWithMappings,
  addedRoles: string[],
  removedRoles: string[],
  isMainGuild: boolean,
): boolean {
  const changedRoles = [...addedRoles, ...removedRoles];
  const roleField = isMainGuild ? 'mainDiscordRoleId' : 'staffDiscordRoleId';

  return link.roleMappings.some((m) => {
    const mappedRoleId = m[roleField];
    return mappedRoleId && changedRoles.includes(mappedRoleId);
  });
}

async function applyRoleSync(
  link: StaffServerLinkWithMappings,
  sourceMember: GuildMember,
  targetMember: GuildMember,
  addedRoles: string[],
  removedRoles: string[],
  sourceIsMain: boolean,
  client: Client,
): Promise<void> {
  const sourceField = sourceIsMain ? 'mainDiscordRoleId' : 'staffDiscordRoleId';
  const targetField = sourceIsMain ? 'staffDiscordRoleId' : 'mainDiscordRoleId';

  const rolesToAdd: string[] = [];
  const rolesToRemove: string[] = [];

  for (const mapping of link.roleMappings) {
    const sourceRoleId = mapping[sourceField];
    const targetRoleId = mapping[targetField];
    if (!sourceRoleId || !targetRoleId) continue;

    if (addedRoles.includes(sourceRoleId)) {
      rolesToAdd.push(targetRoleId);
    }
    if (removedRoles.includes(sourceRoleId)) {
      rolesToRemove.push(targetRoleId);
    }
  }

  const actions: string[] = [];

  for (const roleId of rolesToAdd) {
    const role = targetMember.guild.roles.cache.get(roleId);
    if (role && !targetMember.roles.cache.has(roleId)) {
      await targetMember.roles.add(role, 'Kotbo StaffServer: Sync automatique').catch((err) =>
        logger.warn(TAG, `Impossible d'ajouter le rôle ${roleId} à ${targetMember.user.tag}`, err),
      );
      actions.push(`➕ Rôle **${role.name}** ajouté`);
    }
  }

  for (const roleId of rolesToRemove) {
    const role = targetMember.guild.roles.cache.get(roleId);
    if (role && targetMember.roles.cache.has(roleId)) {
      await targetMember.roles.remove(role, 'Kotbo StaffServer: Sync automatique').catch((err) =>
        logger.warn(TAG, `Impossible de retirer le rôle ${roleId} à ${targetMember.user.tag}`, err),
      );
      actions.push(`➖ Rôle **${role.name}** retiré`);
    }
  }

  if (actions.length > 0) {
    await sendSyncLog(link, sourceMember, targetMember, actions, sourceIsMain, client);
  }
}

async function applySimpleStaffRole(
  link: StaffServerLinkWithMappings,
  sourceMember: GuildMember,
  targetMember: GuildMember,
  addedRoles: string[],
  removedRoles: string[],
  sourceIsMain: boolean,
): Promise<void> {
  if (!link.simpleStaffRoleId) return;

  const sourceField = sourceIsMain ? 'mainDiscordRoleId' : 'staffDiscordRoleId';

  const staffSourceRoleIds = link.roleMappings
    .map((m) => m[sourceField])
    .filter(Boolean) as string[];

  const hasAnyStaffRole = sourceMember.roles.cache.some((r) => staffSourceRoleIds.includes(r.id));

  const destGuild = targetMember.guild;

  if (sourceIsMain && link.syncMode === 'MAIN_TO_STAFF') {
    const simpleRole = destGuild.roles.cache.get(link.simpleStaffRoleId);
    if (!simpleRole) return;

    if (hasAnyStaffRole && !targetMember.roles.cache.has(simpleRole.id)) {
      await targetMember.roles.add(simpleRole, 'Kotbo StaffServer: Ajout rôle staff simple').catch(() => null);
    } else if (!hasAnyStaffRole && targetMember.roles.cache.has(simpleRole.id)) {
      await targetMember.roles.remove(simpleRole, 'Kotbo StaffServer: Retrait rôle staff simple').catch(() => null);
    }
  }
}

// ── Logging ─────────────────────────────────────────────────

async function sendSyncLog(
  link: StaffServerLinkWithMappings,
  sourceMember: GuildMember,
  targetMember: GuildMember,
  actions: string[],
  sourceIsMain: boolean,
  client: Client,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setAuthor({
      name: `Sync Staff • ${sourceMember.user.displayName || sourceMember.user.username}`,
      iconURL: sourceMember.user.displayAvatarURL(),
    })
    .setDescription(
      `**Membre :** ${sourceMember.user.tag} (<@${sourceMember.user.id}>)\n` +
      `**Source :** ${sourceMember.guild.name}\n` +
      `**Cible :** ${targetMember.guild.name}\n\n` +
      actions.join('\n'),
    )
    .setTimestamp()
    .setFooter({ text: `StaffServer Link • ${link.syncMode}` });

  const logChannelIds = [link.mainLogChannelId, link.staffLogChannelId].filter(Boolean) as string[];

  for (const channelId of logChannelIds) {
    try {
      for (const guild of client.guilds.cache.values()) {
        const channel = guild.channels.cache.get(channelId);
        if (channel instanceof TextChannel) {
          await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
          break;
        }
      }
    } catch {
      // Silent - log channel might not be accessible
    }
  }
}

// ── Auto-setup role mappings on link creation ──────────────

export async function autoSetupRoleMappings(
  link: StaffServerLink,
  client: Client,
): Promise<{ created: number; matched: number; failed: number }> {
  const mainGuild = client.guilds.cache.get(link.mainGuildId);
  const staffGuild = client.guilds.cache.get(link.staffGuildId);
  if (!mainGuild || !staffGuild) return { created: 0, matched: 0, failed: 0 };

  const staffRoles = await prisma.staffRole.findMany({
    where: {
      guildId: link.mainGuildId,
      enabled: true,
      ...(link.hierarchyId ? { hierarchyId: link.hierarchyId } : {}),
    },
    orderBy: { sortOrder: 'asc' },
  });

  let created = 0;
  let matched = 0;
  let failed = 0;

  for (const staffRole of staffRoles) {
    if (!staffRole.discordRoleId) continue;

    const mainDiscordRole = mainGuild.roles.cache.get(staffRole.discordRoleId);
    if (!mainDiscordRole) continue;

    try {
      let targetDiscordRoleId: string;

      const existingRole = staffGuild.roles.cache.find(
        (r) => r.name.toLowerCase() === mainDiscordRole.name.toLowerCase() && !r.managed,
      );

      if (existingRole) {
        targetDiscordRoleId = existingRole.id;
        matched++;
      } else {
        const newRole = await staffGuild.roles.create({
          name: mainDiscordRole.name,
          color: mainDiscordRole.color,
          hoist: mainDiscordRole.hoist,
          mentionable: mainDiscordRole.mentionable,
          reason: 'Kotbo StaffServer: Auto-création lors du setup',
        });
        targetDiscordRoleId = newRole.id;
        created++;
      }

      const existingMapping = await prisma.staffServerRoleMapping.findFirst({
        where: {
          staffServerLinkId: link.id,
          staffRoleId: staffRole.id,
        },
      });

      if (!existingMapping) {
        await prisma.staffServerRoleMapping.create({
          data: {
            staffServerLinkId: link.id,
            staffRoleId: staffRole.id,
            mainDiscordRoleId: staffRole.discordRoleId,
            staffDiscordRoleId: targetDiscordRoleId,
          },
        });
      }
    } catch (err) {
      logger.warn(TAG, `Impossible de mapper le rôle "${mainDiscordRole.name}" sur ${staffGuild.name}`, err);
      failed++;
    }
  }

  await invalidateStaffLinkCache(link);
  return { created, matched, failed };
}

// ── Member join sync ───────────────────────────────────────

export async function syncMemberOnJoin(
  member: GuildMember,
  client: Client,
): Promise<void> {
  const guildId = member.guild.id;
  const links = await getStaffLinksForGuild(guildId);
  if (links.length === 0) return;

  for (const link of links) {
    try {
      const isMainGuild = link.mainGuildId === guildId;
      const isStaffGuild = link.staffGuildId === guildId;
      if (!isMainGuild && !isStaffGuild) continue;

      const otherGuildId = isMainGuild ? link.staffGuildId : link.mainGuildId;
      const otherGuild = client.guilds.cache.get(otherGuildId);
      if (!otherGuild) continue;

      let otherMember: GuildMember | null = null;
      try {
        otherMember = await otherGuild.members.fetch(member.user.id);
      } catch {
        continue;
      }

      const sourceField = isMainGuild ? 'staffDiscordRoleId' : 'mainDiscordRoleId';
      const targetField = isMainGuild ? 'mainDiscordRoleId' : 'staffDiscordRoleId';

      if (!shouldSyncFromGuild(link.syncMode, !isMainGuild)) continue;

      for (const mapping of link.roleMappings) {
        const sourceRoleId = mapping[sourceField];
        const targetRoleId = mapping[targetField];
        if (!sourceRoleId || !targetRoleId) continue;

        if (otherMember.roles.cache.has(sourceRoleId)) {
          const role = member.guild.roles.cache.get(targetRoleId);
          if (role && !member.roles.cache.has(targetRoleId)) {
            await member.roles.add(role, 'Kotbo StaffServer: Sync à l\'arrivée').catch((err) =>
              logger.warn(TAG, `Impossible d'ajouter le rôle ${targetRoleId} à ${member.user.tag} à l'arrivée`, err),
            );
          }
        }
      }

      if (link.simpleStaffRoleId) {
        const otherRoleField = isMainGuild ? 'mainDiscordRoleId' : 'staffDiscordRoleId';
        const otherRoleIds = link.roleMappings
          .map((m) => m[otherRoleField])
          .filter(Boolean) as string[];
        const hasAnyStaffRole = otherMember.roles.cache.some((r) => otherRoleIds.includes(r.id));

        if (hasAnyStaffRole) {
          const simpleRole = member.guild.roles.cache.get(link.simpleStaffRoleId);
          if (simpleRole && !member.roles.cache.has(simpleRole.id)) {
            await member.roles.add(simpleRole, 'Kotbo StaffServer: Rôle staff simple à l\'arrivée').catch(() => null);
          }
        }
      }
    } catch (err) {
      logger.error(TAG, `Erreur sync à l'arrivée pour ${member.user.tag} sur link ${link.id}`, err);
    }
  }
}

// ── Full sync (manual trigger) ──────────────────────────────

export async function fullSyncStaffRoles(linkId: string, client: Client): Promise<{ synced: number; errors: number }> {
  const link = await prisma.staffServerLink.findUnique({
    where: { id: linkId },
    include: { roleMappings: true },
  });

  if (!link) return { synced: 0, errors: 0 };

  const mainGuild = client.guilds.cache.get(link.mainGuildId);
  const staffGuild = client.guilds.cache.get(link.staffGuildId);
  if (!mainGuild || !staffGuild) return { synced: 0, errors: 0 };

  const sourceGuild = link.syncMode === 'STAFF_TO_MAIN' ? staffGuild : mainGuild;
  const targetGuild = link.syncMode === 'STAFF_TO_MAIN' ? mainGuild : staffGuild;
  const sourceIsMain = link.syncMode !== 'STAFF_TO_MAIN';

  const sourceField = sourceIsMain ? 'mainDiscordRoleId' : 'staffDiscordRoleId';
  const targetField = sourceIsMain ? 'staffDiscordRoleId' : 'mainDiscordRoleId';

  let synced = 0;
  let errors = 0;

  let sourceMembers;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      sourceMembers = await sourceGuild.members.fetch();
      break;
    } catch (err: any) {
      if (err?.name === 'GatewayRateLimitError' && err?.data?.retry_after && attempt < 2) {
        await new Promise((r) => setTimeout(r, err.data.retry_after * 1000 + 500));
        continue;
      }
      throw err;
    }
  }
  if (!sourceMembers) return { synced: 0, errors: 0 };

  for (const [userId, sourceMember] of sourceMembers) {
    if (sourceMember.user.bot) continue;

    try {
      let targetMember: GuildMember;
      try {
        targetMember = await targetGuild.members.fetch(userId);
      } catch {
        continue;
      }

      for (const mapping of link.roleMappings) {
        const sourceRoleId = mapping[sourceField];
        const targetRoleId = mapping[targetField];
        if (!sourceRoleId || !targetRoleId) continue;

        const hasSourceRole = sourceMember.roles.cache.has(sourceRoleId);
        const hasTargetRole = targetMember.roles.cache.has(targetRoleId);

        if (hasSourceRole && !hasTargetRole) {
          const role = targetGuild.roles.cache.get(targetRoleId);
          if (role) {
            await targetMember.roles.add(role, 'Kotbo StaffServer: Sync complète');
            synced++;
          }
        } else if (!hasSourceRole && hasTargetRole) {
          const role = targetGuild.roles.cache.get(targetRoleId);
          if (role) {
            await targetMember.roles.remove(role, 'Kotbo StaffServer: Sync complète');
            synced++;
          }
        }
      }

      if (link.simpleStaffRoleId && link.syncMode !== 'BIDIRECTIONAL') {
        const staffRoleIds = link.roleMappings.map((m) => m[sourceField]).filter(Boolean) as string[];
        const hasAnyStaffRole = sourceMember.roles.cache.some((r) => staffRoleIds.includes(r.id));
        const simpleRole = targetGuild.roles.cache.get(link.simpleStaffRoleId);

        if (simpleRole) {
          if (hasAnyStaffRole && !targetMember.roles.cache.has(simpleRole.id)) {
            await targetMember.roles.add(simpleRole, 'Kotbo StaffServer: Sync complète');
            synced++;
          } else if (!hasAnyStaffRole && targetMember.roles.cache.has(simpleRole.id)) {
            await targetMember.roles.remove(simpleRole, 'Kotbo StaffServer: Sync complète');
            synced++;
          }
        }
      }
    } catch (err) {
      errors++;
      logger.warn(TAG, `Erreur sync complète pour ${userId}`, err);
    }
  }

  return { synced, errors };
}

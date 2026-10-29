/**
 * jailService.ts - Quarantaine par rôle (« Jail »).
 *
 * Un membre en jail reste sur le serveur mais n'y voit plus rien : le rôle Jail
 * est refusé sur tous les salons, sauf celui réservé aux quarantaines. Ses
 * rôles lui sont retirés (sinon un rôle qui ouvre un salon annulerait le refus)
 * et rendus à la levée.
 *
 * Ce module ne fait que la mécanique Discord et la ligne MemberJail. La
 * sanction (historique, notifications, appels) est enregistrée par
 * sanctionService.registerJailSanction, qui s'appuie dessus.
 */

import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
} from 'discord.js';
import { SanctionStatus, SanctionType } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getRaidProtectionConfig, upsertRaidProtectionConfig } from './raidProtectionService.js';

export type JailSource = 'MANUAL' | 'SERVER_TAG' | 'ACCOUNT_AGE' | 'DISCORD_QUARANTINE' | 'HONEYPOT' | 'VISION';

export class JailNotConfiguredError extends Error {
  constructor() {
    super("Aucun rôle Jail n'est configuré sur ce serveur.");
    this.name = 'JailNotConfiguredError';
  }
}

/** Le rôle Jail configuré, s'il existe encore. */
export async function getJailRole(guild: Guild): Promise<Role | null> {
  const config = await getRaidProtectionConfig(guild.id);
  if (!config?.jailRoleId) return null;
  return guild.roles.cache.get(config.jailRoleId) ?? (await guild.roles.fetch(config.jailRoleId).catch(() => null));
}

export async function isJailConfigured(guild: Guild): Promise<boolean> {
  return (await getJailRole(guild)) !== null;
}

// ── Provisionnement du rôle ──────────────────────────────────────────────────

const JAIL_DENY = [PermissionFlagsBits.ViewChannel];
const JAIL_CHANNEL_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

function canHoldOverwrites(channel: GuildBasedChannel): boolean {
  return !channel.isThread() && 'permissionOverwrites' in channel;
}

/**
 * Pose le refus du rôle Jail sur un salon. Appelé sur tous les salons au
 * provisionnement, puis sur chaque salon créé ensuite : sans ça, une nouvelle
 * catégorie serait visible des membres en quarantaine.
 */
export async function applyJailOverwrite(channel: GuildBasedChannel, jailRoleId: string, jailChannelId: string | null): Promise<void> {
  if (!canHoldOverwrites(channel) || !('permissionOverwrites' in channel)) return;
  const overwrites = channel.permissionOverwrites;
  if (channel.id === jailChannelId) {
    await overwrites.edit(jailRoleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { reason: 'Kotbo Jail : salon de quarantaine' });
    return;
  }
  const existing = overwrites.cache.get(jailRoleId);
  if (existing?.deny.has(JAIL_DENY)) return;
  await overwrites.edit(jailRoleId, { ViewChannel: false }, { reason: 'Kotbo Jail : salon masqué en quarantaine' });
}

/**
 * Crée (ou répare) le rôle Jail et, au besoin, le salon de quarantaine.
 * Idempotent : relancé, il reprend les salons qui ont perdu leur refus.
 */
export async function provisionJail(guild: Guild, opts: { createChannel?: boolean } = {}): Promise<{ roleId: string; channelId: string | null; channelsUpdated: number }> {
  const config = await getRaidProtectionConfig(guild.id);
  let role = await getJailRole(guild);
  if (!role) {
    role = await guild.roles.create({
      name: 'Jail',
      color: 0x4b5563,
      permissions: [],
      hoist: false,
      mentionable: false,
      reason: 'Kotbo : rôle de quarantaine',
    });
  }

  let channelId = config?.jailChannelId ?? null;
  if (channelId && !guild.channels.cache.has(channelId)) channelId = null;
  if (!channelId && opts.createChannel) {
    const channel = await guild.channels.create({
      name: 'quarantaine',
      type: ChannelType.GuildText,
      topic: 'Salon réservé aux membres en quarantaine. Le staff peut y échanger avec eux.',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: role.id, allow: JAIL_CHANNEL_ALLOW },
        { id: guild.members.me!.id, allow: [...JAIL_CHANNEL_ALLOW, PermissionFlagsBits.ManageMessages] },
      ],
      reason: 'Kotbo : salon de quarantaine',
    });
    channelId = channel.id;
  }

  let channelsUpdated = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!canHoldOverwrites(channel)) continue;
    // Un salon synchronisé hérite de sa catégorie : le modifier casserait la
    // synchronisation pour rien.
    if ('permissionsLocked' in channel && channel.permissionsLocked && channel.parentId && channel.id !== channelId) continue;
    try {
      await applyJailOverwrite(channel, role.id, channelId);
      channelsUpdated++;
    } catch (err) {
      logger.debug('Jail', `Refus non posé sur ${channel.id} (${guild.id}): ${String(err)}`);
    }
  }

  await upsertRaidProtectionConfig(guild.id, { jailRoleId: role.id, jailChannelId: channelId });
  return { roleId: role.id, channelId, channelsUpdated };
}

// ── Entrée et sortie de quarantaine ─────────────────────────────────────────

/** Rôles que le bot peut retirer puis rendre. */
function strippableRoles(member: GuildMember, jailRoleId: string): string[] {
  const me = member.guild.members.me;
  const ceiling = me?.roles.highest.position ?? 0;
  return member.roles.cache
    .filter((r) => r.id !== member.guild.id && r.id !== jailRoleId && !r.managed && r.position < ceiling)
    .map((r) => r.id);
}

/**
 * Met un membre en quarantaine. N'enregistre pas de sanction : c'est le rôle
 * de registerJailSanction. Si le membre est déjà en jail, la ligne est mise à
 * jour sans lui retirer à nouveau des rôles qu'il n'a plus.
 */
export async function imprison(params: {
  member: GuildMember;
  source: JailSource;
  reason: string;
  releaseAt: Date | null;
  sanctionId?: string | null;
  auditReason: string;
}): Promise<void> {
  const { member } = params;
  const role = await getJailRole(member.guild);
  if (!role) throw new JailNotConfiguredError();

  const config = await getRaidProtectionConfig(member.guild.id);
  const existing = await prisma.memberJail.findUnique({
    where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
  });

  const stripped = existing ? existing.roleIds : config?.jailStripRoles === false ? [] : strippableRoles(member, role.id);

  // Un seul appel : poser le rôle Jail et retirer les autres d'un coup évite la
  // fenêtre où le membre a les deux, et une demande de modification par rôle.
  const keep = member.roles.cache.filter((r) => r.id !== member.guild.id && !stripped.includes(r.id)).map((r) => r.id);
  await member.roles.set([...new Set([...keep, role.id])], params.auditReason);

  await prisma.memberJail.upsert({
    where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
    create: {
      guildId: member.guild.id,
      userId: member.id,
      source: params.source,
      roleIds: stripped,
      reason: params.reason,
      releaseAt: params.releaseAt,
      sanctionId: params.sanctionId ?? null,
    },
    update: {
      source: params.source,
      reason: params.reason,
      releaseAt: params.releaseAt,
      ...(params.sanctionId ? { sanctionId: params.sanctionId } : {}),
    },
  });
}

export async function attachSanctionToJail(guildId: string, userId: string, sanctionId: string): Promise<void> {
  await prisma.memberJail.updateMany({ where: { guildId, userId }, data: { sanctionId } });
}

export async function getActiveJail(guildId: string, userId: string) {
  return prisma.memberJail.findUnique({ where: { guildId_userId: { guildId, userId } } });
}

/**
 * Lève une quarantaine : retire le rôle Jail, rend les rôles retirés qui
 * existent encore et clôt la sanction. Sans effet si le membre n'est pas en jail.
 * Retourne false si aucune quarantaine n'était active.
 */
export async function releaseJail(
  client: Client,
  guildId: string,
  userId: string,
  opts: { note: string; auditReason?: string; onlySource?: JailSource }
): Promise<boolean> {
  const jail = await prisma.memberJail.findUnique({ where: { guildId_userId: { guildId, userId } } });
  if (!jail) return false;
  if (opts.onlySource && jail.source !== opts.onlySource) return false;

  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      const config = await getRaidProtectionConfig(guildId);
      const ceiling = guild.members.me?.roles.highest.position ?? 0;
      const restorable = jail.roleIds.filter((id) => {
        const role = guild.roles.cache.get(id);
        return role && !role.managed && role.position < ceiling;
      });
      const next = member.roles.cache
        .filter((r) => r.id !== guild.id && r.id !== config?.jailRoleId)
        .map((r) => r.id);
      await member.roles
        .set([...new Set([...next, ...restorable])], opts.auditReason ?? 'Kotbo Jail : levée de la quarantaine')
        .catch((err) => logger.warn('Jail', `Rôles non rendus à ${userId} (${guildId}): ${String(err)}`));
    }
  }

  await prisma.memberJail.delete({ where: { guildId_userId: { guildId, userId } } }).catch(() => null);
  await prisma.sanction.updateMany({
    where: {
      guildId,
      targetUserId: userId,
      type: SanctionType.JAIL,
      status: SanctionStatus.ACTIVE,
      ...(jail.sanctionId ? { id: jail.sanctionId } : {}),
    },
    data: { status: SanctionStatus.RESOLVED, resolvedAt: new Date(), nextActionAt: null, resolutionNote: opts.note },
  });
  return true;
}

/** Lève les quarantaines arrivées à échéance. Appelé par le planificateur des sanctions. */
export async function processJailReleases(client: Client): Promise<void> {
  const due = await prisma.memberJail.findMany({
    where: { releaseAt: { lte: new Date() } },
    orderBy: { releaseAt: 'asc' },
    take: 50,
  });
  for (const jail of due) {
    // Le planificateur tourne sur chaque shard : chacun ne traite que ses serveurs.
    if (!client.guilds.cache.has(jail.guildId)) continue;
    const note = jail.source === 'ACCOUNT_AGE' ? 'Âge du compte atteint, quarantaine levée.' : 'Quarantaine expirée et levée automatiquement.';
    await releaseJail(client, jail.guildId, jail.userId, { note }).catch((err) =>
      logger.error('Jail', `Levée impossible pour ${jail.userId} (${jail.guildId})`, err)
    );
  }
}

/**
 * Un membre en quarantaine qui quitte puis revient ne doit pas en sortir pour
 * autant : le rôle lui est reposé à l'arrivée. Retourne true s'il était en jail.
 */
export async function reapplyJailOnJoin(member: GuildMember): Promise<boolean> {
  const jail = await prisma.memberJail.findUnique({
    where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
  });
  if (!jail) return false;
  if (jail.releaseAt && jail.releaseAt <= new Date()) return false;

  const role = await getJailRole(member.guild);
  if (!role) return false;
  await member.roles.add(role, 'Kotbo Jail : quarantaine toujours active au retour').catch((err) =>
    logger.warn('Jail', `Rôle Jail non reposé à ${member.id} (${member.guild.id}): ${String(err)}`)
  );
  return true;
}

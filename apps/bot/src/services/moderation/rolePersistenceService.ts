import { PermissionFlagsBits, type GuildMember, type PartialGuildMember, type Role } from 'discord.js';
import type { RaidProtectionConfig } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getCachedGuild } from '../../utils/cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Rendre ces permissions sans intervention humaine redonnerait la main à un
// ancien staff écarté entre-temps, ou à un compte compromis entre deux passages.
const PRIVILEGED_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
];

function isPrivileged(role: Role): boolean {
  return PRIVILEGED_PERMISSIONS.some((perm) => role.permissions.has(perm, false));
}

function matchesMode(config: RaidProtectionConfig, roleId: string): boolean {
  const listed = (config.rolePersistRoleIds ?? []).includes(roleId);
  return config.rolePersistMode === 'LIST' ? listed : !listed;
}

/**
 * Mémorise les rôles d'un membre qui quitte le serveur.
 *
 * Un membre absent du cache au moment du départ arrive sans ses rôles : il n'y a
 * alors rien à mémoriser, et son retour se fera sans restauration.
 */
export async function snapshotDepartingMemberRoles(
  member: GuildMember | PartialGuildMember,
  config: RaidProtectionConfig,
): Promise<void> {
  if (!config.rolePersistEnabled || member.partial || member.user.bot) return;

  const guildId = member.guild.id;
  const currentRoleIds = member.roles.cache
    .filter((role) => role.id !== guildId && !role.managed && matchesMode(config, role.id))
    .map((role) => role.id);

  // Une trace encore présente signifie que les rôles n'ont pas été rendus pendant
  // ce passage (captcha en attente ou échoué, bot hors ligne à l'arrivée) : on la
  // complète au lieu de l'écraser, sinon un second départ effacerait ce qui est dû.
  const existing = await prisma.memberRoleSnapshot.findUnique({
    where: { guildId_userId: { guildId, userId: member.id } },
  });
  const roleIds = [...new Set([...(existing?.roleIds ?? []), ...currentRoleIds])];
  if (roleIds.length === 0) return;

  await prisma.memberRoleSnapshot.upsert({
    where: { guildId_userId: { guildId, userId: member.id } },
    create: { guildId, userId: member.id, roleIds },
    update: { roleIds, leftAt: new Date() },
  });
}

/**
 * Rend à un membre revenu les rôles mémorisés à son départ, puis oublie la trace.
 *
 * Tout est revérifié au retour plutôt qu'au départ : la configuration, la
 * hiérarchie et les permissions des rôles ont pu changer entre les deux.
 */
export async function restorePersistedRoles(member: GuildMember, config: RaidProtectionConfig): Promise<void> {
  if (!config.rolePersistEnabled || member.user.bot) return;

  const guild = member.guild;
  const key = { guildId_userId: { guildId: guild.id, userId: member.id } };
  const snapshot = await prisma.memberRoleSnapshot.findUnique({ where: key });
  if (!snapshot) return;

  const forget = () => prisma.memberRoleSnapshot.delete({ where: key }).catch(() => null);

  if (Date.now() - snapshot.leftAt.getTime() > config.rolePersistMaxDays * DAY_MS) {
    await forget();
    return;
  }

  // Sans la permission, la trace est gardée : elle servira au prochain retour une
  // fois le bot réparé, ou partira à la purge.
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    logger.warn('RolePersistence', `Permission « Gérer les rôles » manquante sur ${guild.id}, rôles de ${member.id} non rendus`);
    return;
  }

  // Les rôles de vérification restent aux mains de leur parcours : les rendre
  // d'office laisserait un membre revenu contourner le captcha ou l'OAuth.
  const guildRow = await getCachedGuild(guild.id);
  const verificationRoleIds = new Set(
    [config.captchaUnverifiedRoleId, config.captchaVerifiedRoleId, guildRow?.verificationRoleId].filter(Boolean),
  );

  const restoreStaff = config.rolePersistStaff && !(await isStaffBarred(guild.id, member.id));

  const restorable = snapshot.roleIds.filter((roleId) => {
    const role = guild.roles.cache.get(roleId);
    if (!role || role.managed || role.id === guild.id) return false;
    if (verificationRoleIds.has(role.id)) return false;
    if (isPrivileged(role) && !restoreStaff) return false;
    if (role.position >= me.roles.highest.position) return false;
    if (member.roles.cache.has(role.id)) return false;
    return matchesMode(config, role.id);
  });

  if (restorable.length > 0) {
    try {
      await member.roles.add(restorable, 'Rôles rendus au retour du membre');
    } catch (err) {
      logger.error('RolePersistence', `Restauration des rôles impossible pour ${member.id} sur ${guild.id}`, err);
      return;
    }
    if (restoreStaff) await reregisterStaff(member, restorable);
  }

  await forget();
}

/** Un staff suspendu ou blacklisté ne récupère pas ses rôles à permissions en revenant. */
async function isStaffBarred(guildId: string, userId: string): Promise<boolean> {
  const row = await prisma.staffMember.findFirst({
    where: { guildId, userId },
    select: {
      suspendedAt: true,
      blacklistEntries: {
        where: { isActive: true, OR: [{ endDate: null }, { endDate: { gt: new Date() } }] },
        select: { id: true },
        take: 1,
      },
    },
  });
  return !!row && (!!row.suspendedAt || row.blacklistEntries.length > 0);
}

/**
 * Remet au staff un membre dont un rôle de grade vient d'être rendu. Une ligne
 * d'annuaire encore présente est laissée telle quelle (grade et ancienneté) ;
 * son organigramme se resynchronise tout seul sur la mise à jour des rôles.
 */
async function reregisterStaff(member: GuildMember, restoredRoleIds: string[]): Promise<void> {
  try {
    const guildId = member.guild.id;
    const [grade, existing] = await Promise.all([
      prisma.staffRole.findFirst({
        where: { guildId, enabled: true, discordRoleId: { in: restoredRoleIds } },
        orderBy: { level: 'desc' },
        select: { name: true },
      }),
      prisma.staffMember.findFirst({ where: { guildId, userId: member.id }, select: { id: true } }),
    ]);
    if (!grade || existing) return;

    const { addStaffMember } = await import('../staff/staffManagementService.js');
    await addStaffMember(
      guildId, member.id, grade.name,
      member.user.tag, member.user.username, member.displayName, member.user.displayAvatarURL(),
    );
  } catch (err) {
    logger.error('RolePersistence', `Réinscription au staff impossible pour ${member.id} sur ${member.guild.id}`, err);
  }
}

/** Oublie les traces trop anciennes, et celles des serveurs qui ont coupé la fonction. */
export async function pruneMemberRoleSnapshots(): Promise<void> {
  const removed = await prisma.$executeRaw`
    DELETE FROM "member_role_snapshots" s
    WHERE NOT EXISTS (
      SELECT 1 FROM "raid_protection_configs" c
      WHERE c."guildId" = s."guildId"
        AND c."rolePersistEnabled" = true
        AND s."leftAt" >= (now() AT TIME ZONE 'UTC') - make_interval(days => c."rolePersistMaxDays")
    )
  `;
  if (removed > 0) logger.info('RolePersistence', `${removed} trace(s) de rôles purgée(s)`);
}

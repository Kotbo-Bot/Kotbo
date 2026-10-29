import prisma from '../../utils/db.js';
import { upsertHierarchyGradeRow, upsertStaffMemberRow } from './staffRowUpsert.js';
import { resolveMemberAvatarUrl } from '../moderation/memberIdentityService.js';
import { cache } from '../../utils/cache.js';

import crypto from 'node:crypto';
import { notify, notifyMany } from '../notifications/notifyService.js';
import { getClient } from '../../utils/client.js';
import { logger } from '../../utils/logger.js';
import * as altAccountService from '../moderation/altAccountService.js';
import { fetchAllMembers } from '../../utils/discord.js';
import type { GuildMember } from 'discord.js';
import { publicErrorMessage } from '../../utils/publicError.js';

/**
 * Service de gestion du personnel staff
 * Gère les membres du staff, les avertissements, la blacklist, les clés API, etc.
 */

export const hashAPIKey = (key: string): string => {
  return crypto.createHash('sha256').update(key).digest('hex');
};

export const generateAPIKey = (): { fullKey: string; displayKey: string } => {
  const fullKey = `kb_${crypto.randomBytes(32).toString('hex')}`;
  const displayKey = `${fullKey.slice(0, 8)}...${fullKey.slice(-4)}`;
  return { fullKey, displayKey };
};

export const getStaffMember = async (guildId: string, userId: string) => {
  if (guildId === 'any') {
    return prisma.staffMember.findFirst({
      where: { userId },
    });
  }
  return prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
};

const resolveStaffMemberId = async (guildId: string, staffIdentifier: string) => {
  if (guildId === 'any') {
    const byId = await prisma.staffMember.findFirst({
      where: { id: staffIdentifier },
      select: { id: true },
    });
    if (byId) return byId.id;

    const byUserId = await prisma.staffMember.findFirst({
      where: { userId: staffIdentifier },
      select: { id: true },
    });
    return byUserId?.id ?? null;
  }

  const cacheKey = `guild:${guildId}:staff_member:${staffIdentifier}`;
  const cached = await cache.get<{ id?: string; isNotStaff?: boolean }>(cacheKey);
  if (cached) {
    if (cached.isNotStaff) return null;
    return cached.id;
  }

  const byId = await prisma.staffMember.findFirst({
    where: { id: staffIdentifier, guildId },
    select: { id: true },
  });

  if (byId) {
    await cache.set(cacheKey, { id: byId.id }, 300);
    return byId.id;
  }

  const byUserId = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId: staffIdentifier } },
    select: { id: true },
  });

  if (byUserId) {
    await cache.set(cacheKey, { id: byUserId.id }, 300);
    return byUserId.id;
  }

  await cache.set(cacheKey, { isNotStaff: true }, 300);
  return null;
};

const resolveHierarchyMembershipsFromDiscordRoles = async (guildId: string, userId: string) => {
  const client = getClient();
  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return [];

  const discordMember = await discordGuild.members.fetch(userId).catch(() => null);
  if (!discordMember) return [];

  const roleIds = new Set(discordMember.roles.cache.map((role) => role.id));
  if (roleIds.size === 0) return [];

  const staffRoles = await prisma.staffRole.findMany({
    where: {
      guildId,
      enabled: true,
      hierarchyId: { not: null },
      discordRoleId: { not: null },
    },
    orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { hierarchyId: true, name: true, discordRoleId: true },
  });

  const membershipsByHierarchy = new Map<string, string>();
  for (const staffRole of staffRoles) {
    if (!staffRole.hierarchyId || !staffRole.discordRoleId) continue;
    if (!roleIds.has(staffRole.discordRoleId)) continue;
    if (!membershipsByHierarchy.has(staffRole.hierarchyId)) {
      membershipsByHierarchy.set(staffRole.hierarchyId, staffRole.name);
    }
  }

  return [...membershipsByHierarchy.entries()].map(([hierarchyId, grade]) => ({ hierarchyId, grade }));
};

const resolveHierarchyAssignmentForGrade = async (guildId: string, grade: string, hierarchyId?: string | null, hierarchyGrade?: string | null) => {
  const normalizedHierarchyId = hierarchyId?.trim() || null;
  const normalizedHierarchyGrade = hierarchyGrade?.trim() || null;

  if (normalizedHierarchyId && normalizedHierarchyGrade) {
    return { hierarchyId: normalizedHierarchyId, grade: normalizedHierarchyGrade };
  }

  const staffRole = await prisma.staffRole.findFirst({
    where: { guildId, enabled: true, name: grade.trim() },
    select: { hierarchyId: true, name: true },
  });

  if (staffRole?.hierarchyId) {
    return {
      hierarchyId: staffRole.hierarchyId,
      grade: staffRole.name,
    };
  }

  if (normalizedHierarchyId && normalizedHierarchyGrade) {
    return { hierarchyId: normalizedHierarchyId, grade: normalizedHierarchyGrade };
  }

  return null;
};

export const syncStaffHierarchyMembership = async (guildId: string, userId: string) => {
  const [staffMember, memberships] = await Promise.all([
    prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { id: true },
    }),
    resolveHierarchyMembershipsFromDiscordRoles(guildId, userId),
  ]);

  if (!staffMember || memberships.length === 0) {
    return { updated: 0 };
  }

  const existingGrades = await prisma.staffMemberHierarchyGrade.findMany({
    where: { staffMemberId: staffMember.id, hierarchyId: { in: memberships.map((m) => m.hierarchyId) } },
    select: { hierarchyId: true, grade: true },
  });
  const existingGradeMap = new Map(existingGrades.map((g) => [g.hierarchyId, g.grade]));

  const staffRoles = await prisma.staffRole.findMany({
    where: { guildId, enabled: true, hierarchyId: { in: memberships.map((m) => m.hierarchyId) } },
    select: { name: true, hierarchyId: true, level: true },
  });
  const roleLevelMap = new Map(staffRoles.map((r) => [`${r.hierarchyId}:${r.name}`, r.level]));

  let updated = 0;
  await Promise.all(memberships.map(async (membership) => {
    const existingGrade = existingGradeMap.get(membership.hierarchyId);
    if (existingGrade) {
      const existingLevel = roleLevelMap.get(`${membership.hierarchyId}:${existingGrade}`) ?? 0;
      const newLevel = roleLevelMap.get(`${membership.hierarchyId}:${membership.grade}`) ?? 0;
      // Ne pas écraser un grade manuellement défini qui est supérieur au grade Discord
      if (newLevel <= existingLevel) return;
    }

    await upsertHierarchyGradeRow(staffMember.id, membership.hierarchyId, membership.grade);
    updated++;
  }));

  return { updated };
};

/**
 * Récupère plusieurs membres Discord en une seule passe.
 * Sert d'abord le cache local, puis complète les manquants par lots de 100
 * via le gateway (au lieu d'un appel REST par utilisateur).
 */
const fetchGuildMembersByIds = async (guildId: string, userIds: string[]) => {
  const client = getClient();
  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return null;

  const resolved = new Map<string, GuildMember>();
  const missing: string[] = [];

  for (const userId of userIds) {
    const cached = discordGuild.members.cache.get(userId);
    if (cached) resolved.set(userId, cached);
    else missing.push(userId);
  }

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const fetched = await discordGuild.members
      .fetch({ user: chunk, time: 15_000 })
      .catch(() => null);
    if (!fetched) continue;
    for (const [id, member] of fetched) resolved.set(id, member);
  }

  return resolved;
};

export const syncStaffHierarchyMemberships = async (guildId: string) => {
  const [staffMembers, hierarchyRoles] = await Promise.all([
    prisma.staffMember.findMany({
      where: { guildId },
      select: { id: true, userId: true },
    }),
    prisma.staffRole.findMany({
      where: { guildId, enabled: true, hierarchyId: { not: null } },
      orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { hierarchyId: true, name: true, discordRoleId: true, level: true },
    }),
  ]);

  if (staffMembers.length === 0 || hierarchyRoles.length === 0) {
    return { updated: 0, scanned: staffMembers.length };
  }

  const discordMembers = await fetchGuildMembersByIds(guildId, staffMembers.map((m) => m.userId));
  if (!discordMembers || discordMembers.size === 0) {
    return { updated: 0, scanned: staffMembers.length };
  }

  const roleLevelMap = new Map(hierarchyRoles.map((r) => [`${r.hierarchyId}:${r.name}`, r.level]));
  const existingGrades = await prisma.staffMemberHierarchyGrade.findMany({
    where: { staffMemberId: { in: staffMembers.map((m) => m.id) } },
    select: { staffMemberId: true, hierarchyId: true, grade: true },
  });
  const existingGradeMap = new Map(existingGrades.map((g) => [`${g.staffMemberId}:${g.hierarchyId}`, g.grade]));

  const pendingUpserts: { staffMemberId: string; hierarchyId: string; grade: string }[] = [];

  for (const staffMember of staffMembers) {
    const discordMember = discordMembers.get(staffMember.userId);
    if (!discordMember) continue;

    const roleIds = new Set(discordMember.roles.cache.map((role) => role.id));
    if (roleIds.size === 0) continue;

    // hierarchyRoles est déjà trié par niveau décroissant : le premier match gagne.
    const membershipsByHierarchy = new Map<string, string>();
    for (const staffRole of hierarchyRoles) {
      if (!staffRole.hierarchyId || !staffRole.discordRoleId) continue;
      if (!roleIds.has(staffRole.discordRoleId)) continue;
      if (!membershipsByHierarchy.has(staffRole.hierarchyId)) {
        membershipsByHierarchy.set(staffRole.hierarchyId, staffRole.name);
      }
    }

    for (const [hierarchyId, grade] of membershipsByHierarchy) {
      const existingGrade = existingGradeMap.get(`${staffMember.id}:${hierarchyId}`);
      if (existingGrade === grade) continue;
      if (existingGrade) {
        const existingLevel = roleLevelMap.get(`${hierarchyId}:${existingGrade}`) ?? 0;
        const newLevel = roleLevelMap.get(`${hierarchyId}:${grade}`) ?? 0;
        // Ne pas écraser un grade manuellement défini qui est supérieur au grade Discord
        if (newLevel <= existingLevel) continue;
      }
      pendingUpserts.push({ staffMemberId: staffMember.id, hierarchyId, grade });
    }
  }

  if (pendingUpserts.length > 0) {
    for (const entry of pendingUpserts) {
      await upsertHierarchyGradeRow(entry.staffMemberId, entry.hierarchyId, entry.grade);
    }
  }

  return { updated: pendingUpserts.length, scanned: staffMembers.length };
};

const HIERARCHY_SYNC_TTL_SECONDS = 60;
const inFlightHierarchySyncs = new Map<string, Promise<unknown>>();

/**
 * Variante à utiliser sur les routes de lecture : au plus une synchro par minute
 * et par serveur, et une seule exécution simultanée même si plusieurs onglets
 * du dashboard se chargent en même temps.
 */
export const syncStaffHierarchyMembershipsThrottled = async (guildId: string) => {
  const cacheKey = `guild:${guildId}:staff_hierarchy_sync`;
  if (await cache.get<boolean>(cacheKey)) return;

  const inFlight = inFlightHierarchySyncs.get(guildId);
  if (inFlight) {
    await inFlight.catch(() => null);
    return;
  }

  const run = (async () => {
    try {
      await syncStaffHierarchyMemberships(guildId);
      await cache.set(cacheKey, true, HIERARCHY_SYNC_TTL_SECONDS);
    } finally {
      inFlightHierarchySyncs.delete(guildId);
    }
  })();

  inFlightHierarchySyncs.set(guildId, run);
  await run.catch(() => null);
};

export const syncStaffDiscordRoles = async (
  guildId: string,
  userId: string,
  gradeName: string
) => {
  try {
    const client = getClient();
    const [guildConfig, staffRoles, staffMember] = await Promise.all([
      prisma.guild.findUnique({ where: { id: guildId } }),
      prisma.staffRole.findMany({ where: { guildId, enabled: true } }),
      prisma.staffMember.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { suspendedAt: true } })
    ]);

    if (!guildConfig) return;

    // Un membre suspendu ne doit pas récupérer ses rôles par un effet de bord
    // (changement de grade, resynchro) : seule la réintégration les rend.
    if (staffMember?.suspendedAt) {
      logger.info('StaffManagement', `Synchro des rôles ignorée pour ${userId} : membre suspendu`);
      return;
    }

    const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) {
      logger.warn('StaffManagement', `Serveur Discord non trouvé pour la synchro des rôles de ${userId} (Guild ID: ${guildId})`);
      return;
    }

    const discordMember = await discordGuild.members.fetch(userId).catch(() => null);
    if (!discordMember) {
      logger.warn('StaffManagement', `Membre Discord non trouvé pour la synchro des rôles de ${userId} (Guild ID: ${guildId})`);
      return;
    }

    const targetStaffRole = staffRoles.find(r => r.name.toLowerCase() === gradeName.toLowerCase());
    const targetRoleId = targetStaffRole?.discordRoleId;

    // Roles to add
    const rolesToAdd: string[] = [];
    if (targetRoleId) rolesToAdd.push(targetRoleId);
    if (guildConfig.baseStaffRoleId) rolesToAdd.push(guildConfig.baseStaffRoleId);

    // If grade is a test grade (contains 'test' or 'helper' case insensitive), add testStaffRoleId
    const isTestGrade = gradeName.toLowerCase().includes('test') || gradeName.toLowerCase().includes('helper');
    if (isTestGrade && guildConfig.testStaffRoleId) {
      rolesToAdd.push(guildConfig.testStaffRoleId);
    }

    // Roles to remove
    const rolesToRemove: string[] = [];
    
    // Remove other grade-specific roles
    for (const r of staffRoles) {
      if (r.discordRoleId && (!targetRoleId || r.discordRoleId !== targetRoleId)) {
        rolesToRemove.push(r.discordRoleId);
      }
    }

    // If it's not a test grade anymore, remove testStaffRoleId
    if (!isTestGrade && guildConfig.testStaffRoleId) {
      rolesToRemove.push(guildConfig.testStaffRoleId);
    }

    // De retour dans le staff : il n'est plus « ancien staff »
    if (guildConfig.formerStaffRoleId) rolesToRemove.push(guildConfig.formerStaffRoleId);

    // Filter out roles that member already has / doesn't have to avoid unnecessary Discord API calls
    const currentRoleIds = discordMember.roles.cache.map(r => r.id);
    const finalRolesToRemove = rolesToRemove.filter(id => currentRoleIds.includes(id));
    const finalRolesToAdd = rolesToAdd.filter(id => !currentRoleIds.includes(id));

    if (finalRolesToRemove.length > 0) {
      await discordMember.roles.remove(finalRolesToRemove).catch(err => {
        logger.error('StaffManagement', `Erreur retrait rôles pour ${userId}: ${err.message}`);
      });
    }

    if (finalRolesToAdd.length > 0) {
      await discordMember.roles.add(finalRolesToAdd).catch(err => {
        logger.error('StaffManagement', `Erreur ajout rôles pour ${userId}: ${err.message}`);
      });
    }

    logger.success('StaffManagement', `Synchro des rôles Discord réussie pour ${userId} (Grade: ${gradeName})`);
  } catch (err) {
    logger.error('StaffManagement', `Erreur lors de syncStaffDiscordRoles pour ${userId}: ${err instanceof Error ? err.message : err}`);
  }
};

export const addStaffMember = async (
  guildId: string,
  userId: string,
  grade: string,
  userTag?: string,
  username?: string,
  displayName?: string,
  avatarUrl?: string,
  hierarchyId?: string,
  hierarchyGrade?: string
) => {
  const result = await upsertStaffMemberRow(guildId, userId, {
    update: {
      grade,
      userTag,
      username,
      displayName,
      avatarUrl,
      // Réajouter explicitement quelqu'un au staff lève sa suspension.
      suspendedAt: null,
      suspendedReason: null,
      suspendedById: null,
    },
    create: {
      grade,
      userTag,
      username,
      displayName,
      avatarUrl,
    },
  });

  const resolvedHierarchyAssignment = await resolveHierarchyAssignmentForGrade(guildId, grade, hierarchyId, hierarchyGrade);

  // Si le grade global correspond à une hiérarchie, créer/mettre à jour automatiquement le grade hiérarchique
  if (resolvedHierarchyAssignment) {
    await upsertHierarchyGradeRow(result.id, resolvedHierarchyAssignment.hierarchyId, resolvedHierarchyAssignment.grade).catch(() => null);
  }

  // Sync Discord roles in background
  void syncStaffDiscordRoles(guildId, userId, grade).catch(() => null);

  await cache.invalidateGuild(guildId);

  return result;
};


export const updateStaffGrade = async (
  guildId: string,
  userId: string,
  newGrade: string
) => {
  const oldMember = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } }
  });

  const updated = await prisma.staffMember.update({
    where: { guildId_userId: { guildId, userId } },
    data: {
      grade: newGrade,
      currentRoleStartedAt: new Date(),
    },
  });

  // Sync Discord roles in background
  void syncStaffDiscordRoles(guildId, userId, newGrade).catch(() => null);

  if (oldMember && oldMember.grade !== newGrade) {
    // Essayer de déterminer si c'est une promotion ou un downgrade
    // On peut se baser sur les rôles configurés si besoin, mais ici on va faire simple par défaut
    // ou comparer avec une liste de grades connus.
    const gradesHierarchy = ['Modérateur', 'Responsable', 'Manager', 'Admin', 'Administrateur', 'Direction', 'Fondateur'];
    const oldIndex = gradesHierarchy.indexOf(oldMember.grade);
    const newIndex = gradesHierarchy.indexOf(newGrade);

    let title = 'Changement de grade';
    let message = `Votre grade a été mis à jour : **${newGrade}**.`;
    let type: 'ERROR' | 'INFO' | 'WARNING' | 'SUCCESS' | 'CRITICAL' = 'INFO';

    if (oldIndex !== -1 && newIndex !== -1) {
      if (newIndex > oldIndex) {
        title = 'Félicitations pour votre promotion !';
        message = `Vous avez été promu au grade de **${newGrade}**. Félicitations pour votre travail !`;
        type = 'SUCCESS';
      } else if (newIndex < oldIndex) {
        title = 'Rétrogradation de grade';
        message = `Votre grade a été changé pour **${newGrade}**.`;
        type = 'WARNING';
      }
    }

    await notify({
      guildId,
      userId,
      kind: 'staff.grade_changed',
      title,
      message,
      severity: type,
      link: '/profile',
    }).catch(() => null);
  }

  await cache.invalidateGuild(guildId);

  return updated;
};

export const toggleTutorStatus = async (
  guildId: string,
  userId: string
) => {
  const member = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { isTutor: true }
  });

  if (!member) throw new Error('Membre staff introuvable');

  return prisma.staffMember.update({
    where: { guildId_userId: { guildId, userId } },
    data: {
      isTutor: !member.isTutor
    }
  });
};

/**
 * Retire tous les rôles Discord liés au staff (rôle de base, rôle de test et
 * rôles de grade). Utilisé aussi bien par le renvoi que par la suspension : la
 * différence entre les deux est la ligne en base, pas les rôles Discord.
 */
const stripStaffDiscordRoles = async (
  guildId: string,
  userId: string,
  context: string,
  options?: { markFormer?: boolean }
) => {
  try {
    const client = getClient();
    const [guildConfig, staffRoles] = await Promise.all([
      prisma.guild.findUnique({ where: { id: guildId } }),
      prisma.staffRole.findMany({ where: { guildId, enabled: true } })
    ]);

    if (!guildConfig) return;

    const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    const discordMember = await discordGuild.members.fetch(userId).catch(() => null);
    if (!discordMember) return;

    const rolesToRemove: string[] = [];
    if (guildConfig.baseStaffRoleId) rolesToRemove.push(guildConfig.baseStaffRoleId);
    if (guildConfig.testStaffRoleId) rolesToRemove.push(guildConfig.testStaffRoleId);
    for (const r of staffRoles) {
      if (r.discordRoleId) rolesToRemove.push(r.discordRoleId);
    }

    const currentRoleIds = discordMember.roles.cache.map(r => r.id);
    const finalRolesToRemove = rolesToRemove.filter(id => currentRoleIds.includes(id));

    if (finalRolesToRemove.length > 0) {
      await discordMember.roles.remove(finalRolesToRemove).catch(err => {
        logger.error('StaffManagement', `Erreur retrait rôles lors ${context} de ${userId}: ${err.message}`);
      });
    }

    const formerRoleId = guildConfig.formerStaffRoleId;
    if (options?.markFormer && formerRoleId && !currentRoleIds.includes(formerRoleId)) {
      await discordMember.roles.add(formerRoleId).catch(err => {
        logger.error('StaffManagement', `Erreur ajout rôle ancien staff lors ${context} de ${userId}: ${err.message}`);
      });
    }
  } catch (err) {
    logger.error('StaffManagement', `Erreur lors du retrait des rôles de ${userId}: ${err instanceof Error ? err.message : err}`);
  }
};

/**
 * Suspend ou réintègre un membre du staff. La suspension conserve la fiche
 * (grade, ancienneté, avertissements) et se contente de retirer les rôles
 * Discord ; la réintégration les resynchronise sur le grade courant.
 */
export const setStaffSuspension = async (
  guildId: string,
  userId: string,
  suspended: boolean,
  options?: { reason?: string | null; actorUserId?: string | null }
) => {
  const member = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { grade: true, suspendedAt: true }
  });

  if (!member) throw new Error('Membre staff introuvable');

  const alreadyInTargetState = suspended ? !!member.suspendedAt : !member.suspendedAt;

  const updated = await prisma.staffMember.update({
    where: { guildId_userId: { guildId, userId } },
    data: suspended
      ? {
        suspendedAt: member.suspendedAt ?? new Date(),
        suspendedReason: options?.reason?.trim() || null,
        suspendedById: options?.actorUserId ?? null,
      }
      : {
        suspendedAt: null,
        suspendedReason: null,
        suspendedById: null,
      },
  });

  if (suspended) {
    await stripStaffDiscordRoles(guildId, userId, 'de la suspension');
  } else {
    void syncStaffDiscordRoles(guildId, userId, updated.grade).catch(() => null);
  }

  if (!alreadyInTargetState) {
    const reason = options?.reason?.trim();
    await notify({
      guildId,
      userId,
      kind: 'staff.suspension_changed',
      title: suspended ? 'Suspension de vos fonctions staff' : 'Réintégration dans le staff',
      message: suspended
        ? `Vos fonctions staff sont suspendues${reason ? ` : ${reason}` : ''}. Vos rôles Discord staff sont retirés le temps de la suspension.`
        : `Votre suspension est levée : vous retrouvez vos fonctions de **${updated.grade}**.`,
      severity: suspended ? 'WARNING' : 'SUCCESS',
      link: '/profile',
      actorId: options?.actorUserId,
    }).catch(() => null);
  }

  await cache.invalidateGuild(guildId);

  return updated;
};

export const removeStaffMember = async (guildId: string, userId: string) => {
  await stripStaffDiscordRoles(guildId, userId, 'du renvoi', { markFormer: true });

  await cache.invalidateGuild(guildId);

  return prisma.staffMember.delete({
    where: { guildId_userId: { guildId, userId } },
  });
};


export const getStaffMemberStats = async (guildId: string, userId: string) => {
  const resolvedStaffMemberId = await resolveStaffMemberId(guildId, userId);

  if (!resolvedStaffMemberId) {
    return {
      member: null,
      warnings: [],
      activities: [],
      testingPeriods: [],
      stats: {
        totalMessages: 0,
        totalVoiceMinutes: 0,
        activeWarnings: 0,
      },
    };
  }

  const [member, warnings, activities, testingPeriods] = await Promise.all([
    prisma.staffMember.findUnique({ where: { id: resolvedStaffMemberId } }),
    prisma.staffWarning.findMany({
      where: { guildId, staffUserId: resolvedStaffMemberId, isActive: true },
    }),
    prisma.staffActivity.findMany({
      where: { guildId, staffUserId: resolvedStaffMemberId },
      orderBy: { activityDate: 'desc' },
      take: 30,
    }),
    prisma.testingPeriod.findMany({
      where: { guildId, staffUserId: resolvedStaffMemberId },
      include: { 
        reports: { include: { author: true } },
        mentor: true,
        staffMember: true
      },
    }),
  ]);

  const totalMessages = activities.reduce((sum, a) => sum + a.messageCount, 0);
  const totalVoiceMinutes = activities.reduce((sum, a) => sum + a.voiceMinutes, 0);

  return {
    member,
    warnings,
    activities,
    testingPeriods,
    stats: {
      totalMessages,
      totalVoiceMinutes,
      activeWarnings: warnings.length,
    },
  };
};

export const issueStaffWarning = async (
  guildId: string,
  staffUserId: string,
  issuedByUserId: string,
  reason: string,
  expiresAt?: Date
) => {
  const resolvedStaffMemberId = await resolveStaffMemberId(guildId, staffUserId);
  if (!resolvedStaffMemberId) {
    throw new Error('Membre staff introuvable pour cet avertissement');
  }

  const warning = await prisma.staffWarning.create({
    data: {
      guildId,
      staffUserId: resolvedStaffMemberId,
      issuedByUserId,
      reason,
      expiresAt,
    },
  });

  // Notifier le membre
  const member = await prisma.staffMember.findUnique({ where: { id: resolvedStaffMemberId } });
  if (member) {
    await notify({
      guildId,
      userId: member.userId,
      kind: 'staff.warning_received',
      title: 'Nouvel avertissement',
      message: `Vous avez reçu un avertissement pour la raison suivante : ${reason}`,
      severity: 'WARNING',
      link: '/profile',
      actorId: issuedByUserId,
    }).catch(() => null);

    // Notifier le responsable de la hiérarchie et le modérateur qui a sanctionné
    const userIdsToNotify = new Set<string>();
    if (issuedByUserId) {
      userIdsToNotify.add(issuedByUserId);
    }

    const grades = await prisma.staffMemberHierarchyGrade.findMany({
      where: { staffMemberId: member.id },
      include: {
        hierarchy: true
      }
    });

    for (const hGrade of grades) {
      const headUserId = hGrade.hierarchy.responsableUserId;
      if (headUserId) {
        userIdsToNotify.add(headUserId);
      }
    }

    // Éviter de notifier la cible elle-même (elle reçoit déjà son MP ci-dessus)
    userIdsToNotify.delete(member.userId);

    const issuer = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId: issuedByUserId } }
    });
    const issuerTag = issuer?.displayName || issuer?.username || 'Un administrateur';

    await notifyMany(userIdsToNotify, {
      guildId,
      kind: 'staff.warning_issued',
      title: `Avertissement Staff : ${member.displayName || member.username}`,
      message: `${issuerTag} a appliqué un avertissement staff à ${member.displayName || member.username} pour : ${reason}`,
      severity: 'WARNING',
      link: '/staff-management',
      actorId: issuedByUserId,
    });
  }

  return warning;
};

export const blacklistStaff = async (
  guildId: string,
  staffUserId: string,
  issuedByUserId: string,
  reason: string,
  endDate?: Date
) => {
  const linkedUserIds = await altAccountService.getAllLinkedUserIds(guildId, staffUserId);

  const resolveOrCreateBlacklistedStaffMember = async (userId: string) => {
    const resolvedStaffMemberId = await resolveStaffMemberId(guildId, userId);
    if (resolvedStaffMemberId) {
      return resolvedStaffMemberId;
    }

    const client = getClient();
    let username = `User_${userId}`;
    let displayName = `User ${userId}`;
    let avatarUrl = '';

    try {
      const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      if (discordGuild) {
        const member = await discordGuild.members.fetch(userId).catch(() => null);
        if (member) {
          username = member.user.username;
          displayName = member.displayName || member.user.globalName || username;
          avatarUrl = member.user.displayAvatarURL() || '';
        } else {
          const userObj = await client.users.fetch(userId).catch(() => null);
          if (userObj) {
            username = userObj.username;
            displayName = userObj.globalName || username;
            avatarUrl = userObj.displayAvatarURL() || '';
          }
        }
      }
    } catch (err) {
      logger.error('StaffManagement', `Erreur lors de la récupération des infos Discord pour blacklist de ${userId}: ${err}`);
    }

    const newStaff = await prisma.staffMember.create({
      data: {
        guildId,
        userId,
        grade: 'Blacklisted',
        username,
        displayName,
        avatarUrl,
      }
    });

    return newStaff.id;
  };

  const blacklistedStaffMemberIds = await Promise.all(linkedUserIds.map((userId) => resolveOrCreateBlacklistedStaffMember(userId)));

  const primaryStaffMemberId = blacklistedStaffMemberIds[linkedUserIds.indexOf(staffUserId)] ?? await resolveOrCreateBlacklistedStaffMember(staffUserId);

  const blacklist = await prisma.staffBlacklist.create({
    data: {
      guildId,
      staffUserId: primaryStaffMemberId,
      issuedByUserId,
      reason,
      endDate,
    },
  });

  if (blacklistedStaffMemberIds.length > 1) {
    await prisma.staffBlacklist.createMany({
      data: blacklistedStaffMemberIds
        .filter((staffMemberId) => staffMemberId !== primaryStaffMemberId)
        .map((staffMemberId) => ({
          guildId,
          staffUserId: staffMemberId,
          issuedByUserId,
          reason,
          endDate,
        })),
    }).catch(() => null);
  }

  // Retirer les rôles staff sur Discord si l'utilisateur est présent sur le serveur
  try {
    const [guildConfig, staffRoles] = await Promise.all([
      prisma.guild.findUnique({ where: { id: guildId } }),
      prisma.staffRole.findMany({ where: { guildId, enabled: true } })
    ]);
    const client = getClient();
    if (guildConfig) {
      const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      if (discordGuild) {
        const rolesToRemove: string[] = [];
        if (guildConfig.baseStaffRoleId) rolesToRemove.push(guildConfig.baseStaffRoleId);
        if (guildConfig.testStaffRoleId) rolesToRemove.push(guildConfig.testStaffRoleId);
        for (const r of staffRoles) {
          if (r.discordRoleId) rolesToRemove.push(r.discordRoleId);
        }

        for (const userId of linkedUserIds) {
          const discordMember = await discordGuild.members.fetch(userId).catch(() => null);
          if (!discordMember) continue;

          const currentRoleIds = discordMember.roles.cache.map(r => r.id);
          const finalRolesToRemove = rolesToRemove.filter(id => currentRoleIds.includes(id));

          if (finalRolesToRemove.length > 0) {
            await discordMember.roles.remove(finalRolesToRemove).catch((err) => {
              logger.error('StaffManagement', `Erreur retrait rôles Discord post-blacklist pour ${userId}: ${err.message}`);
            });
          }
        }
      }
    }
  } catch (err) {
    logger.error('StaffManagement', `Erreur lors du nettoyage des rôles Discord pour ${staffUserId}: ${err}`);
  }

  // Notifier le membre
  for (const staffMemberId of blacklistedStaffMemberIds) {
    const member = await prisma.staffMember.findUnique({ where: { id: staffMemberId } });
    if (!member) continue;

    await notify({
      guildId,
      userId: member.userId,
      kind: 'staff.blacklisted',
      title: 'Mise en blacklist',
      message: `Vous avez été ajouté à la blacklist staff. Raison : ${reason}`,
      severity: 'ERROR',
      link: '/profile',
    }).catch(() => null);
  }

  return blacklist;
};

export const getActiveBlacklist = async (guildId: string, staffUserId: string) => {
  const resolvedStaffMemberId = await resolveStaffMemberId(guildId, staffUserId);
  if (!resolvedStaffMemberId) {
    return null;
  }

  const now = new Date();
  return prisma.staffBlacklist.findFirst({
    where: {
      guildId,
      staffUserId: resolvedStaffMemberId,
      isActive: true,
      OR: [
        { endDate: { gt: now } },
        { endDate: null },
      ],
    },
  });
};

export const createTestingPeriod = async (
  guildId: string,
  staffUserId: string,
  mentorId?: string,
  plannedDurationDays: number = 14,
  targetGrade?: string,
  hierarchyId?: string
) => {
  const resolvedStaffMemberId = await resolveStaffMemberId(guildId, staffUserId);
  if (!resolvedStaffMemberId) {
    throw new Error('Membre staff introuvable pour la période de test');
  }

  const resolvedMentorId = mentorId ? await resolveStaffMemberId(guildId, mentorId) : null;

  const period = await prisma.testingPeriod.create({
    data: {
      guildId,
      staffUserId: resolvedStaffMemberId,
      mentorId: resolvedMentorId,
      plannedDurationDays,
      targetGrade,
      hierarchyId,
    },
  });

  // Notifier le membre et le mentor
  const [member, mentor] = await Promise.all([
    prisma.staffMember.findUnique({ where: { id: resolvedStaffMemberId } }),
    resolvedMentorId ? prisma.staffMember.findUnique({ where: { id: resolvedMentorId } }) : null
  ]);

  if (member) {
    await notify({
      guildId,
      userId: member.userId,
      kind: 'staff.testing_started',
      title: 'Nouvelle période de test',
      message: `Votre période de test pour le grade ${targetGrade || 'Staff'} a commencé !`,
      link: `/tutoring/${period.id}`,
    }).catch(() => null);
  }

  if (mentor) {
    await notify({
      guildId,
      userId: mentor.userId,
      kind: 'staff.mentor_assigned',
      title: 'Nouveau tutorat',
      message: `Vous avez été assigné comme mentor pour ${member?.username || 'un nouveau staff'}.`,
      link: `/tutoring/${period.id}`,
    }).catch(() => null);
  }

  return period;
};

export const addMentorReport = async (
  testingPeriodId: string,
  authorId: string,
  type: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL',
  content: string
) => {
  const period = await prisma.testingPeriod.findUnique({
    where: { id: testingPeriodId },
    include: { staffMember: true }
  });

  if (!period) {
    throw new Error('Période de test introuvable');
  }

  const resolvedAuthorId = await resolveStaffMemberId(period.guildId, authorId);
  if (!resolvedAuthorId) {
    throw new Error('Auteur introuvable dans le staff');
  }

  const report = await prisma.mentorReport.create({
    data: {
      testingPeriodId,
      authorId: resolvedAuthorId,
      type,
      content,
    },
  });
  // Le prochain point d'étape se compte depuis celui-ci : sans cette date, les
  // rappels partaient toujours du début du tutorat.
  await prisma.testingPeriod.update({ where: { id: testingPeriodId }, data: { lastReportAt: report.createdAt } });

  // Notifier le membre en test
  if (period.staffMember) {
    await notify({
      guildId: period.guildId,
      userId: period.staffMember.userId,
      kind: 'staff.mentor_report',
      title: 'Nouveau point d\'étape',
      message: 'Ton tuteur a posté un point d\'étape sur ton tutorat.',
      severity: type === 'POSITIVE' ? 'SUCCESS' : (type === 'NEGATIVE' ? 'ERROR' : 'INFO'),
      link: `/tutoring/${testingPeriodId}`,
    }).catch(() => null);
  }

  return report;
};

export const endTestingPeriod = async (
  testingPeriodId: string,
  status: 'PASSED' | 'FAILED',
  notes?: string
) => {
  const updated = await prisma.testingPeriod.update({
    where: { id: testingPeriodId },
    data: {
      status,
      endDate: new Date(),
      notes,
    },
    include: { reports: true, staffMember: true },
  });

  if (updated.staffMember) {
    const isPassed = status === 'PASSED';
    await notify({
      guildId: updated.guildId,
      userId: updated.staffMember.userId,
      kind: 'staff.testing_ended',
      title: isPassed ? 'Période de test validée !' : 'Période de test terminée',
      message: isPassed
        ? `Félicitations ! Vous avez validé votre période de test. Bienvenue officiellement dans l'équipe !`
        : `Votre période de test s'est terminée. Un manager reviendra vers vous pour plus de détails.`,
      severity: isPassed ? 'SUCCESS' : 'WARNING',
      link: `/tutoring/${updated.id}`,
    }).catch(() => null);
  }

  return updated;
};

export const getStaffRoles = async (guildId: string) => {
  return prisma.staffRole.findMany({
    where: { guildId, enabled: true },
    orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
};

export const createStaffRole = async (
  guildId: string,
  name: string,
  level: number,
  discordRoleId?: string,
  color?: string,
  hierarchyId?: string,
  isResponsable?: boolean
) => {
  const lastRole = await prisma.staffRole.findFirst({
    where: { guildId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });

  return prisma.staffRole.create({
    data: {
      guildId,
      name,
      level,
      discordRoleId,
      color,
      sortOrder: (lastRole?.sortOrder ?? -1) + 1,
      hierarchyId: hierarchyId ?? null,
      isResponsable: isResponsable ?? false,
    },
  });
};

export const reorderStaffRoles = async (guildId: string, orderedRoleIds: string[]) => {
  const visibleRoles = await prisma.staffRole.findMany({
    where: { guildId, enabled: true },
    select: { id: true },
  });

  const visibleRoleIds = new Set(visibleRoles.map((role) => role.id));
  const normalizedRoleIds = orderedRoleIds.filter((roleId, index, array) => {
    return visibleRoleIds.has(roleId) && array.indexOf(roleId) === index;
  });

  const remainingRoleIds = visibleRoles
    .map((role) => role.id)
    .filter((roleId) => !normalizedRoleIds.includes(roleId));

  const finalRoleIds = [...normalizedRoleIds, ...remainingRoleIds];

  return prisma.$transaction(
    finalRoleIds.map((roleId, index) =>
      prisma.staffRole.update({
        where: { id: roleId },
        data: { sortOrder: index },
      })
    )
  );
};

export const deleteStaffRole = async (guildId: string, roleId: string) => {
  const roleToDelete = await prisma.staffRole.findFirst({
    where: { id: roleId, guildId }
  });
  if (!roleToDelete) return null;

  const deleted = await prisma.staffRole.delete({
    where: { id: roleId }
  });

  // Reorder remaining roles to keep sortOrder contiguous
  const remainingRoles = await prisma.staffRole.findMany({
    where: { guildId },
    orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }]
  });

  await prisma.$transaction(
    remainingRoles.map((role, index) =>
      prisma.staffRole.update({
        where: { id: role.id },
        data: { sortOrder: index }
      })
    )
  );

  return deleted;
};

export const createAPIKey = async (
  guildId: string,
  createdByUserId: string,
  keyHash: string,
  displayKey: string,
  name: string = 'Mon clé API',
  permissions: string[] = ['daily_algo:create_exercise']
) => {
  const resolvedCreatorId = await resolveStaffMemberId(guildId, createdByUserId);
  if (!resolvedCreatorId) {
    throw new Error('Créateur introuvable dans le staff');
  }

  const [, created] = await prisma.$transaction([
    prisma.aPIKey.updateMany({
      where: {
        guildId,
        createdByUserId: resolvedCreatorId,
        isActive: true,
      },
      data: { isActive: false },
    }),
    prisma.aPIKey.create({
      data: {
        guildId,
        createdByUserId: resolvedCreatorId,
        keyHash,
        displayKey,
        name,
        permissions,
      },
    }),
  ]);

  return created;
};

export const getAPIKeys = async (guildId: string, createdByUserId?: string) => {
  let resolvedCreatorId: string | null = null;
  if (createdByUserId) {
    resolvedCreatorId = (await resolveStaffMemberId(guildId, createdByUserId)) ?? null;
    if (!resolvedCreatorId) {
      return [];
    }
  }

  return prisma.aPIKey.findMany({
    where: {
      guildId,
      isActive: true,
      ...(resolvedCreatorId ? { createdByUserId: resolvedCreatorId } : {}),
    },
    select: {
      id: true,
      displayKey: true,
      name: true,
      permissions: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
};

export const deleteAPIKey = async (guildId: string, id: string) => {
  // Filtrée par serveur : une clé d'un autre serveur lève l'erreur « introuvable ».
  return prisma.aPIKey.update({
    where: { id, guildId },
    data: { isActive: false },
  });
};

export const verifyAPIKey = async (keyHash: string, guildId: string) => {
  const key = await prisma.aPIKey.findUnique({
    where: { keyHash },
  });

  if (!key || key.guildId !== guildId || !key.isActive) {
    return null;
  }

  // Mettre à jour lastUsedAt
  await prisma.aPIKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return key;
};

export const recordStaffActivity = async (
  guildId: string,
  staffUserId: string,
  activityDate: Date,
  messageCount: number = 0,
  voiceMinutes: number = 0
) => {
  const resolvedStaffMemberId = await resolveStaffMemberId(guildId, staffUserId);

  // Les activités de non-staff sont ignorées sans erreur.
  if (!resolvedStaffMemberId) {
    return null;
  }

  const dateKey = activityDate.toISOString().split('T')[0];
  const date = new Date(`${dateKey}T00:00:00Z`);

  return prisma.staffActivity.upsert({
    where: {
      guildId_staffUserId_activityDate: {
        guildId,
        staffUserId: resolvedStaffMemberId,
        activityDate: date,
      },
    },
    create: {
      guildId,
      staffUserId: resolvedStaffMemberId,
      activityDate: date,
      messageCount,
      voiceMinutes,
    },
    update: {
      messageCount: { increment: messageCount },
      voiceMinutes: { increment: voiceMinutes },
    },
  });
};

// ============================================================================
// HIÉRARCHIES MULTIPLES - CRUD
// ============================================================================

export const getStaffHierarchies = async (guildId: string) => {
  return prisma.staffHierarchy.findMany({
    where: { guildId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      roles: {
        where: { enabled: true },
        orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }],
      },
      memberGrades: {
        include: { staffMember: { select: { id: true, userId: true, username: true, displayName: true, avatarUrl: true, grade: true } } }
      },
    },
  });
};

export const createStaffHierarchy = async (
  guildId: string,
  name: string,
  description?: string,
  color?: string,
  icon?: string,
  discordRoleId?: string,
  responsableUserId?: string,
  parentHierarchyId?: string | null
) => {
  if (parentHierarchyId) {
    const parentHierarchy = await prisma.staffHierarchy.findFirst({
      where: { id: parentHierarchyId, guildId },
      select: { id: true },
    });

    if (!parentHierarchy) {
      throw new Error('Hiérarchie parente introuvable');
    }
  }

  const lastHierarchy = await prisma.staffHierarchy.findFirst({
    where: { guildId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });

  return prisma.staffHierarchy.create({
    data: {
      guildId,
      name,
      description: description ?? null,
      color: color ?? null,
      icon: icon ?? null,
      discordRoleId: discordRoleId ?? null,
      responsableUserId: responsableUserId ?? null,
      sortOrder: (lastHierarchy?.sortOrder ?? -1) + 1,
      parentHierarchyId: parentHierarchyId ?? null,
    },
    include: {
      roles: { where: { enabled: true }, orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }] },
    },
  });
};

export const updateStaffHierarchy = async (
  guildId: string,
  hierarchyId: string,
  data: {
    name?: string;
    description?: string | null;
    color?: string | null;
    icon?: string | null;
    discordRoleId?: string | null;
    responsableUserId?: string | null;
    parentHierarchyId?: string | null;
    enabled?: boolean;
    sortOrder?: number;
  }
) => {
  // Vérifier que la hiérarchie appartient bien à cette guild
  const hierarchy = await prisma.staffHierarchy.findFirst({
    where: { id: hierarchyId, guildId },
  });
  if (!hierarchy) return null;

  if (data.parentHierarchyId) {
    if (data.parentHierarchyId === hierarchyId) {
      throw new Error("Une hiérarchie ne peut pas être parente d'elle-même");
    }

    const parentHierarchy = await prisma.staffHierarchy.findFirst({
      where: { id: data.parentHierarchyId, guildId },
      select: { id: true },
    });

    if (!parentHierarchy) {
      throw new Error('Hiérarchie parente introuvable');
    }
  }

  const { parentHierarchyId, ...updateData } = data;
  const parentHierarchyRelation = parentHierarchyId === undefined
    ? undefined
    : parentHierarchyId
      ? { connect: { id: parentHierarchyId } }
      : { disconnect: true };

  return prisma.staffHierarchy.update({
    where: { id: hierarchyId },
    data: {
      ...updateData,
      ...(parentHierarchyRelation ? { parentHierarchy: parentHierarchyRelation } : {}),
    },
    include: {
      roles: { where: { enabled: true }, orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }] },
    },
  });
};

export const deleteStaffHierarchy = async (guildId: string, hierarchyId: string) => {
  const hierarchy = await prisma.staffHierarchy.findFirst({
    where: { id: hierarchyId, guildId },
  });
  if (!hierarchy) return null;

  // Les StaffRole liés auront hierarchyId mis à null (onDelete: SetNull)
  // Les StaffMemberHierarchyGrade liés seront supprimés (onDelete: Cascade)
  return prisma.staffHierarchy.delete({ where: { id: hierarchyId } });
};

// ============================================================================
// GRADES PAR HIÉRARCHIE POUR LES MEMBRES
// ============================================================================

export const addMemberToHierarchy = async (
  guildId: string,
  userId: string,
  hierarchyId?: string | null,
  grade?: string | null
) => {
  const normalizedHierarchyId = hierarchyId?.trim() || null;
  const normalizedGrade = grade?.trim() || null;

  // S'assurer que le StaffMember existe
  const staffMember = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
    include: {
      hierarchyGrades: {
        orderBy: { joinedAt: 'asc' },
        include: {
          hierarchy: {
            select: { id: true, name: true, enabled: true },
          },
        },
      },
    },
  });
  if (!staffMember) throw new Error('Membre staff introuvable');

  let resolvedHierarchyId = normalizedHierarchyId;
  let resolvedGrade = normalizedGrade;

  if (!resolvedHierarchyId && staffMember.hierarchyGrades.length > 0) {
    const existingHierarchyGrade = staffMember.hierarchyGrades.find((entry) => entry.hierarchy?.enabled !== false) ?? staffMember.hierarchyGrades[0];
    resolvedHierarchyId = existingHierarchyGrade.hierarchyId;
    resolvedGrade = resolvedGrade ?? existingHierarchyGrade.grade;
  }

  if (resolvedHierarchyId) {
    const hierarchy = await prisma.staffHierarchy.findFirst({
      where: { id: resolvedHierarchyId, guildId },
      select: { id: true },
    });
    if (!hierarchy) throw new Error('Hiérarchie introuvable');

    if (!resolvedGrade) {
      const hierarchyRole = await prisma.staffRole.findFirst({
        where: { guildId, hierarchyId: resolvedHierarchyId, enabled: true },
        orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { name: true },
      });
      resolvedGrade = hierarchyRole?.name ?? null;
    }
  }

  if (!resolvedHierarchyId || !resolvedGrade) {
    const client = getClient();
    const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (discordGuild) {
      const discordMember = await discordGuild.members.fetch(userId).catch(() => null);
      if (discordMember) {
        const roleIds = new Set(discordMember.roles.cache.map((role) => role.id));
        const staffRoles = await prisma.staffRole.findMany({
          where: { guildId, enabled: true, discordRoleId: { not: null } },
          orderBy: [{ level: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { name: true, hierarchyId: true, discordRoleId: true },
        });

        const matchingRole = staffRoles.find((role) => role.discordRoleId && roleIds.has(role.discordRoleId));
        if (matchingRole) {
          resolvedHierarchyId = resolvedHierarchyId ?? matchingRole.hierarchyId ?? null;
          resolvedGrade = resolvedGrade ?? matchingRole.name;
        }
      }
    }
  }

  if (!resolvedHierarchyId || !resolvedGrade) {
    throw new Error('Impossible de détecter automatiquement la hiérarchie ou le grade. Veuillez les renseigner manuellement.');
  }

  return upsertHierarchyGradeRow(staffMember.id, resolvedHierarchyId, resolvedGrade, { hierarchy: true });
};

export const removeMemberFromHierarchy = async (
  guildId: string,
  userId: string,
  hierarchyId: string
) => {
  const staffMember = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
  if (!staffMember) throw new Error('Membre staff introuvable');

  return prisma.staffMemberHierarchyGrade.deleteMany({
    where: { staffMemberId: staffMember.id, hierarchyId },
  });
};

// ============================================================================
// IMPORT DEPUIS DISCORD
// ============================================================================

export const importRoleMembers = async (
  guildId: string,
  hierarchyId: string,
  discordRoleId: string,
  grade: string
) => {
  // Vérifier que la hiérarchie existe
  const hierarchy = await prisma.staffHierarchy.findFirst({
    where: { id: hierarchyId, guildId },
  });
  if (!hierarchy) throw new Error('Hiérarchie introuvable');

  const client = getClient();
  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) throw new Error('Serveur Discord introuvable');

  // Récupérer tous les membres du serveur
  const allMembers = await fetchAllMembers(discordGuild).catch(() => null);
  if (!allMembers) throw new Error('Impossible de récupérer les membres Discord');

  // Filtrer ceux qui ont le rôle cible
  const membersWithRole = allMembers.filter(m => m.roles.cache.has(discordRoleId));

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const [userId, discordMember] of membersWithRole) {
    try {
      // Upsert du StaffMember
      const staffMember = await upsertStaffMemberRow(guildId, userId, {
        update: {
          username: discordMember.user.username,
          displayName: discordMember.displayName || discordMember.user.globalName || discordMember.user.username,
          avatarUrl: resolveMemberAvatarUrl(discordMember, 256) ?? '',
        },
        create: {
          grade,
          username: discordMember.user.username,
          displayName: discordMember.displayName || discordMember.user.globalName || discordMember.user.username,
          avatarUrl: resolveMemberAvatarUrl(discordMember, 256) ?? '',
        },
      });

      // Upsert du grade dans la hiérarchie
      await upsertHierarchyGradeRow(staffMember.id, hierarchyId, grade);

      imported++;
    } catch (err) {
      skipped++;
      errors.push(`${userId}: ${publicErrorMessage(err)}`);
    }
  }

  logger.success('StaffManagement', `Import hiérarchie "${hierarchy.name}": ${imported} importés, ${skipped} erreurs`);

  return { imported, skipped, total: membersWithRole.size, errors };
};

// ============================================================================
// SCHÉMA ORGANIGRAMME
// ============================================================================

export const getHierarchySchema = async (guildId: string) => {
  await syncStaffHierarchyMembershipsThrottled(guildId).catch(() => null);

  const [guild, hierarchies] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { chiefStaffRoleId: true, chiefStaffUserId: true },
    }),
    prisma.staffHierarchy.findMany({
      where: { guildId, enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        roles: {
          where: { enabled: true },
          orderBy: [{ sortOrder: 'asc' }, { level: 'asc' }],
        },
        memberGrades: {
          include: {
            staffMember: {
              select: { userId: true, username: true, displayName: true, avatarUrl: true },
            },
          },
        },
      },
    }),
  ]);

  // Résoudre le nom du Resp Staff global depuis Discord si possible
  let chiefStaffName: string | null = null;
  if (guild?.chiefStaffUserId) {
    const chiefMember = await prisma.staffMember.findFirst({
      where: { guildId, userId: guild.chiefStaffUserId },
      select: { displayName: true, username: true },
    });
    chiefStaffName = chiefMember?.displayName ?? chiefMember?.username ?? null;
  }

  return {
    chiefStaff: guild ? {
      userId: guild.chiefStaffUserId,
      roleId: guild.chiefStaffRoleId,
      name: chiefStaffName,
    } : null,
    hierarchies: hierarchies.map(h => ({
      id: h.id,
      name: h.name,
      description: h.description,
      color: h.color,
      icon: h.icon,
      sortOrder: h.sortOrder,
      parentHierarchyId: h.parentHierarchyId,
      responsable: h.responsableUserId ? {
        userId: h.responsableUserId,
        name: h.memberGrades.find(mg => mg.staffMember.userId === h.responsableUserId)?.staffMember.displayName
          ?? h.memberGrades.find(mg => mg.staffMember.userId === h.responsableUserId)?.staffMember.username
          ?? null,
      } : null,
      roles: h.roles.map(r => ({
        id: r.id,
        name: r.name,
        level: r.level,
        sortOrder: r.sortOrder,
        isResponsable: r.isResponsable,
        discordRoleId: r.discordRoleId,
        color: r.color,
      })),
      memberCount: h.memberGrades.length,
      members: h.memberGrades.map(mg => ({
        userId: mg.staffMember.userId,
        username: mg.staffMember.username,
        displayName: mg.staffMember.displayName,
        avatarUrl: mg.staffMember.avatarUrl,
        grade: mg.grade,
      })),
    })),
  };
};

export const updateStaffRole = async (
  guildId: string,
  roleId: string,
  data: {
    name?: string;
    level?: number;
    discordRoleId?: string | null;
    color?: string | null;
    hierarchyId?: string | null;
    isResponsable?: boolean;
    sortOrder?: number;
  }
) => {
  const role = await prisma.staffRole.findFirst({
    where: { id: roleId, guildId },
  });
  if (!role) return null;

  return prisma.staffRole.update({
    where: { id: roleId },
    data,
  });
};


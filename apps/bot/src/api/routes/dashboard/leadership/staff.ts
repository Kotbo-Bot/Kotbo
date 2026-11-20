import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { errorMessage } from '../../../../utils/errors.js';
import prisma from '../../../../utils/db.js';
import { resolveMemberAvatarUrl } from '../../../../services/moderation/memberIdentityService.js';
import { logger } from '../../../../utils/logger.js';
import { COLORS } from '../../../../utils/embeds.js';
import { getGuildName, pushAudit, safePushAudit, extractDiscordSnowflake, describeUnknownError, resolveFeatureAccessMap } from '../../../shared.js';
import {
  getStaffAlertsAndProgression,
  
  
  
  
  
  
  
  
  
  
  

  getPolls,
  createPoll,
  castPollVote,
  deleteManagerNote,
  getManagerNotes,
  createManagerNote,
  
  
  
  
  
  
  
  
  
  
  
} from '../../../../services/staff/staffLeadershipService.js';
import { notify, notifyMany } from '../../../../services/notifications/notifyService.js';
import {
  getStaffMember,
  addStaffMember,
  toggleTutorStatus,
  updateStaffGrade,
  removeStaffMember,
  setStaffSuspension,
  getStaffMemberStats,
  issueStaffWarning,
  blacklistStaff,
  createTestingPeriod,
  
  
  getStaffRoles,
  createStaffRole,
  reorderStaffRoles,
  deleteStaffRole,
  updateStaffRole,
  
  
  
  
  
  getStaffHierarchies,
  createStaffHierarchy,
  updateStaffHierarchy,
  deleteStaffHierarchy,
  getHierarchySchema,
  addMemberToHierarchy,
  removeMemberFromHierarchy,
  syncStaffHierarchyMembershipsThrottled,
  importRoleMembers,
} from '../../../../services/staff/staffManagementService.js';
import * as altAccountService from '../../../../services/moderation/altAccountService.js';
import { canViewFeatureSection } from '../featureGate.js';
import { type OverwriteResolvable, Client, ChannelType, PermissionFlagsBits, EmbedBuilder, TextChannel } from 'discord.js';

import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { deleteStaffListPanel, saveStaffListPanel } from '../../../../services/staff/staffListPanelService.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';
export function createStaffRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const staffAccess = createMiddleware(async (c, next) => {
    const access = c.var.effectiveAccess;
    const isModerator = access.level === 'admin' || access.level === 'moderator';
    if (!isModerator) return send(c, { error: 'Accès modérateur requis' }, 403);

    const method = c.req.method;
    // Sous-section visée : le segment qui suit `/staff/`.
    const [section, sub] = c.req.path.split('/staff/')[1]?.split('/') ?? [];
    const isMentorReportPost = section === 'mentor-reports' && method === 'POST';
    // La route verifie elle-meme que la personne fait partie du staff.
    const isOwnResignationPost = section === 'resignations' && !sub && method === 'POST';
    if (method !== 'GET' && !isMentorReportPost && !isOwnResignationPost) {
      let hasConfigurePermission = access.level === 'admin';

      if (!hasConfigurePermission) {
        const guildId = c.req.param('guildId')!;
        const userId = c.var.dashboardUser.userId;
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        const member = discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
        const roleIds = member ? Array.from(member.roles.cache.keys()) : [];
        const featureAccess = await resolveFeatureAccessMap(client, guildId, access, userId, roleIds);

        // La matrice des acces separe « Configurer » de « Supprimer » : une
        // requete qui efface demande le second droit, les autres le premier.
        const right = (feature?: { canConfigure: boolean; canDelete: boolean }) =>
          !!(method === 'DELETE' ? feature?.canDelete : feature?.canConfigure);

        if (section === 'roles') {
          hasConfigurePermission = right(featureAccess.staff_roles);
        } else if (section === 'members' || section === 'list-panels') {
          hasConfigurePermission = right(featureAccess.staff_directory);
        } else if (section === 'warnings') {
          hasConfigurePermission = right(featureAccess.discipline);
        } else if (section === 'blacklist') {
          hasConfigurePermission = right(featureAccess.discipline);
        } else if (section === 'config') {
          hasConfigurePermission = right(featureAccess.staff_roles) || right(featureAccess.staff_directory);
        } else if (section === 'hierarchies') {
          hasConfigurePermission = right(featureAccess.staff_roles);
        }
      }

      if (!hasConfigurePermission) {
        return send(c, {
          error: method === 'DELETE'
            ? 'Accès administrateur ou permission de suppression requise'
            : 'Accès administrateur ou permission de configuration requise',
        }, 403);
      }
    }
    await next();
  });
  const gate = [...guildRoute(client), staffAccess] as const;

  /**
   * Le niveau `moderator` couvre tout le staff, jusqu'au plus bas grade, et
   * la garde laisse ce segment ouvert parce que Reunions, Planning et
   * Tutorat y lisent l'effectif. Les lectures qui portent une section
   * precise la reverifient donc ici.
   */
  const helpers = (c: Context) => ({
    canView: (featureKey: string) =>
      canViewFeatureSection(client, c.req.param('guildId')!, c.var.effectiveAccess, c.var.dashboardUser.userId, featureKey),
    denySection: () => send(c, { error: 'Accès refusé. Votre rôle ne donne pas accès à cette section.', code: 'feature_denied' }, 403),
  });

  // Panneaux « liste du staff » : GET|POST /staff/list-panels, PATCH|DELETE /staff/list-panels/:id
  const listPanelFailure = (c: Context, err: unknown) => {
    logger.error('StaffAPI', 'Error on staff list panel:', err);
    return fail(c, err, 'Erreur sur le panneau de la liste du staff', 'StaffAPI');
  };
  router.get(`${base}/staff/list-panels`, ...gate, async (c) => {
    try {
      return send(c, { panels: await prisma.staffListPanel.findMany({ where: { guildId: c.req.param('guildId') }, orderBy: { createdAt: 'asc' } }) });
    } catch (err) {
      return listPanelFailure(c, err);
    }
  });
  router.post(`${base}/staff/list-panels`, ...gate, async (c) => {
    try {
      return send(c, { panel: await saveStaffListPanel(c.req.param('guildId'), (await readBody(c)) ?? {}) }, 201);
    } catch (err) {
      return listPanelFailure(c, err);
    }
  });
  router.patch(`${base}/staff/list-panels/:panelId`, ...gate, async (c) => {
    try {
      return send(c, { panel: await saveStaffListPanel(c.req.param('guildId'), (await readBody(c)) ?? {}, c.req.param('panelId')) });
    } catch (err) {
      return listPanelFailure(c, err);
    }
  });
  router.delete(`${base}/staff/list-panels/:panelId`, ...gate, async (c) => {
    try {
      const deleted = await deleteStaffListPanel(c.req.param('guildId'), c.req.param('panelId'));
      return deleted ? send(c, { ok: true }) : send(c, { error: 'Panneau introuvable' }, 404);
    } catch (err) {
      return listPanelFailure(c, err);
    }
  });


  router.get(`${base}/staff/alerts`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const { canView, denySection } = helpers(c);
    if (!(await canView('staff_directory'))) return denySection();
    try {
      const metrics = await getStaffAlertsAndProgression(guildId);
      return send(c, { metrics });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting staff alerts:', err);
      return fail(c, err, 'Erreur lors de la récupération des alertes', 'StaffAPI');
    }
  });

  router.get(`${base}/staff/discord-members`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const rawQuery = (c.req.query('q') ?? c.req.query('query') ?? '').trim();
      const staffOnly = (c.req.query('staffOnly') ?? null) === 'true';
      const parsedLimit = Number(c.req.query('limit') ?? '12');
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(25, Math.max(1, Math.trunc(parsedLimit)))
        : 12;

      const discordGuild = client.guilds.cache.get(guildId)
        ?? await client.guilds.fetch(guildId).catch(() => null);

      if (!discordGuild) {
        return send(c, { error: 'Serveur Discord introuvable' }, 404);
      }

      const mentionMatch = rawQuery.match(/<@!?(\d{15,25})>/);
      const directId = mentionMatch?.[1] ?? (/^\d{15,25}$/.test(rawQuery) ? rawQuery : null);

      let candidates = [] as Array<{
        id: string;
        username: string;
        displayName: string | null;
        userTag: string | null;
        avatarUrl: string | null;
        roleIds: string[];
      }>;

      if (directId) {
        const member = await discordGuild.members.fetch(directId).catch(() => null);
        if (member && !member.user.bot) {
          candidates = [{
            id: member.user.id,
            username: member.user.username,
            displayName: member.displayName ?? null,
            userTag: member.user.tag ?? null,
            avatarUrl: resolveMemberAvatarUrl(member, 256),
            roleIds: member.roles.cache
              .map((role) => role.id)
              .filter((roleId) => roleId !== discordGuild.roles.everyone.id),
          }];
        }
      } else if (rawQuery) {
        const query = rawQuery.replace(/^@+/, '').trim();
        const members = await discordGuild.members.search({ query, limit }).catch(() => null);

        candidates = members
          ? members
            .filter((member) => !member.user.bot)
            .map((member) => ({
              id: member.user.id,
              username: member.user.username,
              displayName: member.displayName ?? null,
              userTag: member.user.tag ?? null,
              avatarUrl: resolveMemberAvatarUrl(member, 256),
              roleIds: member.roles.cache
                .map((role) => role.id)
                .filter((roleId) => roleId !== discordGuild.roles.everyone.id),
            }))
          : [];
      }

      if (staffOnly) {
        const staffMembers = await prisma.staffMember.findMany({
          where: { guildId },
          select: { userId: true }
        });
        const staffUserIds = new Set(staffMembers.map(m => m.userId));
        candidates = candidates.filter(c => staffUserIds.has(c.id));
      }

      const members = candidates
        .sort((a, b) => (a.displayName || a.username).localeCompare((b.displayName || b.username), 'fr'))
        .slice(0, limit);

      return send(c, { members });
    } catch (err) {
      logger.error('StaffAPI', 'Error searching Discord members:', err);
      return fail(c, err, 'Erreur lors de la recherche des membres Discord', 'StaffAPI');
    }
  });

  router.get(`${base}/staff/members`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const { canView } = helpers(c);
    try {
      await syncStaffHierarchyMembershipsThrottled(guildId).catch(() => null);

      const members = await prisma.staffMember.findMany({
        where: { guildId },
        include: {
          warnings: { where: { isActive: true } },
          blacklistEntries: { where: { isActive: true } },
          testingPeriods: { where: { status: 'ONGOING' } },
          hierarchyGrades: { include: { hierarchy: true } },
        },
        orderBy: { grade: 'asc' },
      });

      // Absences et Planning ne regardent que la presence d'une blacklist
      // ou d'une periode d'essai pour filtrer l'effectif : sans le droit,
      // on garde cette presence et on retire le motif et le detail.
      const [seesDiscipline, seesTutoring] = await Promise.all([canView('discipline'), canView('tutoring')]);
      return send(c, {
        members: members.map((member) => ({
          ...member,
          warnings: seesDiscipline ? member.warnings : [],
          blacklistEntries: seesDiscipline
            ? member.blacklistEntries
            : member.blacklistEntries.map((entry) => ({ id: entry.id, isActive: entry.isActive })),
          testingPeriods: seesTutoring
            ? member.testingPeriods
            : member.testingPeriods.map((period) => ({ id: period.id, status: period.status })),
        })),
      });
    } catch (err) {
      logger.error('StaffAPI', 'Error listing staff members:', err);
      return fail(c, err, 'Erreur lors de la récupération des membres staff', 'StaffAPI');
    }
  });

  router.post(`${base}/staff/members`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        userId: string;
        grade: string;
        userTag?: string;
        username?: string;
        displayName?: string;
        avatarUrl?: string;
        createTestingPeriod?: boolean;
      }>(c);

      if (!body?.userId || !body?.grade) {
        return send(c, { error: 'userId et grade sont obligatoires' }, 400);
      }

      const member = await addStaffMember(
        guildId,
        body.userId,
        String(body.grade),
        body.userTag,
        body.username,
        body.displayName,
        body.avatarUrl,
      );

      if (body.createTestingPeriod !== false) {
        await createTestingPeriod(guildId, body.userId, undefined, undefined, body.grade);
      }

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Ajout membre staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Nouveau membre staff: ${body.username || body.userId} (${body.grade}) (Tutorat: ${body.createTestingPeriod !== false ? 'OUI' : 'NON'})`,
        channelId: null
      });

      return send(c, { member }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error adding staff member:', err);
      return fail(c, err, "Erreur lors de l'ajout du membre staff", 'StaffAPI');
    }
  });

  router.get(`${base}/staff/members/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const userId = c.req.param('userId');
    const { canView, denySection } = helpers(c);
    const staffUserId = userId;
    const isSelf = staffUserId === user.userId;
    if (!isSelf && !(await canView('staff_directory'))) return denySection();
    try {
      const stats = await getStaffMemberStats(guildId, staffUserId);
      const [seesDiscipline, seesTutoring] = isSelf
        ? [true, true]
        : await Promise.all([canView('discipline'), canView('tutoring')]);
      return send(c, {
        ...stats,
        warnings: seesDiscipline ? stats.warnings : [],
        testingPeriods: seesTutoring ? stats.testingPeriods : [],
        stats: { ...stats.stats, activeWarnings: seesDiscipline ? stats.stats.activeWarnings : 0 },
      });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting staff member details:', err);
      return fail(c, err, 'Erreur lors de la récupération des détails', 'StaffAPI');
    }
  });

  router.get(`${base}/staff/members/:userId/scorecard`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const userId = c.req.param('userId');
    const { canView, denySection } = helpers(c);
    const staffUserId = userId;
    // Seule la page profil l'appelle : meme regle que le profil staff d'un collegue.
    if (staffUserId !== user.userId && !(await canView('staff_directory'))) return denySection();
    try {
      const { getStaffWeeklyScorecard } = await import('../../../../services/staff/staffScorecardService.js');
      const scorecard = await getStaffWeeklyScorecard(guildId, staffUserId);
      if (!scorecard) {
        return send(c, { error: 'Staff member not found or no activity records.' }, 404);
      }
      return send(c, { scorecard });
    } catch (err) {
      logger.error('StaffAPI', `Error getting staff scorecard for user ${staffUserId}:`, err);
      return fail(c, err, 'Erreur lors de la récupération du scorecard d\'activité', 'StaffAPI');
    }
  });

  router.patch(`${base}/staff/members/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const userId = c.req.param('userId');
    const staffUserId = userId;
    try {
      const body = await readBody<{
        grade?: string;
        action?: string;
        reason?: string;
      }>(c);

      if (body?.grade) {
        await updateStaffGrade(guildId, staffUserId, String(body.grade));

        await pushAudit(guildId, {
          user: user.username ?? `User${user.userId}`,
          action: 'Changement de grade staff',
          context: getGuildName(client, guildId),
          module: 'Staff Management',
          eventType: 'Manuel',
          details: `Grade changé pour ${staffUserId}: ${body.grade}`,
          channelId: null
        });
      }

      if (body?.action === 'suspend' || body?.action === 'unsuspend') {
        const suspended = body.action === 'suspend';
        await setStaffSuspension(guildId, staffUserId, suspended, {
          reason: body?.reason ?? null,
          actorUserId: user.userId,
        });

        await pushAudit(guildId, {
          user: user.username ?? `User${user.userId}`,
          action: suspended ? 'Suspension membre staff' : 'Réintégration membre staff',
          context: getGuildName(client, guildId),
          module: 'Staff Management',
          eventType: 'Manuel',
          details: suspended
            ? `Membre staff suspendu: ${staffUserId}${body?.reason ? ` (Raison: ${body.reason})` : ''}`
            : `Suspension levée pour: ${staffUserId}`,
          channelId: null
        });
      }

      if (body?.action === 'remove') {
        await removeStaffMember(guildId, staffUserId);

        await pushAudit(guildId, {
          user: user.username ?? `User${user.userId}`,
          action: 'Retrait member staff',
          context: getGuildName(client, guildId),
          module: 'Staff Management',
          eventType: 'Manuel',
          details: `Membre staff retiré: ${staffUserId}`,
          channelId: null
        });
      }

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error updating staff member:', err);
      return fail(c, err, 'Erreur lors de la mise à jour du membre staff', 'StaffAPI');
    }
  });

  router.post(`${base}/staff/members/:userId/tutor`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const userId = c.req.param('userId');
    const staffUserId = userId;
    try {
      const member = await toggleTutorStatus(guildId, staffUserId);

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: member.isTutor ? 'Activation tuteur' : 'Désactivation tuteur',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Statut tuteur modifié pour ${staffUserId}: ${member.isTutor ? 'ON' : 'OFF'}`,
        channelId: null
      });

      return send(c, { member });
    } catch (err) {
      logger.error('StaffAPI', 'Error toggling tutor status:', err);
      return fail(c, err, 'Erreur lors de la modification du statut tuteur', 'StaffAPI');
    }
  });

  router.get(`${base}/staff/:staffUserId{[0-9]+}/notes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const { denySection } = helpers(c);
        const staffUserId = c.req.param('staffUserId');
        // Ecrire et effacer une note demandent deja ce droit : la lecture etait
        // ouverte a tout le staff, la personne visee comprise.
        if (!access.canManageSettings) return denySection();
        try {
          const notes = await getManagerNotes(guildId, staffUserId);
          return send(c, { notes });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting manager notes:', err);
          return fail(c, err, 'Erreur lors de la récupération des notes', 'StaffAPI');
        }
  });

  router.post(`${base}/staff/:staffUserId{[0-9]+}/notes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
        const staffUserId = c.req.param('staffUserId');
        try {
          const body = await readBody<{ content: string }>(c);

          if (!body?.content) {
            return send(c, { error: 'Le contenu de la note est requis' }, 400);
          }
          const note = await createManagerNote(guildId, staffUserId, user.userId, body.content);

          await pushAudit(guildId, {
            user: user.username ?? `User${user.userId}`,
            action: 'Ajout note manager',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Note ajoutée pour le membre ${staffUserId}`,
            channelId: null
          });

          return send(c, { note }, 201);
        } catch (err) {
          logger.error('StaffAPI', 'Error creating manager note:', err);
          return fail(c, err, 'Erreur lors de la création de la note', 'StaffAPI');
        }
  });

  router.delete(`${base}/staff/:staffUserId{[0-9]+}/notes/:noteId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
        const noteId = c.req.param('noteId');
        try {
          await deleteManagerNote(guildId, noteId);

          await pushAudit(guildId, {
            user: user.username ?? `User${user.userId}`,
            action: 'Suppression note manager',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Note supprimée: ${noteId}`,
            channelId: null
          });

          return send(c, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error deleting manager note:', err);
          return fail(c, err, 'Erreur lors de la suppression de la note', 'StaffAPI');
        }
  });

  router.get(`${base}/staff/warnings`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const { canView, denySection } = helpers(c);
    if (!(await canView('discipline'))) return denySection();
    try {
      const warnings = await prisma.staffWarning.findMany({
        where: { guildId },
        include: { staffMember: true },
        orderBy: { createdAt: 'desc' },
      });

      const formattedWarnings = await Promise.all(warnings.map(async (w) => {
        const issuedBy = await client.users.fetch(w.issuedByUserId).catch(() => null);
        return {
          id: w.id,
          staffUserId: w.staffMember.userId,
          staffDisplayName: w.staffMember.displayName || w.staffMember.username,
          staffAvatarUrl: w.staffMember.avatarUrl,
          reason: w.reason,
          issuedByTag: issuedBy?.tag || w.issuedByUserId,
          createdAt: w.createdAt.toISOString(),
          expiresAt: w.expiresAt?.toISOString() || null,
          isActive: w.isActive,
        };
      }));

      return send(c, { warnings: formattedWarnings });
    } catch (err) {
      logger.error('StaffAPI', 'Error fetching staff warnings:', err);
      return fail(c, err, 'Erreur lors de la récupération des avertissements staff', 'StaffAPI');
    }
  });

  router.post(`${base}/staff/warnings`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        staffUserId: string;
        reason: string;
        expiresAt?: string;
      }>(c);

      if (!body?.staffUserId || !body?.reason) {
        return send(c, { error: 'staffUserId et reason sont obligatoires' }, 400);
      }

      const warning = await issueStaffWarning(
        guildId,
        body.staffUserId,
        user.userId,
        body.reason,
        body.expiresAt ? new Date(body.expiresAt) : undefined
      );

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Avertissement staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Avertissement généré: ${body.reason}`,
        channelId: null
      });

      return send(c, { warning }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error issuing warning:', err);
      return fail(c, err, "Erreur lors de la génération de l'avertissement", 'StaffAPI');
    }
  });

  router.delete(`${base}/staff/warnings/:warningId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const warningId = c.req.param('warningId');
    try {
      const warning = await prisma.staffWarning.findFirst({
        where: { id: warningId, guildId },
        include: { staffMember: true }
      });

      if (!warning) {
        return send(c, { error: 'Avertissement introuvable' }, 404);
      }

      await prisma.staffWarning.delete({
        where: { id: warningId },
      });

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Suppression avertissement staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Avertissement supprimé pour ${warning.staffMember.username || warning.staffMember.userId}: ${warning.reason}`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error deleting staff warning:', err);
      return fail(c, err, "Erreur lors de la suppression de l'avertissement", 'StaffAPI');
    }
  });

  router.post(`${base}/staff/blacklist`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        staffUserId: string;
        reason: string;
        endDate?: string;
      }>(c);

      if (!body?.staffUserId || !body?.reason) {
        return send(c, { error: 'staffUserId et reason sont obligatoires' }, 400);
      }

      const blacklist = await blacklistStaff(
        guildId,
        body.staffUserId,
        user.userId,
        body.reason,
        body.endDate ? new Date(body.endDate) : undefined
      );

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Blacklist staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Blacklist appliquée: ${body.reason}`,
        channelId: null
      });

      return send(c, { blacklist }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error blacklisting staff:', err);
      return fail(c, err, 'Erreur lors de la blacklist', 'StaffAPI');
    }
  });

  router.delete(`${base}/staff/blacklist/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const userId = c.req.param('userId');
    const targetUserId = userId;
    try {
      const linkedUserIds = await altAccountService.getAllLinkedUserIds(guildId, targetUserId);
      const members = await prisma.staffMember.findMany({
        where: { guildId, userId: { in: linkedUserIds } }
      });

      if (members.length === 0) {
        return send(c, { error: 'Membre staff introuvable' }, 404);
      }

      await prisma.staffBlacklist.updateMany({
        where: {
          guildId,
          staffUserId: { in: members.map((member) => member.id) },
          isActive: true
        },
        data: {
          isActive: false
        }
      });

      await Promise.all(
        members
          .filter((member) => member.grade === 'Blacklisted')
          .map((member) => prisma.staffMember.delete({ where: { id: member.id } }).catch(() => null))
      );

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Retrait blacklist staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Blacklist retirée pour ${members.map((member) => member.username || member.userId).join(', ')}`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error removing from staff blacklist:', err);
      return fail(c, err, 'Erreur lors du retrait de la blacklist', 'StaffAPI');
    }
  });

  router.get(`${base}/staff/roles`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const roles = await getStaffRoles(guildId);
      return send(c, { roles });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting staff roles:', err);
      return fail(c, err, 'Erreur lors de la récupération des rôles staff', 'StaffAPI');
    }
  });

  router.post(`${base}/staff/roles`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        name: string;
        level: number;
        discordRoleId?: string;
        color?: string;
        hierarchyId?: string;
        isResponsable?: boolean;
      }>(c);

      if (!body?.name || typeof body?.level !== 'number') {
        return send(c, { error: 'name et level sont obligatoires' }, 400);
      }

      const role = await createStaffRole(
        guildId,
        body.name,
        body.level,
        body.discordRoleId,
        body.color,
        body.hierarchyId,
        body.isResponsable
      );

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Création rôle staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Nouveau rôle staff: ${body.name}`,
        channelId: null
      });

      return send(c, { role }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error creating staff role:', err);
      return fail(c, err, 'Erreur lors de la création du rôle staff', 'StaffAPI');
    }
  });

  router.patch(`${base}/staff/roles/order`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        orderedRoleIds: string[];
      }>(c);

      if (!Array.isArray(body?.orderedRoleIds)) {
        return send(c, { error: 'orderedRoleIds doit être un tableau' }, 400);
      }

      await reorderStaffRoles(guildId, body.orderedRoleIds);

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Réorganisation rôles staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Ordre mis à jour pour ${body.orderedRoleIds.length} rôle(s)`,
        channelId: null
      });

      return send(c, { success: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error reordering staff roles:', err);
      return fail(c, err, 'Erreur lors du réordonnancement des rôles staff', 'StaffAPI');
    }
  });

  router.patch(`${base}/staff/roles/:roleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const roleId = c.req.param('roleId');
    try {
      const body = await readBody<{
        name?: string;
        level?: number;
        discordRoleId?: string | null;
        color?: string | null;
        hierarchyId?: string | null;
        isResponsable?: boolean;
        sortOrder?: number;
      }>(c);

      const updated = await updateStaffRole(guildId, roleId, body ?? {});
      if (!updated) {
        return send(c, { error: 'Rôle staff introuvable' }, 404);
      }

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Modification rôle staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Rôle staff modifié: ${updated.name} (Hiérarchie: ${updated.hierarchyId ?? 'aucune'})`,
        channelId: null
      });

      return send(c, { role: updated });
    } catch (err) {
      logger.error('StaffAPI', 'Error updating staff role:', err);
      return fail(c, err, 'Erreur lors de la modification du rôle staff', 'StaffAPI');
    }
  });

  router.delete(`${base}/staff/roles/:roleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const roleId = c.req.param('roleId');
    try {
      const deleted = await deleteStaffRole(guildId, roleId);
      if (!deleted) {
        return send(c, { error: 'Rôle staff introuvable' }, 404);
      }

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Suppression rôle staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Rôle staff supprimé: ${deleted.name} (${roleId})`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error deleting staff role:', err);
      return fail(c, err, 'Erreur lors de la suppression du rôle staff', 'StaffAPI');
    }
  });

  router.get(`${base}/staff/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const guild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          baseStaffRoleId: true,
          testStaffRoleId: true,
          formerStaffRoleId: true,
          chiefStaffRoleId: true,
          chiefStaffUserId: true,
          meetingAnnouncementChannelId: true,
          meetingVoiceChannelId: true,
          staffAnnouncementChannelId: true,
          warnsToDemote: true,
          warnsToBlacklist: true,
          blacklistPermanentByDefault: true,
          actionMode: true,
          demoteRemoveAllRoles: true,
        },
      });

      if (!guild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }

      return send(c, { config: guild });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting staff config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration staff', 'StaffAPI');
    }
  });

  router.patch(`${base}/staff/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        baseStaffRoleId?: string | null;
        testStaffRoleId?: string | null;
        formerStaffRoleId?: string | null;
        chiefStaffRoleId?: string | null;
        chiefStaffUserId?: string | null;
        meetingAnnouncementChannelId?: string | null;
        meetingVoiceChannelId?: string | null;
        staffAnnouncementChannelId?: string | null;
        warnsToDemote?: number;
        warnsToBlacklist?: number;
        blacklistPermanentByDefault?: boolean;
        actionMode?: string;
        demoteRemoveAllRoles?: boolean;
      }>(c);

      const data: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'baseStaffRoleId')) {
        data.baseStaffRoleId = extractDiscordSnowflake(body?.baseStaffRoleId ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'testStaffRoleId')) {
        data.testStaffRoleId = extractDiscordSnowflake(body?.testStaffRoleId ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'formerStaffRoleId')) {
        data.formerStaffRoleId = extractDiscordSnowflake(body?.formerStaffRoleId ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'chiefStaffRoleId')) {
        data.chiefStaffRoleId = extractDiscordSnowflake(body?.chiefStaffRoleId ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'chiefStaffUserId')) {
        data.chiefStaffUserId = extractDiscordSnowflake(body?.chiefStaffUserId ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'meetingAnnouncementChannelId')) {
        data.meetingAnnouncementChannelId = extractDiscordSnowflake(body?.meetingAnnouncementChannelId ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'meetingVoiceChannelId')) {
        data.meetingVoiceChannelId = extractDiscordSnowflake(body?.meetingVoiceChannelId ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'staffAnnouncementChannelId')) {
        data.staffAnnouncementChannelId = extractDiscordSnowflake(body?.staffAnnouncementChannelId ?? null);
      }

      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'warnsToDemote')) {
        data.warnsToDemote = Number(body?.warnsToDemote) || 0;
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'warnsToBlacklist')) {
        data.warnsToBlacklist = Number(body?.warnsToBlacklist) || 0;
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'blacklistPermanentByDefault')) {
        data.blacklistPermanentByDefault = !!body?.blacklistPermanentByDefault;
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'actionMode')) {
        data.actionMode = body?.actionMode || 'MANUAL';
      }
      if (Object.prototype.hasOwnProperty.call(body ?? {}, 'demoteRemoveAllRoles')) {
        data.demoteRemoveAllRoles = !!body?.demoteRemoveAllRoles;
      }

      const updatedGuild = await prisma.guild.update({
        where: { id: guildId },
        data,
        select: {
          baseStaffRoleId: true,
          testStaffRoleId: true,
          formerStaffRoleId: true,
          chiefStaffRoleId: true,
          chiefStaffUserId: true,
          meetingAnnouncementChannelId: true,
          meetingVoiceChannelId: true,
          staffAnnouncementChannelId: true,
          warnsToDemote: true,
          warnsToBlacklist: true,
          blacklistPermanentByDefault: true,
          actionMode: true,
          demoteRemoveAllRoles: true,
        },
      });

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Mise à jour config staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Configuration staff mise à jour (Rôles: ${updatedGuild.baseStaffRoleId ?? 'aucun'}/${updatedGuild.testStaffRoleId ?? 'aucun'}, Sanctions: ${updatedGuild.warnsToDemote} warns p. démo / ${updatedGuild.warnsToBlacklist} warns p. bl, Mode: ${updatedGuild.actionMode})`,
        channelId: null,
      });

      return send(c, { config: updatedGuild });
    } catch (err) {
      logger.error('StaffAPI', 'Error updating staff config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration staff', 'StaffAPI');
    }
  });

  router.get(`${base}/staff/hierarchies`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const hierarchies = await getStaffHierarchies(guildId);
      return send(c, { hierarchies });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting staff hierarchies:', err);
      return fail(c, err, 'Erreur lors de la récupération des hiérarchies staff', 'StaffAPI');
    }
  });

  router.post(`${base}/staff/hierarchies`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        name: string;
        description?: string;
        color?: string;
        icon?: string;
        discordRoleId?: string;
        responsableUserId?: string;
        parentHierarchyId?: string | null;
      }>(c);

      if (!body?.name) {
        return send(c, { error: 'name est obligatoire' }, 400);
      }

      const hierarchy = await createStaffHierarchy(
        guildId,
        body.name,
        body.description,
        body.color,
        body.icon,
        body.discordRoleId,
        body.responsableUserId,
        body.parentHierarchyId
      );

      void safePushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Création hiérarchie staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Hiérarchie créée: ${body.name}`,
        channelId: null
      }, 'staff hierarchy creation');

      return send(c, { hierarchy }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error creating staff hierarchy:', err);
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de la création de la hiérarchie staff') }, err instanceof Error && /Hiérarchie/i.test(err.message)
        ? 400
        : 500);
    }
  });

  router.get(`${base}/staff/hierarchies/schema`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const schema = await getHierarchySchema(guildId);
      return send(c, schema);
    } catch (err) {
      logger.error('StaffAPI', 'Error getting hierarchy schema:', err);
      return fail(c, err, "Erreur lors de la récupération de l'organigramme", 'StaffAPI');
    }
  });

  router.patch(`${base}/staff/hierarchies/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const id = c.req.param('id');
    const hierarchyId = id;
    try {
      const body = await readBody<{
        name?: string;
        description?: string | null;
        color?: string | null;
        icon?: string | null;
        discordRoleId?: string | null;
        responsableUserId?: string | null;
        parentHierarchyId?: string | null;
        enabled?: boolean;
        sortOrder?: number;
      }>(c);

      const updated = await updateStaffHierarchy(guildId, hierarchyId, body ?? {});
      if (!updated) {
        return send(c, { error: 'Hiérarchie introuvable' }, 404);
      }

      void safePushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Modification hiérarchie staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Hiérarchie modifiée: ${updated.name}`,
        channelId: null
      }, 'staff hierarchy update');

      return send(c, { hierarchy: updated });
    } catch (err) {
      logger.error('StaffAPI', 'Error updating staff hierarchy:', err);
      const errorMessage = describeUnknownError(err);
      return send(c, { error: errorMessage }, /Hiérarchie/i.test(errorMessage)
        ? 400
        : 500);
    }
  });

  router.delete(`${base}/staff/hierarchies/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const id = c.req.param('id');
    const hierarchyId = id;
    try {
      const deleted = await deleteStaffHierarchy(guildId, hierarchyId);
      if (!deleted) {
        return send(c, { error: 'Hiérarchie introuvable' }, 404);
      }

      void safePushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Suppression hiérarchie staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Hiérarchie supprimée: ${deleted.name}`,
        channelId: null
      }, 'staff hierarchy deletion');

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error deleting staff hierarchy:', err);
      return fail(c, err, 'Erreur lors de la suppression de la hiérarchie staff', 'StaffAPI');
    }
  });

  router.post(`${base}/staff/hierarchies/:id/import-roles`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const id = c.req.param('id');
    const hierarchyId = id;
    try {
      const body = await readBody<{
        discordRoleId: string;
        grade: string;
      }>(c);

      if (!body?.discordRoleId || !body?.grade) {
        return send(c, { error: 'discordRoleId et grade sont obligatoires' }, 400);
      }

      const result = await importRoleMembers(guildId, hierarchyId, body.discordRoleId, body.grade);
      return send(c, result);
    } catch (err: unknown) {
      logger.error('StaffAPI', 'Error importing role members:', err);
      return send(c, { error: publicErrorMessage(err, "Erreur lors de l'import") }, 500);
    }
  });

  router.post(`${base}/staff/members/:userId/hierarchy-grade`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.req.param('userId');
    try {
      const body = await readBody<{
        hierarchyId?: string | null;
        grade?: string | null;
      }>(c);

      const result = await addMemberToHierarchy(guildId, userId, body?.hierarchyId ?? null, body?.grade ?? null);
      return send(c, { ok: true, grade: result });
    } catch (err: unknown) {
      logger.error('StaffAPI', 'Error adding member to hierarchy:', err);
      return send(c, { error: publicErrorMessage(err, "Erreur lors de l'ajout") }, /détecter automatiquement/i.test(errorMessage(err))
        ? 400
        : 500);
    }
  });

  router.delete(`${base}/staff/members/:userId/hierarchy-grade/:hierarchyId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.req.param('userId');
    const hierarchyId = c.req.param('hierarchyId');
    try {
      await removeMemberFromHierarchy(guildId, userId, hierarchyId);
      return send(c, { ok: true });
    } catch (err: unknown) {
      logger.error('StaffAPI', 'Error removing member from hierarchy:', err);
      return send(c, { error: publicErrorMessage(err, 'Erreur lors du retrait') }, 500);
    }
  });

  router.get(`${base}/staff/polls`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const polls = await getPolls(guildId);
      return send(c, { polls });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting polls:', err);
      return fail(c, err, 'Erreur lors de la récupération des sondages', 'StaffAPI');
    }
  });

  router.post(`${base}/staff/polls`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        title: string;
        description?: string;
        options: string[];
        closesAt?: string;
        isAnonymous?: boolean;
      }>(c);

      if (!body?.title || !Array.isArray(body?.options) || body.options.length < 2) {
        return send(c, { error: 'title et au moins 2 options sont obligatoires' }, 400);
      }

      const author = await getStaffMember(guildId, user.userId);
      if (!author) {
        return send(c, { error: 'Le créateur doit être membre du staff' }, 403);
      }

      const poll = await createPoll(
        guildId,
        author.id,
        body.title.trim(),
        body.description?.trim() || '',
        body.options.map((opt) => opt.trim()).filter(Boolean),
        body.isAnonymous ?? true,
        body.closesAt ? new Date(body.closesAt) : undefined
      );

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Création sondage staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Sondage créé: ${poll.title}`,
        channelId: null
      });

      return send(c, { poll }, 201);
    } catch (err) {
      logger.error('StaffAPI', 'Error creating poll:', err);
      return fail(c, err, 'Erreur lors de la création du sondage', 'StaffAPI');
    }
  });

  router.post(`${base}/staff/polls/vote`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        pollId: string;
        optionId: string;
      }>(c);

      if (!body?.pollId || !body?.optionId) {
        return send(c, { error: 'pollId et optionId sont obligatoires' }, 400);
      }

      const voter = await getStaffMember(guildId, user.userId);
      if (!voter) {
        return send(c, { error: 'Le votant doit être membre du staff' }, 403);
      }

      const poll = await prisma.staffPoll.findFirst({
        where: { id: body.pollId, guildId },
        include: { options: true },
      });

      if (!poll) {
        return send(c, { error: 'Sondage introuvable' }, 404);
      }

      if (poll.status !== 'OPEN') {
        return send(c, { error: 'Ce sondage est fermé' }, 400);
      }

      if (poll.closesAt && poll.closesAt.getTime() <= Date.now()) {
        return send(c, { error: 'Ce sondage est expiré' }, 400);
      }

      const optionExists = poll.options.some((option) => option.id === body.optionId);
      if (!optionExists) {
        return send(c, { error: 'Option de vote invalide' }, 400);
      }

      const vote = await castPollVote(guildId, body.pollId, voter.id, body.optionId);
      return send(c, { vote });
    } catch (err) {
      logger.error('StaffAPI', 'Error casting poll vote:', err);
      return fail(c, err, 'Erreur lors du vote', 'StaffAPI');
    }
  });

  router.patch(`${base}/staff/polls/:pollId/close`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const pollId = c.req.param('pollId');
    try {
      const result = await prisma.staffPoll.updateMany({
        where: { id: pollId, guildId },
        data: { status: 'CLOSED' },
      });

      if (result.count === 0) {
        return send(c, { error: 'Sondage introuvable' }, 404);
      }

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: 'Clôture sondage staff',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Sondage clôturé: ${pollId}`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error closing poll:', err);
      return fail(c, err, 'Erreur lors de la clôture du sondage', 'StaffAPI');
    }
  });

  router.get(`${base}/staff/resignations`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    try {
      const isAdmin = access.level === 'admin';
      const resignations = await prisma.staffResignation.findMany({
        where: {
          guildId,
          ...(isAdmin ? {} : {
            staffMember: { userId: user.userId }
          })
        },
        orderBy: [
          { status: 'asc' },
          { createdAt: 'desc' }
        ],
        include: {
          staffMember: {
            select: { userId: true, username: true, displayName: true, avatarUrl: true, grade: true }
          }
        }
      });
      return send(c, {
        resignations: resignations.map(r => ({
          id: r.id,
          guildId: r.guildId,
          staffUserId: r.staffUserId,
          reason: r.reason,
          status: r.status,
          decisionByUserId: r.decisionByUserId,
          decisionNote: r.decisionNote,
          decidedAt: r.decidedAt?.toISOString() ?? null,
          ticketChannelId: r.ticketChannelId,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          staffMember: r.staffMember
        }))
      });
    } catch (err) {
      logger.error('ResignationsAPI', 'Error fetching resignations:', err);
      return fail(c, err, 'Erreur lors du chargement des demandes', 'ResignationsAPI');
    }
  });

  router.post(`${base}/staff/resignations`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{ reason: string }>(c);

      if (!body?.reason?.trim()) {
        return send(c, { error: 'Le motif est obligatoire' }, 400);
      }

      const staffMember = await prisma.staffMember.findFirst({
        where: { guildId, userId: user.userId }
      });

      if (!staffMember) {
        return send(c, { error: 'Vous ne faites pas partie du staff' }, 403);
      }

      const existingPending = await prisma.staffResignation.findFirst({
        where: { guildId, staffUserId: staffMember.id, status: 'PENDING' }
      });

      if (existingPending) {
        return send(c, { error: 'Une demande de démission est déjà en cours', resignation: existingPending }, 409);
      }

      const reason = body.reason.trim().slice(0, 500);
      const resignation = await prisma.staffResignation.create({
        data: {
          guildId,
          staffUserId: staffMember.id,
          reason,
          status: 'PENDING'
        }
      });

      const managers = await prisma.staffMember.findMany({
        where: {
          guildId,
          grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction'] }
        }
      });

      if (managers.length > 0) {
        await notifyMany(managers.map((m) => m.userId), {
          guildId,
          kind: 'staff.resignation_requested',
          title: 'Demande de démission',
          message: `**${staffMember.username ?? user.userId}** a soumis une demande de démission via le dashboard.\n\n**Motif :**\n> ${reason}`,
          severity: 'WARNING',
          link: '/staff-management?tab=resignations',
          actorId: user.userId,
          data: { resignationId: resignation.id },
        });
      }

      return send(c, { resignation }, 201);
    } catch (err) {
      logger.error('ResignationsAPI', 'Error creating resignation:', err);
      return fail(c, err, 'Erreur lors de la soumission', 'ResignationsAPI');
    }
  });

  router.patch(`${base}/staff/resignations/:resignationId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    if (access.level !== 'admin') {
      return send(c, { error: 'Accès refusé' }, 403);
    }
    const resignationId = c.req.param('resignationId');
    try {
      const body = await readBody<{ action: 'APPROVED' | 'REJECTED'; note?: string }>(c);

      if (!body?.action || !['APPROVED', 'REJECTED'].includes(body.action)) {
        return send(c, { error: 'action doit être APPROVED ou REJECTED' }, 400);
      }

      const resignation = await prisma.staffResignation.findFirst({
        where: { id: resignationId, guildId },
        include: { staffMember: { select: { userId: true, username: true, displayName: true } } }
      });

      if (!resignation) {
        return send(c, { error: 'Demande introuvable' }, 404);
      }

      if (resignation.status !== 'PENDING') {
        return send(c, { error: 'Cette demande a déjà été traitée' }, 409);
      }

      const updated = await prisma.staffResignation.update({
        where: { id: resignationId },
        data: {
          status: body.action,
          decisionByUserId: user.userId,
          decisionNote: body.note ?? null,
          decidedAt: new Date()
        }
      });

      await notify({
        guildId,
        userId: resignation.staffMember.userId,
        kind: 'staff.resignation_decided',
        title: body.action === 'APPROVED' ? 'Démission approuvée' : 'Démission refusée',
        message: body.action === 'APPROVED'
          ? `Votre demande de démission a été **approuvée** par la direction.${body.note ? `\n\n📝 **Note :** ${body.note}` : ''}`
          : `Votre demande de démission a été **refusée** par la direction.${body.note ? `\n\n📝 **Motif :** ${body.note}` : ''}`,
        severity: body.action === 'APPROVED' ? 'SUCCESS' : 'ERROR',
        link: '/profile',
        actorId: user.userId,
      }).catch(() => null);

      await pushAudit(guildId, {
        user: user.username ?? `User${user.userId}`,
        action: `Démission ${body.action === 'APPROVED' ? 'approuvée' : 'refusée'}`,
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Résignation ${resignationId} de ${resignation.staffMember.username ?? resignation.staffMember.userId} → ${body.action}${body.note ? ` (${body.note})` : ''}`,
        channelId: null
      });

      return send(c, { resignation: updated });
    } catch (err) {
      logger.error('ResignationsAPI', 'Error updating resignation:', err);
      return fail(c, err, 'Erreur lors du traitement de la demande', 'ResignationsAPI');
    }
  });

  router.post(`${base}/staff/resignations/:resignationId/ticket`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    if (access.level !== 'admin') {
      return send(c, { error: 'Accès refusé' }, 403);
    }
    const resignationId = c.req.param('resignationId');
    try {
      const resignation = await prisma.staffResignation.findFirst({
        where: { id: resignationId, guildId },
        include: { staffMember: { select: { userId: true, username: true, displayName: true } } }
      });

      if (!resignation) {
        return send(c, { error: 'Demande introuvable' }, 404);
      }

      if (resignation.status !== 'PENDING') {
        return send(c, { error: "Impossible d'ouvrir un ticket : la demande est déjà traitée" }, 409);
      }

      if (resignation.ticketChannelId) {
        return send(c, { error: 'Un ticket est déjà ouvert pour cette demande', ticketChannelId: resignation.ticketChannelId }, 409);
      }

      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { ticketCategoryId: true, ticketStaffRoleId: true }
      });

      const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      if (!discordGuild) {
        return send(c, { error: 'Serveur Discord non disponible' }, 503);
      }

      const targetDiscordUser = await client.users.fetch(resignation.staffMember.userId).catch(() => null);
      const staffName = resignation.staffMember.displayName ?? resignation.staffMember.username ?? resignation.staffMember.userId;
      const channelName = `demission-${staffName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30)}`;

      const permissionOverwrites: OverwriteResolvable[] = [
        {
          id: discordGuild.id,
          deny: [PermissionFlagsBits.ViewChannel]
        }
      ];

      if (guildConfig?.ticketStaffRoleId) {
        permissionOverwrites.push({
          id: guildConfig.ticketStaffRoleId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
        });
      }

      if (targetDiscordUser) {
        permissionOverwrites.push({
          id: targetDiscordUser.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
        });
      }

      const ticketChannel = await discordGuild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: guildConfig?.ticketCategoryId ?? undefined,
        permissionOverwrites,
        reason: `Discussion de démission pour ${staffName}`
      }).catch(() => null);

      if (!ticketChannel) {
        return send(c, { error: 'Impossible de créer le salon Discord' }, 500);
      }

      if (ticketChannel instanceof TextChannel) {
        const introEmbed = new EmbedBuilder()
          .setTitle('📝 Discussion - Demande de démission')
          .setDescription(
            `Ce salon a été créé pour discuter de la demande de démission de **${staffName}**.\n\n` +
            `**Motif fourni :**\n> ${resignation.reason}\n\n` +
            `Merci d'utiliser ce canal pour toute discussion avant de prendre une décision finale.`
          )
          .setColor(COLORS.info)
          .setTimestamp()
          .setFooter({ text: `Référence : ${resignation.id}` });

        await ticketChannel.send({ content: targetDiscordUser ? `<@${targetDiscordUser.id}>` : '', embeds: [introEmbed] }).catch(() => null);
      }

      await prisma.staffResignation.update({
        where: { id: resignationId },
        data: { ticketChannelId: ticketChannel.id }
      });

      return send(c, { ticketChannelId: ticketChannel.id, channelName: ticketChannel.name }, 201);
    } catch (err) {
      logger.error('ResignationsAPI', 'Error creating resignation ticket:', err);
      return fail(c, err, 'Erreur lors de la création du ticket', 'ResignationsAPI');
    }
  });

  return router;
}


import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
import { errorMessage } from '../../../../utils/errors.js';
import prisma from '../../../../utils/db.js';
import { resolveMemberAvatarUrl } from '../../../../services/moderation/memberIdentityService.js';
import { logger } from '../../../../utils/logger.js';
import { COLORS } from '../../../../utils/embeds.js';
import {
  json,
  readJsonBody,
  getGuildName,
  
  pushAudit,
  safePushAudit,
  extractDiscordSnowflake,
  describeUnknownError,
  resolveFeatureAccessMap,
} from '../../../shared.js';
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

import { jsonFailure } from '../../../shared/failure.js';
import { deleteStaffListPanel, saveStaffListPanel } from '../../../../services/staff/staffListPanelService.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';
export async function handleStaffRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess
): Promise<boolean> {
  const method = req.method;

    // 5. Staff routes
    if (parts[4] === 'staff') {
      const isModerator = access.level === 'admin' || access.level === 'moderator';
      if (!isModerator) {
        json(res, 403, { error: 'Accès modérateur requis' });
        return true;
      }

      /**
       * Le niveau `moderator` couvre tout le staff, jusqu'au plus bas grade, et
       * le repartiteur laisse ce segment ouvert parce que Reunions, Planning et
       * Tutorat y lisent l'effectif. Les lectures qui portent une section
       * precise la reverifient donc ici.
       */
      const canView = (featureKey: string) =>
        canViewFeatureSection(client, guildId, access, user.userId, featureKey);
      const denySection = () => {
        json(res, 403, { error: 'Accès refusé. Votre rôle ne donne pas accès à cette section.', code: 'feature_denied' });
        return true;
      };

      const isMentorReportPost = parts[5] === 'mentor-reports' && method === 'POST';
      // La route verifie elle-meme que la personne fait partie du staff.
      const isOwnResignationPost = parts[5] === 'resignations' && !parts[6] && method === 'POST';
      if (method !== 'GET' && !isMentorReportPost && !isOwnResignationPost) {
        let hasConfigurePermission = access.level === 'admin';

        if (!hasConfigurePermission) {
          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
          const roleIds = member ? Array.from(member.roles.cache.keys()) : [];
          const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

          // La matrice des acces separe « Configurer » de « Supprimer » : une
          // requete qui efface demande le second droit, les autres le premier.
          const right = (feature?: { canConfigure: boolean; canDelete: boolean }) =>
            !!(method === 'DELETE' ? feature?.canDelete : feature?.canConfigure);

          if (parts[5] === 'roles') {
            hasConfigurePermission = right(featureAccess.staff_roles);
          } else if (parts[5] === 'members' || parts[5] === 'list-panels') {
            hasConfigurePermission = right(featureAccess.staff_directory);
          } else if (parts[5] === 'warnings') {
            hasConfigurePermission = right(featureAccess.discipline);
          } else if (parts[5] === 'blacklist') {
            hasConfigurePermission = right(featureAccess.discipline);
          } else if (parts[5] === 'config') {
            hasConfigurePermission = right(featureAccess.staff_roles) || right(featureAccess.staff_directory);
          } else if (parts[5] === 'hierarchies') {
            hasConfigurePermission = right(featureAccess.staff_roles);
          }
        }

        if (!hasConfigurePermission) {
          json(res, 403, {
            error: method === 'DELETE'
              ? 'Accès administrateur ou permission de suppression requise'
              : 'Accès administrateur ou permission de configuration requise',
          });
          return true;
        }
      }

      // Panneaux « liste du staff » : GET|POST /staff/list-panels, PATCH|DELETE /staff/list-panels/:id
      if (parts[5] === 'list-panels' && (parts.length === 6 || parts.length === 7)) {
        const panelId = parts[6];
        try {
          if (!panelId && method === 'GET') {
            json(res, 200, { panels: await prisma.staffListPanel.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }) });
            return true;
          }
          if (!panelId && method === 'POST') {
            json(res, 201, { panel: await saveStaffListPanel(guildId, (await readJsonBody<Record<string, unknown>>(req)) ?? {}) });
            return true;
          }
          if (panelId && method === 'PATCH') {
            json(res, 200, { panel: await saveStaffListPanel(guildId, (await readJsonBody<Record<string, unknown>>(req)) ?? {}, panelId) });
            return true;
          }
          if (panelId && method === 'DELETE') {
            const deleted = await deleteStaffListPanel(guildId, panelId);
            json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Panneau introuvable' });
            return true;
          }
        } catch (err) {
          logger.error('StaffAPI', 'Error on staff list panel:', err);
          jsonFailure(res, err, 'Erreur sur le panneau de la liste du staff', 'StaffAPI');
          return true;
        }
      }

      // GET /api/dashboard/guilds/:guildId/staff/algo-schedule
      if (parts[5] === 'algo-schedule' && method === 'GET' && !parts[6]) {
        try {
          const rangeDays = Number(url.searchParams.get('range') || '14');
          const runs = await prisma.dailyAlgoRun.findMany({
            where: { guildId },
            include: { problem: true },
            orderBy: { createdAt: 'desc' },
            take: rangeDays
          });
          json(res, 200, { runs });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting algo schedule:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération du planning Daily Algo', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/algo-ensure
      if (parts[5] === 'algo-ensure' && method === 'POST') {
        try {
          json(res, 200, { ok: true, message: 'Génération de planning demandée' });
        } catch (err) {
          logger.error('StaffAPI', 'Error triggering algo ensure:', err);
          jsonFailure(res, err, 'Erreur lors de la génération du planning', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/alerts
      if (parts[5] === 'alerts' && method === 'GET' && !parts[6]) {
        if (!(await canView('staff_directory'))) return denySection();
        try {
          const metrics = await getStaffAlertsAndProgression(guildId);
          json(res, 200, { metrics });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting staff alerts:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des alertes', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/discord-members
      if (parts[5] === 'discord-members' && method === 'GET' && !parts[6]) {
        try {
          const rawQuery = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim();
          const staffOnly = url.searchParams.get('staffOnly') === 'true';
          const parsedLimit = Number(url.searchParams.get('limit') ?? '12');
          const limit = Number.isFinite(parsedLimit)
            ? Math.min(25, Math.max(1, Math.trunc(parsedLimit)))
            : 12;

          const discordGuild = client.guilds.cache.get(guildId)
            ?? await client.guilds.fetch(guildId).catch(() => null);

          if (!discordGuild) {
            json(res, 404, { error: 'Serveur Discord introuvable' });
            return true;
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

          json(res, 200, { members });
        } catch (err) {
          logger.error('StaffAPI', 'Error searching Discord members:', err);
          jsonFailure(res, err, 'Erreur lors de la recherche des membres Discord', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/members
      if (parts[5] === 'members' && method === 'GET' && !parts[6]) {
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
          json(res, 200, {
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
          jsonFailure(res, err, 'Erreur lors de la récupération des membres staff', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/members
      if (parts[5] === 'members' && method === 'POST' && !parts[6]) {
        try {
          const body = await readJsonBody<{
            userId: string;
            grade: string;
            userTag?: string;
            username?: string;
            displayName?: string;
            avatarUrl?: string;
            createTestingPeriod?: boolean;
          }>(req);

          if (!body?.userId || !body?.grade) {
            json(res, 400, { error: 'userId et grade sont obligatoires' });
            return true;
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

          json(res, 201, { member });
        } catch (err) {
          logger.error('StaffAPI', 'Error adding staff member:', err);
          jsonFailure(res, err, "Erreur lors de l'ajout du membre staff", 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/members/:userId
      if (parts[5] === 'members' && parts[6] && method === 'GET' && !parts[7]) {
        const staffUserId = parts[6];
        const isSelf = staffUserId === user.userId;
        if (!isSelf && !(await canView('staff_directory'))) return denySection();
        try {
          const stats = await getStaffMemberStats(guildId, staffUserId);
          const [seesDiscipline, seesTutoring] = isSelf
            ? [true, true]
            : await Promise.all([canView('discipline'), canView('tutoring')]);
          json(res, 200, {
            ...stats,
            warnings: seesDiscipline ? stats.warnings : [],
            testingPeriods: seesTutoring ? stats.testingPeriods : [],
            stats: { ...stats.stats, activeWarnings: seesDiscipline ? stats.stats.activeWarnings : 0 },
          });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting staff member details:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des détails', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/members/:userId/scorecard
      if (parts[5] === 'members' && parts[6] && parts[7] === 'scorecard' && method === 'GET') {
        const staffUserId = parts[6];
        // Seule la page profil l'appelle : meme regle que le profil staff d'un collegue.
        if (staffUserId !== user.userId && !(await canView('staff_directory'))) return denySection();
        try {
          const { getStaffWeeklyScorecard } = await import('../../../../services/staff/staffScorecardService.js');
          const scorecard = await getStaffWeeklyScorecard(guildId, staffUserId);
          if (!scorecard) {
            json(res, 404, { error: 'Staff member not found or no activity records.' });
            return true;
          }
          json(res, 200, { scorecard });
        } catch (err) {
          logger.error('StaffAPI', `Error getting staff scorecard for user ${staffUserId}:`, err);
          jsonFailure(res, err, 'Erreur lors de la récupération du scorecard d\'activité', 'StaffAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/staff/members/:userId
      if (parts[5] === 'members' && parts[6] && method === 'PATCH' && !parts[7]) {
        const staffUserId = parts[6];
        try {
          const body = await readJsonBody<{
            grade?: string;
            action?: string;
            reason?: string;
          }>(req);

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

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error updating staff member:', err);
          jsonFailure(res, err, 'Erreur lors de la mise à jour du membre staff', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/members/:userId/tutor
      if (parts[5] === 'members' && parts[6] && parts[7] === 'tutor' && method === 'POST') {
        const staffUserId = parts[6];
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

          json(res, 200, { member });
        } catch (err) {
          logger.error('StaffAPI', 'Error toggling tutor status:', err);
          jsonFailure(res, err, 'Erreur lors de la modification du statut tuteur', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/:staffUserId/notes (checks regex ID)
      if (/^\d+$/.test(parts[5]) && parts[6] === 'notes' && method === 'GET') {
        const staffUserId = parts[5];
        // Ecrire et effacer une note demandent deja ce droit : la lecture etait
        // ouverte a tout le staff, la personne visee comprise.
        if (!access.canManageSettings) return denySection();
        try {
          const notes = await getManagerNotes(guildId, staffUserId);
          json(res, 200, { notes });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting manager notes:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des notes', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/:staffUserId/notes
      if (/^\d+$/.test(parts[5]) && parts[6] === 'notes' && method === 'POST') {
        const staffUserId = parts[5];
        try {
          const body = await readJsonBody<{ content: string }>(req);

          if (!body?.content) {
            json(res, 400, { error: 'Le contenu de la note est requis' });
            return true;
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

          json(res, 201, { note });
        } catch (err) {
          logger.error('StaffAPI', 'Error creating manager note:', err);
          jsonFailure(res, err, 'Erreur lors de la création de la note', 'StaffAPI');
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/staff/:staffUserId/notes/:noteId
      if (/^\d+$/.test(parts[5]) && parts[6] === 'notes' && parts[7] && method === 'DELETE') {
        const noteId = parts[7];
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

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error deleting manager note:', err);
          jsonFailure(res, err, 'Erreur lors de la suppression de la note', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/warnings
      if (parts[5] === 'warnings' && method === 'GET' && !parts[6]) {
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

          json(res, 200, { warnings: formattedWarnings });
        } catch (err) {
          logger.error('StaffAPI', 'Error fetching staff warnings:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des avertissements staff', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/warnings
      if (parts[5] === 'warnings' && method === 'POST' && !parts[6]) {
        try {
          const body = await readJsonBody<{
            staffUserId: string;
            reason: string;
            expiresAt?: string;
          }>(req);

          if (!body?.staffUserId || !body?.reason) {
            json(res, 400, { error: 'staffUserId et reason sont obligatoires' });
            return true;
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

          json(res, 201, { warning });
        } catch (err) {
          logger.error('StaffAPI', 'Error issuing warning:', err);
          jsonFailure(res, err, "Erreur lors de la génération de l'avertissement", 'StaffAPI');
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/staff/warnings/:warningId
      if (parts[5] === 'warnings' && parts[6] && method === 'DELETE') {
        const warningId = parts[6];
        try {
          const warning = await prisma.staffWarning.findFirst({
            where: { id: warningId, guildId },
            include: { staffMember: true }
          });

          if (!warning) {
            json(res, 404, { error: 'Avertissement introuvable' });
            return true;
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

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error deleting staff warning:', err);
          jsonFailure(res, err, "Erreur lors de la suppression de l'avertissement", 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/blacklist
      if (parts[5] === 'blacklist' && method === 'POST' && !parts[6]) {
        try {
          const body = await readJsonBody<{
            staffUserId: string;
            reason: string;
            endDate?: string;
          }>(req);

          if (!body?.staffUserId || !body?.reason) {
            json(res, 400, { error: 'staffUserId et reason sont obligatoires' });
            return true;
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

          json(res, 201, { blacklist });
        } catch (err) {
          logger.error('StaffAPI', 'Error blacklisting staff:', err);
          jsonFailure(res, err, 'Erreur lors de la blacklist', 'StaffAPI');
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/staff/blacklist/:userId
      if (parts[5] === 'blacklist' && parts[6] && method === 'DELETE') {
        const targetUserId = parts[6];
        try {
          const linkedUserIds = await altAccountService.getAllLinkedUserIds(guildId, targetUserId);
          const members = await prisma.staffMember.findMany({
            where: { guildId, userId: { in: linkedUserIds } }
          });

          if (members.length === 0) {
            json(res, 404, { error: 'Membre staff introuvable' });
            return true;
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

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error removing from staff blacklist:', err);
          jsonFailure(res, err, 'Erreur lors du retrait de la blacklist', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/roles
      if (parts[5] === 'roles' && method === 'GET' && !parts[6]) {
        try {
          const roles = await getStaffRoles(guildId);
          json(res, 200, { roles });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting staff roles:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des rôles staff', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/roles
      if (parts[5] === 'roles' && method === 'POST' && !parts[6]) {
        try {
          const body = await readJsonBody<{
            name: string;
            level: number;
            discordRoleId?: string;
            color?: string;
            hierarchyId?: string;
            isResponsable?: boolean;
          }>(req);

          if (!body?.name || typeof body?.level !== 'number') {
            json(res, 400, { error: 'name et level sont obligatoires' });
            return true;
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

          json(res, 201, { role });
        } catch (err) {
          logger.error('StaffAPI', 'Error creating staff role:', err);
          jsonFailure(res, err, 'Erreur lors de la création du rôle staff', 'StaffAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/staff/roles/order
      if (parts[5] === 'roles' && parts[6] === 'order' && method === 'PATCH') {
        try {
          const body = await readJsonBody<{
            orderedRoleIds: string[];
          }>(req);

          if (!Array.isArray(body?.orderedRoleIds)) {
            json(res, 400, { error: 'orderedRoleIds doit être un tableau' });
            return true;
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

          json(res, 200, { success: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error reordering staff roles:', err);
          jsonFailure(res, err, 'Erreur lors du réordonnancement des rôles staff', 'StaffAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/staff/roles/:roleId
      if (parts[5] === 'roles' && parts[6] && parts[6] !== 'order' && method === 'PATCH') {
        const roleId = parts[6];
        try {
          const body = await readJsonBody<{
            name?: string;
            level?: number;
            discordRoleId?: string | null;
            color?: string | null;
            hierarchyId?: string | null;
            isResponsable?: boolean;
            sortOrder?: number;
          }>(req);

          const updated = await updateStaffRole(guildId, roleId, body ?? {});
          if (!updated) {
            json(res, 404, { error: 'Rôle staff introuvable' });
            return true;
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

          json(res, 200, { role: updated });
        } catch (err) {
          logger.error('StaffAPI', 'Error updating staff role:', err);
          jsonFailure(res, err, 'Erreur lors de la modification du rôle staff', 'StaffAPI');
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/staff/roles/:roleId
      if (parts[5] === 'roles' && parts[6] && method === 'DELETE') {
        const roleId = parts[6];
        try {
          const deleted = await deleteStaffRole(guildId, roleId);
          if (!deleted) {
            json(res, 404, { error: 'Rôle staff introuvable' });
            return true;
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

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error deleting staff role:', err);
          jsonFailure(res, err, 'Erreur lors de la suppression du rôle staff', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/config
      if (parts[5] === 'config' && !parts[6]) {
        if (method === 'GET') {
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
              json(res, 404, { error: 'Serveur introuvable' });
              return true;
            }

            json(res, 200, { config: guild });
          } catch (err) {
            logger.error('StaffAPI', 'Error getting staff config:', err);
            jsonFailure(res, err, 'Erreur lors de la récupération de la configuration staff', 'StaffAPI');
          }
          return true;
        }

        // PATCH /api/dashboard/guilds/:guildId/staff/config
        if (method === 'PATCH') {
          try {
            const body = await readJsonBody<{
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
            }>(req);

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

            json(res, 200, { config: updatedGuild });
          } catch (err) {
            logger.error('StaffAPI', 'Error updating staff config:', err);
            jsonFailure(res, err, 'Erreur lors de la mise à jour de la configuration staff', 'StaffAPI');
          }
          return true;
        }
      }

      // GET /api/dashboard/guilds/:guildId/staff/hierarchies
      if (parts[5] === 'hierarchies' && method === 'GET' && !parts[6]) {
        try {
          const hierarchies = await getStaffHierarchies(guildId);
          json(res, 200, { hierarchies });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting staff hierarchies:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des hiérarchies staff', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/hierarchies
      if (parts[5] === 'hierarchies' && method === 'POST' && !parts[6]) {
        try {
          const body = await readJsonBody<{
            name: string;
            description?: string;
            color?: string;
            icon?: string;
            discordRoleId?: string;
            responsableUserId?: string;
            parentHierarchyId?: string | null;
          }>(req);

          if (!body?.name) {
            json(res, 400, { error: 'name est obligatoire' });
            return true;
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

          json(res, 201, { hierarchy });
        } catch (err) {
          logger.error('StaffAPI', 'Error creating staff hierarchy:', err);
          json(res, err instanceof Error && /Hiérarchie/i.test(err.message)
            ? 400
            : 500, { error: publicErrorMessage(err, 'Erreur lors de la création de la hiérarchie staff') });
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/hierarchies/schema
      if (parts[5] === 'hierarchies' && parts[6] === 'schema' && method === 'GET' && !parts[7]) {
        try {
          const schema = await getHierarchySchema(guildId);
          json(res, 200, schema);
        } catch (err) {
          logger.error('StaffAPI', 'Error getting hierarchy schema:', err);
          jsonFailure(res, err, "Erreur lors de la récupération de l'organigramme", 'StaffAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/staff/hierarchies/:id
      if (parts[5] === 'hierarchies' && parts[6] && parts[6] !== 'schema' && !parts[7] && method === 'PATCH') {
        const hierarchyId = parts[6];
        try {
          const body = await readJsonBody<{
            name?: string;
            description?: string | null;
            color?: string | null;
            icon?: string | null;
            discordRoleId?: string | null;
            responsableUserId?: string | null;
            parentHierarchyId?: string | null;
            enabled?: boolean;
            sortOrder?: number;
          }>(req);

          const updated = await updateStaffHierarchy(guildId, hierarchyId, body ?? {});
          if (!updated) {
            json(res, 404, { error: 'Hiérarchie introuvable' });
            return true;
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

          json(res, 200, { hierarchy: updated });
        } catch (err) {
          logger.error('StaffAPI', 'Error updating staff hierarchy:', err);
          const errorMessage = describeUnknownError(err);
          json(res, /Hiérarchie/i.test(errorMessage)
            ? 400
            : 500, { error: errorMessage });
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/staff/hierarchies/:id
      if (parts[5] === 'hierarchies' && parts[6] && parts[6] !== 'schema' && !parts[7] && method === 'DELETE') {
        const hierarchyId = parts[6];
        try {
          const deleted = await deleteStaffHierarchy(guildId, hierarchyId);
          if (!deleted) {
            json(res, 404, { error: 'Hiérarchie introuvable' });
            return true;
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

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error deleting staff hierarchy:', err);
          jsonFailure(res, err, 'Erreur lors de la suppression de la hiérarchie staff', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/hierarchies/:id/import-roles
      if (parts[5] === 'hierarchies' && parts[6] && parts[7] === 'import-roles' && method === 'POST') {
        const hierarchyId = parts[6];
        try {
          const body = await readJsonBody<{
            discordRoleId: string;
            grade: string;
          }>(req);

          if (!body?.discordRoleId || !body?.grade) {
            json(res, 400, { error: 'discordRoleId et grade sont obligatoires' });
            return true;
          }

          const result = await importRoleMembers(guildId, hierarchyId, body.discordRoleId, body.grade);
          json(res, 200, result);
        } catch (err: unknown) {
          logger.error('StaffAPI', 'Error importing role members:', err);
          json(res, 500, { error: publicErrorMessage(err, "Erreur lors de l'import") });
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/members/:userId/hierarchy-grade
      if (parts[5] === 'members' && parts[6] && parts[7] === 'hierarchy-grade' && !parts[8] && method === 'POST') {
        const userId = parts[6];
        try {
          const body = await readJsonBody<{
            hierarchyId?: string | null;
            grade?: string | null;
          }>(req);

          const result = await addMemberToHierarchy(guildId, userId, body?.hierarchyId ?? null, body?.grade ?? null);
          json(res, 200, { ok: true, grade: result });
        } catch (err: unknown) {
          logger.error('StaffAPI', 'Error adding member to hierarchy:', err);
          json(res, /détecter automatiquement/i.test(errorMessage(err))
            ? 400
            : 500, { error: publicErrorMessage(err, "Erreur lors de l'ajout") });
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/staff/members/:userId/hierarchy-grade/:hierarchyId
      if (parts[5] === 'members' && parts[6] && parts[7] === 'hierarchy-grade' && parts[8] && method === 'DELETE') {
        const userId = parts[6];
        const hierarchyId = parts[8];
        try {
          await removeMemberFromHierarchy(guildId, userId, hierarchyId);
          json(res, 200, { ok: true });
        } catch (err: unknown) {
          logger.error('StaffAPI', 'Error removing member from hierarchy:', err);
          json(res, 500, { error: publicErrorMessage(err, 'Erreur lors du retrait') });
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/polls
      if (parts[5] === 'polls' && method === 'GET' && !parts[6]) {
        try {
          const polls = await getPolls(guildId);
          json(res, 200, { polls });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting polls:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des sondages', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/polls
      if (parts[5] === 'polls' && method === 'POST' && !parts[6]) {
        try {
          const body = await readJsonBody<{
            title: string;
            description?: string;
            options: string[];
            closesAt?: string;
            isAnonymous?: boolean;
          }>(req);

          if (!body?.title || !Array.isArray(body?.options) || body.options.length < 2) {
            json(res, 400, { error: 'title et au moins 2 options sont obligatoires' });
            return true;
          }

          const author = await getStaffMember(guildId, user.userId);
          if (!author) {
            json(res, 403, { error: 'Le créateur doit être membre du staff' });
            return true;
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

          json(res, 201, { poll });
        } catch (err) {
          logger.error('StaffAPI', 'Error creating poll:', err);
          jsonFailure(res, err, 'Erreur lors de la création du sondage', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/polls/vote
      if (parts[5] === 'polls' && parts[6] === 'vote' && method === 'POST') {
        try {
          const body = await readJsonBody<{
            pollId: string;
            optionId: string;
          }>(req);

          if (!body?.pollId || !body?.optionId) {
            json(res, 400, { error: 'pollId et optionId sont obligatoires' });
            return true;
          }

          const voter = await getStaffMember(guildId, user.userId);
          if (!voter) {
            json(res, 403, { error: 'Le votant doit être membre du staff' });
            return true;
          }

          const poll = await prisma.staffPoll.findFirst({
            where: { id: body.pollId, guildId },
            include: { options: true },
          });

          if (!poll) {
            json(res, 404, { error: 'Sondage introuvable' });
            return true;
          }

          if (poll.status !== 'OPEN') {
            json(res, 400, { error: 'Ce sondage est fermé' });
            return true;
          }

          if (poll.closesAt && poll.closesAt.getTime() <= Date.now()) {
            json(res, 400, { error: 'Ce sondage est expiré' });
            return true;
          }

          const optionExists = poll.options.some((option) => option.id === body.optionId);
          if (!optionExists) {
            json(res, 400, { error: 'Option de vote invalide' });
            return true;
          }

          const vote = await castPollVote(guildId, body.pollId, voter.id, body.optionId);
          json(res, 200, { vote });
        } catch (err) {
          logger.error('StaffAPI', 'Error casting poll vote:', err);
          jsonFailure(res, err, 'Erreur lors du vote', 'StaffAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/staff/polls/:pollId/close
      if (parts[5] === 'polls' && parts[6] && parts[7] === 'close' && method === 'PATCH') {
        const pollId = parts[6];
        try {
          const result = await prisma.staffPoll.updateMany({
            where: { id: pollId, guildId },
            data: { status: 'CLOSED' },
          });

          if (result.count === 0) {
            json(res, 404, { error: 'Sondage introuvable' });
            return true;
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

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error closing poll:', err);
          jsonFailure(res, err, 'Erreur lors de la clôture du sondage', 'StaffAPI');
        }
        return true;
      }

      // GET /api/dashboard/guilds/:guildId/staff/resignations
      if (parts[5] === 'resignations' && method === 'GET' && !parts[6]) {
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
          json(res, 200, {
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
          jsonFailure(res, err, 'Erreur lors du chargement des demandes', 'ResignationsAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/resignations
      if (parts[5] === 'resignations' && method === 'POST' && !parts[6]) {
        try {
          const body = await readJsonBody<{ reason: string }>(req);

          if (!body?.reason?.trim()) {
            json(res, 400, { error: 'Le motif est obligatoire' });
            return true;
          }

          const staffMember = await prisma.staffMember.findFirst({
            where: { guildId, userId: user.userId }
          });

          if (!staffMember) {
            json(res, 403, { error: 'Vous ne faites pas partie du staff' });
            return true;
          }

          const existingPending = await prisma.staffResignation.findFirst({
            where: { guildId, staffUserId: staffMember.id, status: 'PENDING' }
          });

          if (existingPending) {
            json(res, 409, { error: 'Une demande de démission est déjà en cours', resignation: existingPending });
            return true;
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

          json(res, 201, { resignation });
        } catch (err) {
          logger.error('ResignationsAPI', 'Error creating resignation:', err);
          jsonFailure(res, err, 'Erreur lors de la soumission', 'ResignationsAPI');
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/staff/resignations/:resignationId
      if (parts[5] === 'resignations' && parts[6] && method === 'PATCH' && !parts[7]) {
        if (access.level !== 'admin') {
          json(res, 403, { error: 'Accès refusé' });
          return true;
        }
        const resignationId = parts[6];

        try {
          const body = await readJsonBody<{ action: 'APPROVED' | 'REJECTED'; note?: string }>(req);

          if (!body?.action || !['APPROVED', 'REJECTED'].includes(body.action)) {
            json(res, 400, { error: 'action doit être APPROVED ou REJECTED' });
            return true;
          }

          const resignation = await prisma.staffResignation.findFirst({
            where: { id: resignationId, guildId },
            include: { staffMember: { select: { userId: true, username: true, displayName: true } } }
          });

          if (!resignation) {
            json(res, 404, { error: 'Demande introuvable' });
            return true;
          }

          if (resignation.status !== 'PENDING') {
            json(res, 409, { error: 'Cette demande a déjà été traitée' });
            return true;
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

          json(res, 200, { resignation: updated });
        } catch (err) {
          logger.error('ResignationsAPI', 'Error updating resignation:', err);
          jsonFailure(res, err, 'Erreur lors du traitement de la demande', 'ResignationsAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/staff/resignations/:resignationId/ticket
      if (parts[5] === 'resignations' && parts[6] && parts[7] === 'ticket' && method === 'POST') {
        if (access.level !== 'admin') {
          json(res, 403, { error: 'Accès refusé' });
          return true;
        }
        const resignationId = parts[6];

        try {
          const resignation = await prisma.staffResignation.findFirst({
            where: { id: resignationId, guildId },
            include: { staffMember: { select: { userId: true, username: true, displayName: true } } }
          });

          if (!resignation) {
            json(res, 404, { error: 'Demande introuvable' });
            return true;
          }

          if (resignation.status !== 'PENDING') {
            json(res, 409, { error: "Impossible d'ouvrir un ticket : la demande est déjà traitée" });
            return true;
          }

          if (resignation.ticketChannelId) {
            json(res, 409, { error: 'Un ticket est déjà ouvert pour cette demande', ticketChannelId: resignation.ticketChannelId });
            return true;
          }

          const guildConfig = await prisma.guild.findUnique({
            where: { id: guildId },
            select: { ticketCategoryId: true, ticketStaffRoleId: true }
          });

          const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
          if (!discordGuild) {
            json(res, 503, { error: 'Serveur Discord non disponible' });
            return true;
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
            json(res, 500, { error: 'Impossible de créer le salon Discord' });
            return true;
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

          json(res, 201, { ticketChannelId: ticketChannel.id, channelName: ticketChannel.name });
        } catch (err) {
          logger.error('ResignationsAPI', 'Error creating resignation ticket:', err);
          jsonFailure(res, err, 'Erreur lors de la création du ticket', 'ResignationsAPI');
        }
        return true;
      }
    }

  return false;
}

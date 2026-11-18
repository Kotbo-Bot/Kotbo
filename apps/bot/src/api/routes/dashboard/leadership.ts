import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { resolveDashboardAccess, resolveProfileRoleDisplay } from '../../shared.js';
import {
  getStaffAlertsAndProgression,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../services/staff/staffLeadershipService.js';
import {
  getStaffMember,
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
} from '../../../services/staff/staffManagementService.js';
import { getStaffProfileSnapshot } from '../../../services/progression/profileService.js';
import { canViewFeatureSection, getCachedFeatureAccess } from './featureGate.js';

import { dashboardAuth, fail, guildRoute, send } from '../../hono/dashboard/kit.js';
/**
 * Profil et statistiques staff d'une personne (`/users/:userId/...?guildId=`),
 * et synthèse leadership d'un serveur. Les routes `/users` vérifient elles-mêmes
 * l'accès au serveur passé en paramètre.
 */
export function createLeadershipRouter(client: Client) {
  const router = new Hono();

  router.get('/api/dashboard/users/:userId/profile', dashboardAuth, async (c) => {
    const user = c.var.dashboardUser;
    const userId = c.req.param('userId');
    try {
      const guildId = c.req.query('guildId');
      if (!guildId) {
        return send(c, { error: 'guildId manquant' }, 400);
      }

      const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
      if (accessLevel.level === 'none') {
        return send(c, { error: 'Accès refusé' }, 403);
      }

      const requesterStaff = await getStaffMember(guildId, user.userId);
      const isManagerOrAdmin = accessLevel.canManageSettings || ['admin', 'moderator'].includes(accessLevel.level);
      if (!requesterStaff && !isManagerOrAdmin) {
        return send(c, { error: "Accès refusé. Vous devez faire partie de l'équipe staff pour voir ce profil." }, 403);
      }

      const isOwnProfile = userId === user.userId;

      /**
       * Le niveau `moderator` couvre tout membre du staff, jusqu'au plus bas
       * grade : le tester seul ouvrait a chacun les avertissements, la
       * blacklist et les notes de management de tous ses collegues. Chaque
       * bloc suit desormais la section du Centre de gestion qui le porte.
       *
       * Sur son propre profil, on garde ses propres donnees meme section
       * fermee - comme `tutoring/apprentice-progress` - sauf les notes de
       * management, ecrites pour les responsables et non pour la personne.
       */
      const featureAccess = accessLevel.canManageSettings
        ? null
        : await getCachedFeatureAccess(client, guildId, accessLevel, user.userId);
      const canViewSection = (key: string) =>
        isOwnProfile || accessLevel.canManageSettings || featureAccess?.[key]?.canView !== false;

      // Refuser renvoie le dashboard sur le profil communautaire du membre.
      if (!canViewSection('staff_directory')) {
        return send(c, { error: 'Accès refusé. Votre rôle ne donne pas accès aux profils du staff.', code: 'feature_denied' }, 403);
      }

      const snapshot = await getStaffProfileSnapshot(guildId, userId);
      if (!snapshot) {
        return send(c, { error: 'Membre du staff introuvable' }, 404);
      }

      const publicProfileRoleDisplay = snapshot.publicProfile
        ? await resolveProfileRoleDisplay(client, snapshot.publicProfile.guildId, snapshot.publicProfile.rolesSnapshot)
        : null;

      const visibility = {
        discipline: canViewSection('discipline'),
        absences: canViewSection('absences'),
        tutoring: canViewSection('tutoring'),
        managerNotes: accessLevel.canManageSettings,
        // Creer ou revoquer une cle est refuse sans ce droit par le repartiteur.
        apiKeys: isOwnProfile && accessLevel.canManageSettings,
      };

      return send(c, {
        staffMember: snapshot.staffMember,
        publicProfile: snapshot.publicProfile
          ? {
              ...snapshot.publicProfile,
              roles: publicProfileRoleDisplay?.roles ?? [],
              primaryRole: publicProfileRoleDisplay?.primaryRole ?? null,
            }
          : null,
        apiKeys: visibility.apiKeys
          ? snapshot.apiKeys.map((k) => ({
              id: k.id,
              displayKey: k.displayKey,
              name: k.name,
              permissions: k.permissions,
              lastUsedAt: k.lastUsedAt,
            }))
          : [],
        activeBlacklist: visibility.discipline ? snapshot.activeBlacklist : null,
        blacklistHistory: visibility.discipline ? snapshot.blacklistHistory : [],
        warnings: visibility.discipline ? snapshot.warnings : [],
        testingPeriods: visibility.tutoring ? snapshot.testingPeriods : [],
        activities: snapshot.activities,
        absences: visibility.absences ? snapshot.absences : [],
        notesWritten: visibility.managerNotes ? snapshot.notesWritten : [],
        notesAbout: visibility.managerNotes ? snapshot.notesAbout : [],
        gradeHistory: snapshot.gradeHistory,
        stats: {
          ...snapshot.stats,
          activeWarnings: visibility.discipline ? snapshot.stats.activeWarnings : 0,
          sanctionsIssued: visibility.discipline ? snapshot.stats.sanctionsIssued : 0,
        },
        isBlacklisted: visibility.discipline ? !!snapshot.activeBlacklist : false,
        blacklistReason: visibility.discipline ? snapshot.activeBlacklist?.reason : null,
        blacklistEndDate: visibility.discipline ? snapshot.activeBlacklist?.endDate : null,
        visibility,
      });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting user profile:', err);
      return fail(c, err, 'Erreur lors de la récupération du profil', 'StaffAPI');
    }
  });

  router.get('/api/dashboard/users/:userId/staff-stats', dashboardAuth, async (c) => {
    const user = c.var.dashboardUser;
    const userId = c.req.param('userId');
    try {
      const guildId = c.req.query('guildId');
      if (!guildId) {
        return send(c, { error: 'guildId manquant' }, 400);
      }

      const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
      if (!accessLevel.canViewDashboard) {
        return send(c, { error: 'Accès refusé' }, 403);
      }

      const isOwnProfile = userId === user.userId;
      const canSeeSensitive = accessLevel.canManageSettings
        || ['admin', 'moderator'].includes(accessLevel.level);
      if (!isOwnProfile && !canSeeSensitive) {
        return send(c, { error: 'Accès refusé à ces statistiques staff' }, 403);
      }

      const staffMember = await prisma.staffMember.findUnique({
        where: { guildId_userId: { guildId, userId } },
        include: {
          warnings: { where: { isActive: true } },
          activities: { orderBy: { activityDate: 'desc' }, take: 30 },
        },
      });

      if (!staffMember) {
        return send(c, { error: 'Membre du staff introuvable' }, 404);
      }

      const stats = {
        totalMessages: staffMember.activities.reduce((sum, a) => sum + a.messageCount, 0),
        totalVoiceMinutes: staffMember.activities.reduce((sum, a) => sum + a.voiceMinutes, 0),
        activeWarnings: staffMember.warnings.length,
        joinedStaffAt: staffMember.joinedStaffAt,
        currentRoleStartedAt: staffMember.currentRoleStartedAt,
        activities: staffMember.activities,
      };

      return send(c, { stats });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting staff stats:', err);
      return fail(c, err, 'Erreur lors de la récupération des statistiques', 'StaffAPI');
    }
  });

  // Memes alertes que `staff/alerts`, sans aucune garde jusqu'ici.
  router.get('/api/dashboard/guilds/:guildId/leadership', ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const isStaffLevel = access.level === 'admin' || access.level === 'moderator';
    if (!isStaffLevel || !(await canViewFeatureSection(client, guildId, access, c.var.dashboardUser.userId, 'staff_directory'))) {
      return send(c, { error: 'Accès refusé. Votre rôle ne donne pas accès à cette section.', code: 'feature_denied' }, 403);
    }
  try {
    const metrics = await getStaffAlertsAndProgression(guildId);
    return send(c, { metrics });
  } catch (err) {
    logger.error('StaffAPI', 'Error getting leadership metrics:', err);
    return fail(c, err, 'Erreur lors de la récupération des métriques leadership', 'StaffAPI');
  }
  });

  return router;
}

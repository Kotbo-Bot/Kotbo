/** Outils MCP - read staff (permission READ_STAFF). */
import { getEvaluationsDashboardData } from '../../../services/staff/staffEvaluationService.js';
import { getAbsences, getCallPermissionConfig, getCalls, getMeetings, getNotifications, getPolls, getStaffAlertsAndProgression, getStaffCalendarData, getTasks } from '../../../services/staff/staffLeadershipService.js';
import { getAPIKeys, getStaffHierarchies, getStaffRoles } from '../../../services/staff/staffManagementService.js';
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveMember, toolError } from '../toolkit.js';

export function registerReadStaffTools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_STAFF')) {
    server.registerTool(
      'get_staff_list',
      {
        description: 'Récupère la liste des membres du staff du serveur.',
        inputSchema: {
          include_inactive: z.boolean().default(false).describe('Inclure les membres inactifs'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ include_inactive }) => {
        const staffMembers = await prisma.staffMember.findMany({
          where: {
            guildId,
            ...(include_inactive ? {} : {}),
          },
          include: {
            absences: {
              where: { status: { in: ['PENDING', 'APPROVED'] } },
              select: { id: true, startDate: true, endDate: true, type: true },
            },
          },
          orderBy: { joinedStaffAt: 'desc' },
        });

        return ok(
          staffMembers.map((s) => ({
            id: s.id,
            userId: s.userId,
            username: s.username,
            displayName: s.displayName,
            grade: s.grade,
            joinedStaffAt: s.joinedStaffAt.toISOString(),
            isCurrentlyAbsent: s.absences.length > 0,
            absences: s.absences.map((a) => ({
              type: a.type,
              from: a.startDate.toISOString(),
              until: a.endDate?.toISOString() ?? null,
            })),
          }))
        );
      })
    );

    server.registerTool(
      'get_staff_member',
      {
        description: "Récupère le profil détaillé d'un membre du staff.",
        inputSchema: { member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre du staff') },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const member_id = resolved.userId;

        const staff = await prisma.staffMember.findUnique({
          where: { guildId_userId: { guildId, userId: member_id } },
          include: {
            warnings: { orderBy: { createdAt: 'desc' }, take: 10 },
            activities: { orderBy: { activityDate: 'desc' }, take: 30 },
          },
        });

        if (!staff) return err('Membre du staff introuvable');

        return ok({
          id: staff.id,
          userId: staff.userId,
          username: staff.username,
          displayName: staff.displayName,
          avatarUrl: staff.avatarUrl,
          grade: staff.grade,
          joinedStaffAt: staff.joinedStaffAt.toISOString(),
          warnings: staff.warnings.map((w) => ({
            reason: w.reason,
            type: w.type,
            issuedAt: w.createdAt.toISOString(),
            expiresAt: w.expiresAt?.toISOString(),
          })),
          recentActivity: staff.activities.map((a) => ({
            date: a.activityDate.toISOString(),
            messageCount: a.messageCount,
            voiceMinutes: a.voiceMinutes,
          })),
        });
      })
    );

    server.registerTool(
      'get_staff_evaluations',
      {
        description: 'Récupère les évaluations de performance du staff (scores activité, modération, présence). Requiert READ_STAFF.',
        inputSchema: {
          member: z.string().optional().describe('Filtrer par membre staff : nom, mention ou ID'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ member }) => {
        try {
          if (member) {
            const resolved = await resolveMember(guildId, member);
            if (!resolved.ok) return resolved.response;
            const evaluations = await prisma.staffEvaluation.findMany({
              where: { guildId, staffUserId: resolved.userId },
              orderBy: { periodEnd: 'desc' },
              take: 20,
            });
            return ok({ staffUserId: resolved.userId, evaluations });
          }
          const data = await getEvaluationsDashboardData(guildId);
          return ok(data);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_call_permission_config',
      {
        description: 'Récupère la configuration des permissions pour planifier des appels staff (mode EVERYONE ou RESTRICTED). Requiert READ_STAFF.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          const config = await getCallPermissionConfig(guildId);
          return ok(config);
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_absences',
      {
        description: 'Liste les absences staff du serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getAbsences(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_meetings',
      {
        description: 'Liste les réunions staff du serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getMeetings(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_notifications',
      {
        description: 'Liste les notifications staff d’un membre donné.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          return ok(await getNotifications(guildId, resolved.userId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_polls',
      {
        description: 'Liste les sondages staff du serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getPolls(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_calls',
      {
        description: 'Liste les appels staff planifiés.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getCalls(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_tasks',
      {
        description: 'Liste les tâches staff du serveur.',
        inputSchema: {
          assignee: z.string().optional().describe('Filtrer par membre assigné'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ assignee }) => {
        try {
          let assigneeId: string | null | undefined;
          if (assignee) {
            const resolvedAssignee = await resolveMember(guildId, assignee);
            assigneeId = resolvedAssignee.ok ? resolvedAssignee.userId : null;
          }
          if (assignee && !assigneeId) return err('Membre introuvable');
          return ok(await getTasks(guildId, assigneeId ?? undefined));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_roles',
      {
        description: 'Liste les rôles staff configurés.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getStaffRoles(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_hierarchies',
      {
        description: 'Liste les hiérarchies staff configurées.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getStaffHierarchies(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_api_keys',
      {
        description: 'Liste les clés API staff actives du serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getAPIKeys(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_alerts',
      {
        description: 'Récupère les alertes et la progression du staff.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getStaffAlertsAndProgression(guildId));
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'get_staff_calendar_data',
      {
        description: 'Récupère les données de calendrier staff sur une période donnée.',
        inputSchema: {
          start: z.string().describe('Date de début ISO'),
          end: z.string().describe('Date de fin ISO'),
          staff_ids: z.array(z.string()).optional().describe('Filtre optionnel sur les membres staff'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ start, end, staff_ids }) => {
        const startDate = new Date(start);
        const endDate = new Date(end);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
          return err('Période invalide');
        }

        try {
          return ok(await getStaffCalendarData(guildId, startDate, endDate, staff_ids));
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}

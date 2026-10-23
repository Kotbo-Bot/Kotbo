/** Outils MCP - write staff leadership (permission WRITE_MEMBERS). */
import { castPollVote, createAbsence, createCall, createManagerNote, createMeeting, createPoll, createTask, deleteAbsence, deleteCall, deleteManagerNote, deleteMeeting, deleteTask, markAllNotificationsRead, markNotificationRead, updateAbsenceStatus, updateCall, updateCallPermissionConfig, updateMeeting, updateTask } from '../../../services/staff/staffLeadershipService.js';
import { addMemberToHierarchy, createAPIKey, createStaffHierarchy, createStaffRole, deleteAPIKey, deleteStaffHierarchy, deleteStaffRole, generateAPIKey, hashAPIKey, importRoleMembers, removeMemberFromHierarchy, reorderStaffRoles, syncStaffHierarchyMemberships, updateStaffHierarchy, updateStaffRole } from '../../../services/staff/staffManagementService.js';
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveMember, resolveStaffMemberRecord, toolError } from '../toolkit.js';

export function registerWriteStaffLeadershipTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, toolMeta } = ctx;

  // ── WRITE_MEMBERS - Leadership / planning staff ──────────────────────────
  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'create_staff_absence',
      {
        description: 'Crée une absence staff.',
        inputSchema: {
          staff_member: z.string().describe('Membre staff absent'),
          superior_member: z.string().describe('Supérieur qui traite l’absence'),
          start_date: z.string().describe('Date de début ISO'),
          end_date: z.string().optional().describe('Date de fin ISO'),
          reason: z.string().describe('Motif'),
          type: z.string().describe('Type d’absence'),
          message: z.string().optional().describe('Message complémentaire'),
          notify_on_mention: z.boolean().optional().describe('Notifier lors des mentions'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ staff_member, superior_member, start_date, end_date, reason, type, message, notify_on_mention }) => {
        const staff = await resolveStaffMemberRecord(guildId, client, staff_member);
        if (!staff.ok) return staff.response;
        const superior = await resolveStaffMemberRecord(guildId, client, superior_member);
        if (!superior.ok) return superior.response;

        const startDate = new Date(start_date);
        const parsedEndDate = end_date ? new Date(end_date) : undefined;
        if (Number.isNaN(startDate.getTime()) || (parsedEndDate && Number.isNaN(parsedEndDate.getTime()))) {
          return err('Dates invalides');
        }

        try {
          const absence = await createAbsence({
            guildId,
            staffMemberId: staff.staffMember.id,
            startDate,
            endDate: parsedEndDate,
            reason,
            type,
            message,
            superiorUserId: superior.staffMember.userId,
            notifyOnMention: notify_on_mention,
          });
          return ok({ ok: true, absence });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_staff_absence_status',
      {
        description: 'Met à jour le statut d’une absence staff.',
        inputSchema: {
          absence_id: z.string().describe('ID de l’absence'),
          status: z.enum(['ACKNOWLEDGED', 'APPROVED', 'REJECTED', 'CANCELED', 'ENDED']),
          note: z.string().optional().describe('Note de décision'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ absence_id, status, note }) => {
        try {
          const absence = await updateAbsenceStatus(guildId, absence_id, status, 'mcp_agent', note);
          return ok({ ok: true, absence });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_staff_absence',
      {
        description: 'Supprime une absence staff.',
        inputSchema: { absence_id: z.string().describe('ID de l’absence') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ absence_id }) => {
        try {
          await deleteAbsence(guildId, absence_id);
          return ok({ ok: true, absenceId: absence_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_staff_meeting',
      {
        description: 'Crée une réunion staff.',
        inputSchema: {
          creator_member: z.string().describe('Membre staff créateur'),
          title: z.string().describe('Titre de la réunion'),
          description: z.string().optional().describe('Description'),
          scheduled_at: z.string().describe('Date de réunion ISO'),
          ended_at: z.string().optional().describe('Date de fin ISO'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, title, description, scheduled_at, ended_at }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;

        const scheduledAt = new Date(scheduled_at);
        const parsedEndedAt = ended_at ? new Date(ended_at) : undefined;
        if (Number.isNaN(scheduledAt.getTime()) || (parsedEndedAt && Number.isNaN(parsedEndedAt.getTime()))) {
          return err('Dates de réunion invalides');
        }

        try {
          const meeting = await createMeeting(client, guildId, creator.staffMember.userId, title, description ?? '', scheduledAt, parsedEndedAt);
          return ok({ ok: true, meeting });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_staff_meeting',
      {
        description: 'Met à jour une réunion staff.',
        inputSchema: {
          meeting_id: z.string().describe('ID de la réunion'),
          title: z.string().optional(),
          description: z.string().optional(),
          scheduled_at: z.string().optional(),
          ended_at: z.string().optional(),
          status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED']).optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ meeting_id, title, description, scheduled_at, ended_at, status }) => {
        try {
          const data: { title?: string; description?: string; scheduledAt?: Date; endedAt?: Date; status?: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED' } = {};
          if (title !== undefined) data.title = title;
          if (description !== undefined) data.description = description;
          if (scheduled_at !== undefined) data.scheduledAt = new Date(scheduled_at);
          if (ended_at !== undefined) data.endedAt = new Date(ended_at);
          if (status !== undefined) data.status = status;
          const meeting = await updateMeeting(client, guildId, meeting_id, data);
          return ok({ ok: true, meeting });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_staff_meeting',
      {
        description: 'Supprime une réunion staff.',
        inputSchema: {
          meeting_id: z.string().describe('ID de la réunion'),
          delete_event: z.boolean().optional(),
          delete_message: z.boolean().optional(),
          delete_notifications: z.boolean().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ meeting_id, delete_event, delete_message, delete_notifications }) => {
        try {
          await deleteMeeting(client, guildId, meeting_id, {
            deleteEvent: delete_event ?? false,
            deleteMessage: delete_message ?? false,
            deleteNotifications: delete_notifications ?? false,
          });
          return ok({ ok: true, meetingId: meeting_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'mark_staff_notification_read',
      {
        description: 'Marque une notification staff comme lue.',
        inputSchema: {
          member: z.string().describe('Membre concerné'),
          notification_id: z.string().describe('ID de la notification'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, notification_id }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          await markNotificationRead(notification_id, resolved.userId);
          return ok({ ok: true, notificationId: notification_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'mark_all_staff_notifications_read',
      {
        description: 'Marque toutes les notifications staff comme lues.',
        inputSchema: { member: z.string().describe('Membre concerné') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          await markAllNotificationsRead(guildId, resolved.userId);
          return ok({ ok: true, userId: resolved.userId });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_staff_poll',
      {
        description: 'Crée un sondage staff.',
        inputSchema: {
          creator_member: z.string().describe('Créateur staff'),
          title: z.string().describe('Titre'),
          description: z.string().optional(),
          options: z.array(z.string()).min(2).describe('Options de vote'),
          closes_at: z.string().optional().describe('Date de clôture ISO'),
          is_anonymous: z.boolean().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, title, description, options, closes_at, is_anonymous }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;

        try {
          const poll = await createPoll(
            guildId,
            creator.staffMember.id,
            title.trim(),
            description?.trim() || '',
            options.map((option: string) => option.trim()).filter(Boolean),
            is_anonymous ?? true,
            closes_at ? new Date(closes_at) : undefined
          );
          return ok({ ok: true, poll });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'vote_staff_poll',
      {
        description: 'Vote sur un sondage staff.',
        inputSchema: {
          member: z.string().describe('Votant'),
          poll_id: z.string().describe('ID du sondage'),
          option_id: z.string().describe('ID de l’option'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, poll_id, option_id }) => {
        const voter = await resolveStaffMemberRecord(guildId, client, member);
        if (!voter.ok) return voter.response;

        try {
          const vote = await castPollVote(guildId, poll_id, voter.staffMember.id, option_id);
          return ok({ ok: true, vote });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'close_staff_poll',
      {
        description: 'Ferme un sondage staff.',
        inputSchema: { poll_id: z.string().describe('ID du sondage') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ poll_id }) => {
        try {
          const result = await prisma.staffPoll.updateMany({ where: { id: poll_id, guildId }, data: { status: 'CLOSED' } });
          if (result.count === 0) return err('Sondage introuvable');
          return ok({ ok: true, pollId: poll_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_staff_task',
      {
        description: 'Crée une tâche staff.',
        inputSchema: {
          creator_member: z.string().describe('Créateur staff'),
          assignee: z.string().describe('Assigné'),
          title: z.string().describe('Titre'),
          description: z.string().optional(),
          priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
          due_date: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, assignee, title, description, priority, due_date }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;
        const assigneeMember = await resolveStaffMemberRecord(guildId, client, assignee);
        if (!assigneeMember.ok) return assigneeMember.response;

        try {
          const task = await createTask(
            guildId,
            creator.staffMember.userId,
            title.trim(),
            description?.trim() || null,
            priority,
            due_date ? new Date(due_date) : null,
            assigneeMember.staffMember.id
          );
          return ok({ ok: true, task });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_staff_task',
      {
        description: 'Met à jour une tâche staff.',
        inputSchema: {
          task_id: z.string().describe('ID de la tâche'),
          title: z.string().optional(),
          description: z.string().nullable().optional(),
          status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).optional(),
          priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
          due_date: z.string().nullable().optional(),
          assignee: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ task_id, title, description, status, priority, due_date, assignee }) => {
        try {
          const updateData: { title?: string; description?: string | null; status?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'; priority?: 'LOW' | 'MEDIUM' | 'HIGH'; dueDate?: Date | null; assigneeId?: string } = {};
          if (title !== undefined) updateData.title = title;
          if (description !== undefined) updateData.description = description;
          if (status !== undefined) updateData.status = status;
          if (priority !== undefined) updateData.priority = priority;
          if (due_date !== undefined) updateData.dueDate = due_date ? new Date(due_date) : null;
          if (assignee !== undefined) {
            const assigneeMember = await resolveStaffMemberRecord(guildId, client, assignee);
            if (!assigneeMember.ok) return assigneeMember.response;
            updateData.assigneeId = assigneeMember.staffMember.id;
          }
          const task = await updateTask(guildId, task_id, updateData);
          return ok({ ok: true, task });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_staff_task',
      {
        description: 'Supprime une tâche staff.',
        inputSchema: { task_id: z.string().describe('ID de la tâche') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ task_id }) => {
        try {
          await deleteTask(guildId, task_id);
          return ok({ ok: true, taskId: task_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_staff_call',
      {
        description: 'Crée un appel staff.',
        inputSchema: {
          creator_member: z.string().describe('Créateur staff'),
          title: z.string().describe('Titre'),
          scheduled_at: z.string().describe('Date ISO'),
          description: z.string().optional(),
          channel_mode: z.string().default('CREATE_NEW'),
          channel_type: z.string().optional(),
          discord_channel_id: z.string().optional(),
          is_temp_channel: z.boolean().optional(),
          invitees: z.array(z.string()).optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, title, description, scheduled_at, channel_mode, channel_type, discord_channel_id, is_temp_channel, invitees }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;

        const scheduledAt = new Date(scheduled_at);
        if (Number.isNaN(scheduledAt.getTime())) return err('Date d’appel invalide');

        try {
          const call = await createCall(
            client,
            guildId,
            creator.staffMember.userId,
            title.trim(),
            description?.trim() || null,
            scheduledAt,
            channel_mode,
            channel_type || null,
            discord_channel_id || null,
            is_temp_channel !== false,
            invitees || []
          );
          return ok({ ok: true, call });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_staff_call',
      {
        description: 'Met à jour un appel staff.',
        inputSchema: {
          call_id: z.string().describe('ID de l’appel'),
          title: z.string().optional(),
          description: z.string().nullable().optional(),
          scheduled_at: z.string().optional(),
          ended_at: z.string().optional(),
          status: z.enum(['SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELED']).optional(),
          invitees: z.array(z.string()).optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ call_id, title, description, scheduled_at, ended_at, status, invitees }) => {
        try {
          const data: { title?: string; description?: string | null; scheduledAt?: Date; endedAt?: Date; status?: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELED'; invitees?: string[] } = {};
          if (title !== undefined) data.title = title;
          if (description !== undefined) data.description = description;
          if (scheduled_at !== undefined) data.scheduledAt = new Date(scheduled_at);
          if (ended_at !== undefined) data.endedAt = new Date(ended_at);
          if (status !== undefined) data.status = status;
          if (invitees !== undefined) data.invitees = invitees;
          const call = await updateCall(client, guildId, call_id, data);
          return ok({ ok: true, call });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_staff_call',
      {
        description: 'Supprime un appel staff.',
        inputSchema: { call_id: z.string().describe('ID de l’appel') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ call_id }) => {
        try {
          await deleteCall(client, guildId, call_id);
          return ok({ ok: true, callId: call_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_call_permissions',
      {
        description: 'Met à jour la configuration des permissions d’appel staff.',
        inputSchema: {
          mode: z.enum(['EVERYONE', 'RESTRICTED']),
          allowed_role_ids: z.array(z.string()).default([]),
          allowed_user_ids: z.array(z.string()).default([]),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ mode, allowed_role_ids, allowed_user_ids }) => {
        try {
          const config = await updateCallPermissionConfig(guildId, {
            mode,
            allowedRoleIds: allowed_role_ids,
            allowedUserIds: allowed_user_ids,
          });
          return ok({ ok: true, config });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_staff_role',
      {
        description: 'Crée un rôle staff.',
        inputSchema: {
          name: z.string(),
          level: z.number().int(),
          discord_role_id: z.string().optional(),
          color: z.string().optional(),
          hierarchy_id: z.string().optional(),
          is_responsable: z.boolean().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, level, discord_role_id, color, hierarchy_id, is_responsable }) => {
        try {
          const role = await createStaffRole(guildId, name, level, discord_role_id, color, hierarchy_id, is_responsable);
          return ok({ ok: true, role });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_staff_role',
      {
        description: 'Met à jour un rôle staff.',
        inputSchema: {
          role_id: z.string(),
          name: z.string().optional(),
          level: z.number().int().optional(),
          discord_role_id: z.string().nullable().optional(),
          color: z.string().nullable().optional(),
          hierarchy_id: z.string().nullable().optional(),
          is_responsable: z.boolean().optional(),
          sort_order: z.number().int().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role_id, ...body }) => {
        try {
          const role = await updateStaffRole(guildId, role_id, body);
          if (!role) return err('Rôle staff introuvable');
          return ok({ ok: true, role });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'reorder_staff_roles',
      {
        description: 'Réordonne les rôles staff.',
        inputSchema: { ordered_role_ids: z.array(z.string()).min(1) },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ ordered_role_ids }) => {
        try {
          await reorderStaffRoles(guildId, ordered_role_ids);
          return ok({ ok: true, count: ordered_role_ids.length });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_staff_role',
      {
        description: 'Supprime un rôle staff.',
        inputSchema: { role_id: z.string() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role_id }) => {
        try {
          const deleted = await deleteStaffRole(guildId, role_id);
          if (!deleted) return err('Rôle staff introuvable');
          return ok({ ok: true, role: deleted });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_staff_hierarchy',
      {
        description: 'Crée une hiérarchie staff.',
        inputSchema: {
          name: z.string(),
          description: z.string().optional(),
          color: z.string().optional(),
          icon: z.string().optional(),
          discord_role_id: z.string().optional(),
          responsable_user_id: z.string().optional(),
          parent_hierarchy_id: z.string().nullable().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, description, color, icon, discord_role_id, responsable_user_id, parent_hierarchy_id }) => {
        try {
          const hierarchy = await createStaffHierarchy(guildId, name, description, color, icon, discord_role_id, responsable_user_id, parent_hierarchy_id ?? null);
          return ok({ ok: true, hierarchy });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'update_staff_hierarchy',
      {
        description: 'Met à jour une hiérarchie staff.',
        inputSchema: {
          hierarchy_id: z.string(),
          name: z.string().optional(),
          description: z.string().nullable().optional(),
          color: z.string().nullable().optional(),
          icon: z.string().nullable().optional(),
          discord_role_id: z.string().nullable().optional(),
          responsable_user_id: z.string().nullable().optional(),
          parent_hierarchy_id: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          sort_order: z.number().int().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ hierarchy_id, ...body }) => {
        try {
          const hierarchy = await updateStaffHierarchy(guildId, hierarchy_id, body);
          if (!hierarchy) return err('Hiérarchie introuvable');
          return ok({ ok: true, hierarchy });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_staff_hierarchy',
      {
        description: 'Supprime une hiérarchie staff.',
        inputSchema: { hierarchy_id: z.string() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ hierarchy_id }) => {
        try {
          const deleted = await deleteStaffHierarchy(guildId, hierarchy_id);
          if (!deleted) return err('Hiérarchie introuvable');
          return ok({ ok: true, hierarchy: deleted });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'add_staff_member_to_hierarchy',
      {
        description: 'Ajoute ou met à jour le grade d’un membre dans une hiérarchie staff.',
        inputSchema: {
          member: z.string(),
          hierarchy_id: z.string().optional(),
          grade: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, hierarchy_id, grade }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          const result = await addMemberToHierarchy(guildId, resolved.userId, hierarchy_id ?? null, grade ?? null);
          return ok({ ok: true, result });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'remove_staff_member_from_hierarchy',
      {
        description: 'Retire un membre d’une hiérarchie staff.',
        inputSchema: {
          member: z.string(),
          hierarchy_id: z.string(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, hierarchy_id }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          const result = await removeMemberFromHierarchy(guildId, resolved.userId, hierarchy_id);
          return ok({ ok: true, result });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'import_staff_role_members',
      {
        description: 'Importe les membres d’un rôle Discord dans une hiérarchie staff.',
        inputSchema: {
          hierarchy_id: z.string(),
          discord_role_id: z.string(),
          grade: z.string(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ hierarchy_id, discord_role_id, grade }) => {
        try {
          const result = await importRoleMembers(guildId, hierarchy_id, discord_role_id, grade);
          return ok({ ok: true, result });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'sync_staff_hierarchies',
      {
        description: 'Synchronise les appartenances hiérarchiques staff depuis les rôles Discord.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async () => {
        try {
          const result = await syncStaffHierarchyMemberships(guildId);
          return ok({ ok: true, result });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_staff_api_key',
      {
        description: 'Crée une clé API staff.',
        inputSchema: {
          creator_member: z.string(),
          name: z.string().optional(),
          permissions: z.array(z.string()).optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, name, permissions }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;

        try {
          const { fullKey, displayKey } = generateAPIKey();
          const keyHash = hashAPIKey(fullKey);
          const apiKey = await createAPIKey(
            guildId,
            creator.staffMember.userId,
            keyHash,
            displayKey,
            name ?? 'Mon clé API',
            permissions ?? ['daily_algo:create_exercise']
          );
          return ok({ ok: true, apiKey, fullKey });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_staff_api_key',
      {
        description: 'Désactive une clé API staff.',
        inputSchema: { key_id: z.string() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_id }) => {
        try {
          const key = await deleteAPIKey(guildId, key_id);
          return ok({ ok: true, key });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'create_manager_note',
      {
        description: 'Crée une note manager sur un membre staff.',
        inputSchema: {
          member: z.string(),
          creator_member: z.string(),
          content: z.string().describe('Contenu de la note'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, creator_member, content }) => {
        const target = await resolveMember(guildId, member);
        if (!target.ok) return target.response;
        const creator = await resolveMember(guildId, creator_member);
        if (!creator.ok) return creator.response;

        try {
          const note = await createManagerNote(guildId, target.userId, creator.userId, content);
          return ok({ ok: true, note });
        } catch (e) {
          return toolError(e);
        }
      })
    );

    server.registerTool(
      'delete_manager_note',
      {
        description: 'Supprime une note manager.',
        inputSchema: { note_id: z.string() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ note_id }) => {
        try {
          await deleteManagerNote(guildId, note_id);
          return ok({ ok: true, noteId: note_id });
        } catch (e) {
          return toolError(e);
        }
      })
    );
  }
}

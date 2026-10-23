import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
import { logger } from '../../../../utils/logger.js';
import { jsonFailure } from '../../../shared/failure.js';
import {
  json,
  readJsonBody,
  getGuildName,
  
  pushAudit,
  
  
  
  
} from '../../../shared.js';
import {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  getTasks,
  createTask,
  updateTask,
  deleteTask,
} from '../../../../services/staff/staffLeadershipService.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';

export async function handleTaskRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  const method = req.method;
  const auditUser = user.username ?? `User${user.userId}`;

    if (parts[4] === 'tasks') {
      // GET /api/dashboard/guilds/:guildId/tasks
      if (parts.length === 5 && method === 'GET') {
        try {
          const assigneeId = url.searchParams.get('assigneeId') || undefined;
          const tasks = await getTasks(guildId, assigneeId);
          json(res, 200, { tasks });
        } catch (err) {
          logger.error('StaffAPI', 'Error getting tasks:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des tâches', 'StaffAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/tasks
      if (parts.length === 5 && method === 'POST') {
        try {
          const body = await readJsonBody<{
            title: string;
            description?: string | null;
            priority: 'LOW' | 'MEDIUM' | 'HIGH';
            dueDate?: string | null;
            assigneeId: string;
          }>(req);

          if (!body?.title || !body?.assigneeId) {
            json(res, 400, { error: 'title et assigneeId sont obligatoires' });
            return true;
          }

          const dueDate = body.dueDate ? new Date(body.dueDate) : null;
          const task = await createTask(
            guildId,
            user.userId,
            body.title,
            body.description || null,
            body.priority || 'MEDIUM',
            dueDate,
            body.assigneeId
          );

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Création tâche',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Tâche "${body.title}" créée pour ${body.assigneeId}`,
            channelId: null,
          });

          json(res, 201, { task });
        } catch (err: unknown) {
          logger.error('StaffAPI', 'Error creating task:', err);
          json(res, 500, { error: publicErrorMessage(err, 'Erreur lors de la création de la tâche') });
        }
        return true;
      }

      // PATCH /api/dashboard/guilds/:guildId/tasks/:taskId
      if (parts.length === 6 && method === 'PATCH') {
        const taskId = parts[5];
        try {
          const body = await readJsonBody<{
            title?: string;
            description?: string | null;
            status?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
            priority?: 'LOW' | 'MEDIUM' | 'HIGH';
            dueDate?: string | null;
            assigneeId?: string;
          }>(req);

          const updateData: Record<string, unknown> = {};
          if (body?.title) updateData.title = body.title;
          if (body?.description !== undefined) updateData.description = body.description;
          if (body?.status) updateData.status = body.status;
          if (body?.priority) updateData.priority = body.priority;
          if (body?.dueDate !== undefined) updateData.dueDate = body.dueDate ? new Date(body.dueDate) : null;
          if (body?.assigneeId) updateData.assigneeId = body.assigneeId;

          const task = await updateTask(guildId, taskId, updateData);

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Mise à jour tâche',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Tâche ${taskId} mise à jour. Statut: ${task.status}`,
            channelId: null,
          });

          json(res, 200, { task });
        } catch (err: unknown) {
          logger.error('StaffAPI', 'Error updating task:', err);
          // Une tâche d'un autre serveur lève l'erreur « introuvable » de Prisma : 404, pas 500.
          jsonFailure(res, err, 'Erreur lors de la mise à jour de la tâche', 'StaffAPI');
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/tasks/:taskId
      if (parts.length === 6 && method === 'DELETE') {
        const taskId = parts[5];
        try {
          await deleteTask(guildId, taskId);

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Suppression tâche',
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Tâche ${taskId} supprimée`,
            channelId: null,
          });

          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('StaffAPI', 'Error deleting task:', err);
          jsonFailure(res, err, 'Erreur lors de la suppression de la tâche', 'StaffAPI');
        }
        return true;
      }
    }

    // Calls routes

  return false;
}

import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../../utils/logger.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  getTasks,
  createTask,
  updateTask,
  deleteTask,
} from '../../../../services/staff/staffLeadershipService.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';

export function createTasksRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/tasks`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const assigneeId = (c.req.query('assigneeId') ?? null) || undefined;
      const tasks = await getTasks(guildId, assigneeId);
      return send(c, { tasks });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting tasks:', err);
      return fail(c, err, 'Erreur lors de la récupération des tâches', 'StaffAPI');
    }
  });

  router.post(`${base}/tasks`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        title: string;
        description?: string | null;
        priority: 'LOW' | 'MEDIUM' | 'HIGH';
        dueDate?: string | null;
        assigneeId: string;
      }>(c);

      if (!body?.title || !body?.assigneeId) {
        return send(c, { error: 'title et assigneeId sont obligatoires' }, 400);
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

      return send(c, { task }, 201);
    } catch (err: unknown) {
      logger.error('StaffAPI', 'Error creating task:', err);
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de la création de la tâche') }, 500);
    }
  });

  router.patch(`${base}/tasks/:taskId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const taskId = c.req.param('taskId');
    try {
      const body = await readBody<{
        title?: string;
        description?: string | null;
        status?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
        priority?: 'LOW' | 'MEDIUM' | 'HIGH';
        dueDate?: string | null;
        assigneeId?: string;
      }>(c);

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

      return send(c, { task });
    } catch (err: unknown) {
      logger.error('StaffAPI', 'Error updating task:', err);
      // Une tâche d'un autre serveur lève l'erreur « introuvable » de Prisma : 404, pas 500.
      return fail(c, err, 'Erreur lors de la mise à jour de la tâche', 'StaffAPI');
    }
  });

  router.delete(`${base}/tasks/:taskId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const taskId = c.req.param('taskId');
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

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error deleting task:', err);
      return fail(c, err, 'Erreur lors de la suppression de la tâche', 'StaffAPI');
    }
  });

  return router;
}


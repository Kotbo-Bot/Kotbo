import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../../utils/logger.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { errorMessage } from '@kotbo/shared';
import { publicErrorMessage } from '../../../../utils/publicError.js';

export function createRemindersRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/reminders`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const { getGuildReminders } = await import('../../../../services/staff/reminderService.js');
      const reminders = await getGuildReminders(guildId, user.userId);
      return send(c, { reminders });
    } catch (err) {
      logger.error('RemindersAPI', 'Error getting reminders:', err);
      return fail(c, err, 'Erreur lors de la récupération des rappels', 'RemindersAPI');
    }
  });

  router.post(`${base}/reminders`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        message: string;
        targetTime: string;
        channelId?: string | null;
        taskId?: string | null;
        callId?: string | null;
        meetingId?: string | null;
      }>(c);

      if (!body?.message || !body?.targetTime) {
        return send(c, { error: 'Message et targetTime sont obligatoires' }, 400);
      }

      const targetTimeDate = new Date(body.targetTime);
      if (Number.isNaN(targetTimeDate.getTime()) || targetTimeDate <= new Date()) {
        return send(c, { error: 'La date/heure du rappel doit être dans le futur et valide' }, 400);
      }

      const { createReminder } = await import('../../../../services/staff/reminderService.js');
      const reminder = await createReminder({
        guildId,
        userId: user.userId,
        channelId: body.channelId,
        message: body.message,
        targetTime: targetTimeDate,
        taskId: body.taskId,
        callId: body.callId,
        meetingId: body.meetingId
      });

      return send(c, { reminder }, 201);
    } catch (err) {
      logger.error('RemindersAPI', 'Error creating reminder:', err);
      return fail(c, err, 'Erreur lors de la création du rappel', 'RemindersAPI');
    }
  });

  router.delete(`${base}/reminders/:reminderId`, ...gate, async (c) => {
    const user = c.var.dashboardUser;
    const reminderId = c.req.param('reminderId');
    try {
      const { deleteReminder } = await import('../../../../services/staff/reminderService.js');
      await deleteReminder(reminderId, user.userId);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('RemindersAPI', 'Error deleting reminder:', err);
      return send(c, { error: publicErrorMessage(err, 'Erreur lors de la suppression du rappel') }, errorMessage(err)?.includes('non autorisé') ? 403 : 500);
    }
  });

  return router;
}


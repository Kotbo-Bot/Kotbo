import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';
import { logger } from '../../../../utils/logger.js';
import { jsonFailure } from '../../../shared/failure.js';
import { errorMessage } from '@kotbo/shared';
import {
  json,
  readJsonBody,
  
  
  
  
  
  
  
} from '../../../shared.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';

export async function handleReminderRoutes(
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

    if (parts[4] === 'reminders') {
      // GET /api/dashboard/guilds/:guildId/reminders
      if (parts.length === 5 && method === 'GET') {
        try {
          const { getGuildReminders } = await import('../../../../services/staff/reminderService.js');
          const reminders = await getGuildReminders(guildId, user.userId);
          json(res, 200, { reminders });
        } catch (err) {
          logger.error('RemindersAPI', 'Error getting reminders:', err);
          jsonFailure(res, err, 'Erreur lors de la récupération des rappels', 'RemindersAPI');
        }
        return true;
      }

      // POST /api/dashboard/guilds/:guildId/reminders
      if (parts.length === 5 && method === 'POST') {
        try {
          const body = await readJsonBody<{
            message: string;
            targetTime: string;
            channelId?: string | null;
            taskId?: string | null;
            callId?: string | null;
            meetingId?: string | null;
          }>(req);

          if (!body?.message || !body?.targetTime) {
            json(res, 400, { error: 'Message et targetTime sont obligatoires' });
            return true;
          }

          const targetTimeDate = new Date(body.targetTime);
          if (Number.isNaN(targetTimeDate.getTime()) || targetTimeDate <= new Date()) {
            json(res, 400, { error: 'La date/heure du rappel doit être dans le futur et valide' });
            return true;
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

          json(res, 201, { reminder });
        } catch (err) {
          logger.error('RemindersAPI', 'Error creating reminder:', err);
          jsonFailure(res, err, 'Erreur lors de la création du rappel', 'RemindersAPI');
        }
        return true;
      }

      // DELETE /api/dashboard/guilds/:guildId/reminders/:reminderId
      if (parts.length === 6 && method === 'DELETE') {
        const reminderId = parts[5];
        try {
          const { deleteReminder } = await import('../../../../services/staff/reminderService.js');
          await deleteReminder(reminderId, user.userId);
          json(res, 200, { ok: true });
        } catch (err) {
          logger.error('RemindersAPI', 'Error deleting reminder:', err);
          json(res, errorMessage(err)?.includes('non autorisé') ? 403 : 500, { error: publicErrorMessage(err, 'Erreur lors de la suppression du rappel') });
        }
        return true;
      }
    }

  return false;
}

import { Client, EmbedBuilder, type TextChannel } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import { notify } from '../notifications/notifyService.js';
import { fetchGuildChannel, isGuildChannel } from '../../utils/panelMessage.js';
import { UserFacingError } from '../../utils/userFacingError.js';

export async function processDueReminders(client: Client) {
  const now = new Date();
  
  try {
    // 1. Fetch due reminders that have not been fired yet
    const reminders = await prisma.staffReminder.findMany({
      where: {
        fired: false,
        targetTime: { lte: now }
      },
      include: {
        task: true,
        call: true,
        meeting: true
      }
    });

    if (reminders.length === 0) return;

    logger.info('Reminders', `Traitement de ${reminders.length} rappel(s) dû(s)...`);

    for (const reminder of reminders) {
      try {
        // Fetch user
        const user = await client.users.fetch(reminder.userId).catch(() => null);
        if (!user) {
          logger.warn('Reminders', `Utilisateur Discord ${reminder.userId} introuvable pour le rappel ${reminder.id}`);
          await prisma.staffReminder.update({
            where: { id: reminder.id },
            data: { fired: true }
          });
          continue;
        }

        // Build embed
        const embed = new EmbedBuilder()
          .setColor(COLORS?.warning || 0xF5A623)
          .setTitle('⏰ Kotbo - Rappel !')
          .setDescription(reminder.message)
          .setTimestamp(reminder.targetTime);

        // Add linked item details if any
        if (reminder.task) {
          embed.addFields({ name: '📋 Tâche liée', value: `**${reminder.task.title}**\n${reminder.task.description || 'Pas de description'}` });
        } else if (reminder.call) {
          embed.addFields({ name: '📞 Appel lié', value: `**${reminder.call.title}**\n${reminder.call.description || 'Pas de description'}` });
        } else if (reminder.meeting) {
          embed.addFields({ name: '📅 Réunion liée', value: `**${reminder.meeting.title}**\n${reminder.meeting.description || 'Pas de description'}` });
        }

        let sent = false;

        // Try to send to channel if specified
        if (reminder.channelId) {
          const channel = await fetchGuildChannel(client, reminder.guildId, reminder.channelId);
          if (channel && channel.isTextBased()) {
            await (channel as TextChannel).send({
              content: `🔔 <@${reminder.userId}>`,
              embeds: [embed]
            });
            sent = true;
          }
        }

        // Fallback or default to DM
        if (!sent) {
          const linked = (embed.data.fields ?? []).map((f) => `**${f.name}**\n${f.value}`);
          await notify({
            guildId: reminder.guildId,
            userId: reminder.userId,
            kind: 'planning.reminder',
            title: 'Rappel',
            message: [reminder.message, ...linked].join('\n\n'),
            severity: 'WARNING',
          });
          sent = true;
        }

        // Mark as fired
        await prisma.staffReminder.update({
          where: { id: reminder.id },
          data: { fired: true }
        });
        
        logger.info('Reminders', `Rappel ${reminder.id} envoyé avec succès à ${user.tag}`);
      } catch (err) {
        logger.error('Reminders', `Erreur lors de l'envoi du rappel ${reminder.id}:`, err);
        // Mark as fired anyway to avoid locking the loop on errors (e.g., closed DMs)
        await prisma.staffReminder.update({
          where: { id: reminder.id },
          data: { fired: true }
        });
      }
    }
  } catch (err) {
    logger.error('Reminders', 'Erreur lors du traitement des rappels:', err);
  }
}

export async function getGuildReminders(guildId: string, userId: string) {
  return prisma.staffReminder.findMany({
    where: {
      guildId,
      userId,
      fired: false
    },
    orderBy: {
      targetTime: 'asc'
    }
  });
}

export async function createReminder(data: {
  guildId: string;
  userId: string;
  channelId?: string | null;
  message: string;
  targetTime: Date;
  taskId?: string | null;
  callId?: string | null;
  meetingId?: string | null;
}) {
  // Salon et éléments liés doivent appartenir à ce serveur : sinon le rappel publierait dans un
  // autre serveur ou recopierait le titre et la description d'une réunion privée d'ailleurs.
  if (data.channelId && !(await isGuildChannel(data.guildId, data.channelId))) {
    throw new UserFacingError('Salon introuvable sur ce serveur.');
  }
  const owned = async (id: string | null | undefined, find: (id: string) => Promise<unknown>) =>
    !id || Boolean(await find(id));
  const inGuild = { guildId: data.guildId };
  if (
    !(await owned(data.taskId, (id) => prisma.staffTask.findFirst({ where: { id, ...inGuild }, select: { id: true } }))) ||
    !(await owned(data.callId, (id) => prisma.staffCall.findFirst({ where: { id, ...inGuild }, select: { id: true } }))) ||
    !(await owned(data.meetingId, (id) => prisma.staffMeeting.findFirst({ where: { id, ...inGuild }, select: { id: true } })))
  ) {
    throw new UserFacingError('Élément du planning introuvable sur ce serveur.');
  }

  return prisma.staffReminder.create({
    data: {
      guildId: data.guildId,
      userId: data.userId,
      channelId: data.channelId ?? null,
      message: data.message,
      targetTime: data.targetTime,
      taskId: data.taskId ?? null,
      callId: data.callId ?? null,
      meetingId: data.meetingId ?? null
    }
  });
}

export async function deleteReminder(id: string, userId: string) {
  const reminder = await prisma.staffReminder.findUnique({
    where: { id }
  });

  if (!reminder || reminder.userId !== userId) {
    throw new Error('Rappel introuvable ou accès non autorisé');
  }

  return prisma.staffReminder.delete({
    where: { id }
  });
}

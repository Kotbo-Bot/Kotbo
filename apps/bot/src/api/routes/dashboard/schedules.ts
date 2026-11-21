import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import cron from 'node-cron';
import prisma from '../../../utils/db.js';
import { Prisma } from '@prisma/client';
import { logger } from '../../../utils/logger.js';
import { pushAudit } from '../../shared.js';
import { reloadSchedule, stopSchedule, executeSchedule } from '../../../services/system/scheduleService.js';

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { assertFreeQuota } from '../../../services/system/freeQuota.js';
/** Texte du message programme. Vide = pas de texte, l'embed peut suffire. */
function messageText(value: unknown): string | null {
  // 2000 caracteres : la limite d'un message Discord. Tronquer ici evite un
  // echec au moment de l'envoi, des heures apres l'enregistrement.
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null;
}

/**
 * Ne garde de l'embed que les quatre champs qu'on sait rendre, et refuse les
 * images servies ailleurs qu'en HTTPS. Un embed sans aucun champ utile revient
 * a ne pas en avoir : on renvoie `null` plutot qu'un objet vide.
 */
function sanitizeScheduledEmbed(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!value || typeof value !== 'object') return Prisma.JsonNull;
  const raw = value as Record<string, unknown>;

  const embed: Record<string, string> = {};
  if (typeof raw.title === 'string' && raw.title.trim()) embed.title = raw.title.trim().slice(0, 256);
  if (typeof raw.description === 'string' && raw.description.trim()) embed.description = raw.description.trim().slice(0, 4096);
  if (typeof raw.imageUrl === 'string' && /^https:\/\//.test(raw.imageUrl)) embed.imageUrl = raw.imageUrl.slice(0, 500);
  if (typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)) embed.color = raw.color;

  return Object.keys(embed).length > 0 ? embed : Prisma.JsonNull;
}

export function createSchedulesRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Administrateur seulement, sur un serveur présent dans le cache du bot.
  const scheduleAccess = createMiddleware(async (c, next) => {
    if (!c.var.access.canManageSettings) return send(c, { error: 'Accès refusé' }, 403);
    if (!client.guilds.cache.get(c.req.param('guildId')!)) return send(c, { error: 'Serveur non trouvé' }, 404);
    await next();
  });
  const gate = [...guildRoute(client), scheduleAccess] as const;


  router.get(`${base}/schedules`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const schedules = await prisma.scheduledTask.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
      });
      return send(c, schedules);
    } catch (error) {
      logger.error('SchedulesAPI', 'Error fetching schedules:', error);
      return fail(c, error, 'Erreur lors de la récupération des planifications', 'SchedulesAPI');
    }
  });

  router.post(`${base}/schedules`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody<{
        name?: string;
        type?: string;
        cron?: string;
        targetId?: string | null;
        enabled?: boolean;
        message?: string | null;
        messageEmbed?: unknown;
        allowMentions?: boolean;
        runOnce?: boolean;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de la requête invalide' }, 400);
      }

      if (!body.name || !body.type || !body.cron) {
        return send(c, { error: 'Champs obligatoires manquants (name, type, cron)' }, 400);
      }

      if (!['CHANNEL_RESET', 'DATA_EXPORT', 'SERVER_BACKUP', 'SEND_MESSAGE'].includes(body.type)) {
        return send(c, { error: 'Type de tâche invalide' }, 400);
      }

      if (!cron.validate(body.cron)) {
        return send(c, { error: 'Expression cron invalide' }, 400);
      }

      await assertFreeQuota(guildId, 'scheduledTasks', () => prisma.scheduledTask.count({ where: { guildId } }));

      const schedule = await prisma.scheduledTask.create({
        data: {
          guildId,
          name: body.name,
          type: body.type,
          cron: body.cron,
          targetId: body.targetId || null,
          enabled: body.enabled ?? true,
          message: messageText(body.message),
          messageEmbed: sanitizeScheduledEmbed(body.messageEmbed),
          allowMentions: body.allowMentions === true,
          runOnce: body.runOnce === true,
        },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: user.username ?? `User${user.userId}`,
        action: 'Création planification',
        context: body.name,
        module: 'Planificateur',
        eventType: 'Settings',
        details: `Nom: ${body.name} | Type: ${body.type} | Cron: ${body.cron}${body.targetId ? ` | Cible: ${body.targetId}` : ''} | Actif: ${body.enabled ?? true}`,
      });

      // Register the cron job in scheduleService
      if (schedule.enabled) {
        await reloadSchedule(client, schedule.id);
      }

      return send(c, schedule);
    } catch (error) {
      logger.error('SchedulesAPI', 'Error creating schedule:', error);
      return fail(c, error, 'Erreur lors de la création de la planification', 'SchedulesAPI');
    }
  });

  router.patch(`${base}/schedules/:scheduleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const scheduleId = c.req.param('scheduleId');
      const body = await readBody<{
        name?: string;
        type?: string;
        cron?: string;
        targetId?: string | null;
        enabled?: boolean;
        message?: string | null;
        messageEmbed?: unknown;
        allowMentions?: boolean;
        runOnce?: boolean;
      }>(c);

      if (!body) {
        return send(c, { error: 'Corps de la requête invalide' }, 400);
      }

      const existing = await prisma.scheduledTask.findUnique({
        where: { id: scheduleId },
      });

      if (!existing || existing.guildId !== guildId) {
        return send(c, { error: 'Planification non trouvée' }, 404);
      }

      if (body.type && !['CHANNEL_RESET', 'DATA_EXPORT', 'SERVER_BACKUP', 'SEND_MESSAGE'].includes(body.type)) {
        return send(c, { error: 'Type de tâche invalide' }, 400);
      }

      if (body.cron && !cron.validate(body.cron)) {
        return send(c, { error: 'Expression cron invalide' }, 400);
      }

      const updated = await prisma.scheduledTask.update({
        where: { id: scheduleId },
        data: {
          name: body.name ?? undefined,
          type: body.type ?? undefined,
          cron: body.cron ?? undefined,
          targetId: body.targetId !== undefined ? body.targetId : undefined,
          enabled: body.enabled ?? undefined,
          message: body.message !== undefined ? messageText(body.message) : undefined,
          messageEmbed: body.messageEmbed !== undefined ? sanitizeScheduledEmbed(body.messageEmbed) : undefined,
          allowMentions: body.allowMentions !== undefined ? body.allowMentions === true : undefined,
          runOnce: body.runOnce !== undefined ? body.runOnce === true : undefined,
        },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: user.username ?? `User${user.userId}`,
        action: 'Modification planification',
        context: updated.name,
        module: 'Planificateur',
        eventType: 'Settings',
        details: `Nom: ${updated.name} | Type: ${updated.type} | Cron: ${updated.cron}${updated.targetId ? ` | Cible: ${updated.targetId}` : ''} | Actif: ${updated.enabled}`,
      });

      // Reload or stop the cron job
      if (updated.enabled) {
        await reloadSchedule(client, updated.id);
      } else {
        stopSchedule(updated.id);
      }

      return send(c, updated);
    } catch (error) {
      logger.error('SchedulesAPI', 'Error updating schedule:', error);
      return fail(c, error, 'Erreur lors de la mise à jour de la planification', 'SchedulesAPI');
    }
  });

  router.delete(`${base}/schedules/:scheduleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const scheduleId = c.req.param('scheduleId');
      const existing = await prisma.scheduledTask.findUnique({
        where: { id: scheduleId },
      });

      if (!existing || existing.guildId !== guildId) {
        return send(c, { error: 'Planification non trouvée' }, 404);
      }

      // Stop cron job
      stopSchedule(scheduleId);

      await prisma.scheduledTask.delete({
        where: { id: scheduleId },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: user.username ?? `User${user.userId}`,
        action: 'Suppression planification',
        context: existing.name,
        module: 'Planificateur',
        eventType: 'Settings',
        details: `Nom: ${existing.name} | Type: ${existing.type} | Cron: ${existing.cron}`,
      });

      return send(c, { success: true });
    } catch (error) {
      logger.error('SchedulesAPI', 'Error deleting schedule:', error);
      return fail(c, error, 'Erreur lors de la suppression de la planification', 'SchedulesAPI');
    }
  });

  router.post(`${base}/schedules/:scheduleId/run`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const scheduleId = c.req.param('scheduleId');
      const existing = await prisma.scheduledTask.findUnique({
        where: { id: scheduleId },
      });

      if (!existing || existing.guildId !== guildId) {
        return send(c, { error: 'Planification non trouvée' }, 404);
      }

      // Execute asynchronously to not block API response
      executeSchedule(client, scheduleId).catch((err) => {
        logger.error('SchedulesAPI', `Error during manual execution of task ${scheduleId}:`, err);
      });

      await pushAudit(guildId, {
        channelId: null,
        user: user.username ?? `User${user.userId}`,
        action: 'Exécution planification',
        context: existing.name,
        module: 'Planificateur',
        eventType: 'Settings',
        details: `Nom: ${existing.name} | Type: ${existing.type} | Exécution manuelle déclenchée par le staff`,
      });

      return send(c, { success: true });
    } catch (error) {
      logger.error('SchedulesAPI', 'Error running schedule now:', error);
      return fail(c, error, 'Erreur lors du lancement de la planification', 'SchedulesAPI');
    }
  });

  return router;
}


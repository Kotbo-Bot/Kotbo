import { Hono } from 'hono';
import { Client, EmbedBuilder } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  checkRateLimit,
  errorReportRateLimiter,
} from '../shared.js';
import { dashboardAuth, readBody, requestIp, send } from '../hono/dashboard/kit.js';

export function createReportErrorRouter(client: Client) {
  const router = new Hono();

  // POST /api/report-error
  router.post('/api/report-error', dashboardAuth, async (c) => {
    const ip = requestIp(c) || '127.0.0.1';
    if (!checkRateLimit(errorReportRateLimiter, ip, 5, 15 * 60 * 1000)) {
      return send(c, { error: "Trop de rapports d'erreur envoyés. Veuillez réessayer plus tard." }, 429);
    }

    try {
      const body = await readBody<{
        error: unknown;
        stack?: unknown;
        url: unknown;
        userAgent: unknown;
        guildId?: unknown;
      }>(c);

      if (!body) {
        return send(c, { error: 'Payload invalide' }, 400);
      }

      const { error, stack, url: errorUrl, userAgent, guildId } = body;

      if (
        typeof error !== 'string' ||
        error.trim() === '' ||
        (stack !== undefined && typeof stack !== 'string') ||
        (errorUrl !== undefined && typeof errorUrl !== 'string') ||
        (userAgent !== undefined && typeof userAgent !== 'string') ||
        (guildId !== undefined && guildId !== null && typeof guildId !== 'string')
      ) {
        return send(c, { error: 'Payload invalide' }, 400);
      }

      const errorStr = error.slice(0, 1000);
      const stackStr = stack ? stack.slice(0, 2000) : undefined;
      const urlStr = errorUrl ? errorUrl.slice(0, 500) : 'Inconnu';
      const userAgentStr = userAgent ? userAgent.slice(0, 250) : 'Inconnu';
      const guildIdStr = guildId ? guildId.slice(0, 50) : 'Aucun';

      const allowedOriginPattern = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)*(kotbo\.fr|localhost)(:\d+)?(\/.*)?$/;
      if (errorUrl && !allowedOriginPattern.test(errorUrl)) {
        return send(c, { error: 'URL non autorisée' }, 400);
      }

      const sanitizeMarkdown = (str: string) => str.replace(/`/g, '\\`');
      // Discord refuse une valeur de champ d'embed > 1024 caracteres : on tronque
      // apres echappement, en reservant la place des balises autour.
      const FIELD_MAX = 1024;
      const fitField = (str: string, wrapperLength: number) =>
        sanitizeMarkdown(str).slice(0, FIELD_MAX - wrapperLength);

      const user = c.var.dashboardUser;
      const userInfo = `**Utilisateur:** <@${user.userId}> (${user.username} - ID: ${user.userId})`;

      const ownerId = process.env.DISCORD_CLIENT_OWNER_ID;
      const adminsFromDb = await prisma.globalAdmin.findMany({
        select: { userId: true },
      });
      const adminIds = new Set<string>();
      if (ownerId) {
        adminIds.add(ownerId);
      }
      for (const a of adminsFromDb) {
        adminIds.add(a.userId);
      }

      if (adminIds.size === 0) {
        logger.error("Aucun administrateur configuré pour recevoir le rapport d'erreur.");
        return send(c, { error: 'Aucun administrateur configuré' }, 500);
      }

      const embed = new EmbedBuilder()
        .setTitle("🚨 Rapport d'erreur du Dashboard")
        .setColor(0xff0000)
        .setTimestamp()
        .addFields(
          { name: '👤 Utilisateur', value: userInfo },
          { name: '🌐 Page / URL', value: `\`${fitField(urlStr, 2)}\`` },
          { name: '💻 Navigateur', value: `\`${fitField(userAgentStr, 2)}\`` },
          { name: '🏰 Serveur sélectionné (Guild ID)', value: `\`${fitField(guildIdStr, 2)}\`` },
          { name: '❌ Erreur', value: `\`\`\`\n${fitField(errorStr, 8)}\n\`\`\`` },
        );

      if (stackStr) {
        embed.addFields({ name: '🥞 Stack Trace', value: `\`\`\`javascript\n${fitField(stackStr, 21)}\n\`\`\`` });
      }

      let sentCount = 0;
      for (const adminId of adminIds) {
        try {
          const adminUser = await client.users.fetch(adminId).catch(() => null);
          if (adminUser) {
            await adminUser.send({ embeds: [embed] });
            sentCount++;
          } else {
            logger.warn('ReportError', `Impossible de trouver l'administrateur avec l'ID ${adminId}`);
          }
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
          logger.error('ReportError', `Erreur lors de l'envoi du rapport à l'admin ${adminId}: ${errMessage}`);
        }
      }

      if (sentCount === 0) {
        return send(c, { error: "Impossible d'envoyer le rapport aux administrateurs" }, 500);
      }

      return send(c, { success: true }, 200);
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error('ReportError', `Erreur lors de la transmission du rapport d'erreur: ${errMessage}`);
      return send(c, { error: 'Erreur lors de la transmission' }, 500);
    }
  });

  return router;
}

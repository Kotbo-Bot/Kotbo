import { Hono } from 'hono';
import { Client, EmbedBuilder } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  checkRateLimit,
  feedbackReportRateLimiter,
} from '../shared.js';
import { dashboardAuth, readBody, requestIp, send } from '../hono/dashboard/kit.js';

export function createReportFeedbackRouter(client: Client) {
  const router = new Hono();

  // POST /api/report-feedback
  router.post('/api/report-feedback', dashboardAuth, async (c) => {
    const ip = requestIp(c) || '127.0.0.1';
    if (!checkRateLimit(feedbackReportRateLimiter, ip, 5, 15 * 60 * 1000)) {
      return send(c, { error: 'Trop de retours envoyés. Veuillez réessayer plus tard.' }, 429);
    }

    try {
      const payload = await readBody<{
        type: 'retour' | 'bloquage' | 'suggestion' | 'autre';
        message: string;
        url: string;
        guildId?: string | null;
      }>(c);

      if (
        !payload ||
        typeof payload.type !== 'string' ||
        !['retour', 'bloquage', 'suggestion', 'autre'].includes(payload.type) ||
        typeof payload.message !== 'string' ||
        payload.message.trim() === '' ||
        typeof payload.url !== 'string' ||
        (payload.guildId !== undefined && payload.guildId !== null && typeof payload.guildId !== 'string')
      ) {
        return send(c, { error: 'Payload invalide' }, 400);
      }

      const messageStr = payload.message.slice(0, 2000);
      const urlStr = payload.url.slice(0, 500);
      const guildIdStr = payload.guildId ? payload.guildId.slice(0, 50) : 'Aucun';

      const allowedOriginPattern = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)*(kotbo\.fr|localhost)(:\d+)?(\/.*)?$/;
      if (payload.url && !allowedOriginPattern.test(payload.url)) {
        return send(c, { error: 'URL non autorisée' }, 400);
      }

      const sanitizeMarkdown = (str: string) => str.replace(/`/g, '\\`');

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
        logger.error('Aucun administrateur configuré pour recevoir le retour.');
        return send(c, { error: 'Aucun administrateur configuré' }, 500);
      }

      const typeLabels: Record<string, string> = {
        retour: "📬 Retour d'expérience",
        bloquage: '🛑 Bloquage / Bug',
        suggestion: "💡 Suggestion d'amélioration",
        autre: '💬 Autre retour',
      };

      const typeColors: Record<string, number> = {
        retour: 0x3b82f6,      // Blue
        bloquage: 0xef4444,    // Red
        suggestion: 0x10b981,  // Emerald green
        autre: 0x8b5cf6,       // Purple
      };

      const embed = new EmbedBuilder()
        .setTitle(`💬 Nouveau retour : ${typeLabels[payload.type] || payload.type}`)
        .setColor(typeColors[payload.type] || 0x8b5cf6)
        .setTimestamp()
        .addFields(
          { name: '👤 Utilisateur', value: userInfo },
          { name: '🌐 Page / URL', value: `\`${sanitizeMarkdown(urlStr)}\`` },
          { name: '🏰 Serveur sélectionné', value: `\`${sanitizeMarkdown(guildIdStr)}\`` },
          { name: '📝 Message / Description', value: messageStr },
        );

      let sentCount = 0;
      for (const adminId of adminIds) {
        try {
          const adminUser = await client.users.fetch(adminId).catch(() => null);
          if (adminUser) {
            await adminUser.send({ embeds: [embed] });
            sentCount++;
          } else {
            logger.warn('ReportFeedback', `Impossible de trouver l'administrateur avec l'ID ${adminId}`);
          }
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
          logger.error('ReportFeedback', `Erreur lors de l'envoi du retour à l'admin ${adminId}: ${errMessage}`);
        }
      }

      if (sentCount === 0) {
        return send(c, { error: "Impossible d'envoyer le retour aux administrateurs" }, 500);
      }

      return send(c, { success: true }, 200);
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error('ReportFeedback', `Erreur lors de la transmission du retour: ${errMessage}`);
      return send(c, { error: 'Erreur lors de la transmission' }, 500);
    }
  });

  return router;
}

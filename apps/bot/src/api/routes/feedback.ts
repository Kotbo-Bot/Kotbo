import { Hono } from 'hono';
import { Client, EmbedBuilder } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  checkRateLimit,
  feedbackReportRateLimiter,
} from '../shared.js';
import { dashboardAuth, readBody, requestIp, send } from '../hono/dashboard/kit.js';
import { resolveAdminAccess } from '../shared.js';
import { recordAdminAudit } from '../../services/system/adminAuditService.js';
import {
  canAccessFeedback,
  cleanFeedbackText,
  isFeedbackStatus,
  listGlobalAdminIds,
  notifyFeedbackAdmins,
  notifyFeedbackAuthor,
  FEEDBACK_TYPES,
} from '../../services/system/feedbackService.js';

const FEEDBACK_ID = /^[a-z0-9]{20,32}$/;
const replyLimiter = new Map<string, number[]>();

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

      const adminIds = await listGlobalAdminIds();

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

      // Le retour est conservé pour le suivi ; si la base échoue, le MP part quand même.
      const saved = await prisma.feedback
        .create({
          data: {
            userId: user.userId,
            username: (user.username ?? user.userId).slice(0, 100),
            type: payload.type,
            message: messageStr,
            url: urlStr,
            guildId: payload.guildId ? guildIdStr : null,
          },
          select: { id: true },
        })
        .catch((err: unknown) => {
          logger.error('ReportFeedback', `Retour non enregistré : ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });

      const embed = new EmbedBuilder()
        .setTitle(`💬 Nouveau retour : ${typeLabels[payload.type] || payload.type}`)
        .setColor(typeColors[payload.type] || 0x8b5cf6)
        .setDescription(`📝 **Message / Description**\n${messageStr}`)
        .setTimestamp()
        .addFields(
          { name: '👤 Utilisateur', value: userInfo },
          { name: '🌐 Page / URL', value: `\`${sanitizeMarkdown(urlStr)}\`` },
          { name: '🏰 Serveur sélectionné', value: `\`${sanitizeMarkdown(guildIdStr)}\`` },
        );
      if (saved) embed.setFooter({ text: `Retour ${saved.id}` });

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

  // Mes retours : statut et dernier échange, du plus récent au plus ancien.
  router.get('/api/feedback/mine', dashboardAuth, async (c) => {
    const feedbacks = await prisma.feedback.findMany({
      where: { userId: c.var.dashboardUser.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, type: true, message: true, status: true, createdAt: true, updatedAt: true, _count: { select: { messages: true } } },
    });
    return send(c, { feedbacks });
  });

  // Fiche d'un retour avec sa conversation : auteur et admins globaux seulement.
  router.get('/api/feedback/:id', dashboardAuth, async (c) => {
    const id = c.req.param('id');
    const user = c.var.dashboardUser;
    if (!FEEDBACK_ID.test(id)) return send(c, { error: 'Retour introuvable' }, 404);
    const feedback = await prisma.feedback.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } },
    });
    const isAdmin = await resolveAdminAccess(client, user.userId);
    // 404 plutôt que 403 : on ne confirme pas l'existence d'un retour d'autrui.
    if (!feedback || !canAccessFeedback(feedback, user.userId, isAdmin)) return send(c, { error: 'Retour introuvable' }, 404);
    return send(c, { feedback });
  });

  router.post('/api/feedback/:id/messages', dashboardAuth, async (c) => {
    const id = c.req.param('id');
    const user = c.var.dashboardUser;
    if (!FEEDBACK_ID.test(id)) return send(c, { error: 'Retour introuvable' }, 404);
    if (!checkRateLimit(replyLimiter, user.userId, 20, 15 * 60 * 1000)) {
      return send(c, { error: 'Trop de messages envoyés. Veuillez réessayer plus tard.' }, 429);
    }
    const body = await readBody<{ content?: unknown }>(c);
    const content = cleanFeedbackText(body?.content);
    if (!content) return send(c, { error: 'Message vide' }, 400);

    const feedback = await prisma.feedback.findUnique({ where: { id } });
    const isAdmin = await resolveAdminAccess(client, user.userId);
    if (!feedback || !canAccessFeedback(feedback, user.userId, isAdmin)) return send(c, { error: 'Retour introuvable' }, 404);

    const fromStaff = isAdmin && feedback.userId !== user.userId;
    const username = (user.username ?? user.userId).slice(0, 100);
    const message = await prisma.feedbackMessage.create({
      data: { feedbackId: id, authorId: user.userId, authorName: username, fromStaff, content },
    });
    await prisma.feedback.update({ where: { id }, data: { updatedAt: new Date() } });
    if (fromStaff) await notifyFeedbackAuthor(client, feedback, { reply: content });
    else await notifyFeedbackAdmins(client, feedback, username, content);
    return send(c, { message }, 201);
  });

  // ── Administration : réservée aux admins globaux Kotbo ──────────────────────

  router.get('/api/admin/feedback', dashboardAuth, async (c) => {
    if (!(await resolveAdminAccess(client, c.var.dashboardUser.userId))) return send(c, { error: 'Accès administrateur requis' }, 403);
    const status = c.req.query('status');
    const type = c.req.query('type');
    const feedbacks = await prisma.feedback.findMany({
      where: {
        ...(isFeedbackStatus(status) ? { status } : {}),
        ...(type && (FEEDBACK_TYPES as readonly string[]).includes(type) ? { type } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, userId: true, username: true, type: true, message: true, url: true, guildId: true, status: true, createdAt: true, updatedAt: true, _count: { select: { messages: true } } },
    });
    return send(c, { feedbacks });
  });

  router.post('/api/admin/feedback/:id/status', dashboardAuth, async (c) => {
    const user = c.var.dashboardUser;
    if (!(await resolveAdminAccess(client, user.userId))) return send(c, { error: 'Accès administrateur requis' }, 403);
    const id = c.req.param('id');
    const body = await readBody<{ status?: unknown; message?: unknown }>(c);
    if (!FEEDBACK_ID.test(id) || !isFeedbackStatus(body?.status)) return send(c, { error: 'Payload invalide' }, 400);
    const reply = body?.message === undefined || body.message === '' ? null : cleanFeedbackText(body.message);
    if (body?.message !== undefined && body.message !== '' && !reply) return send(c, { error: 'Message invalide' }, 400);

    const existing = await prisma.feedback.findUnique({ where: { id } });
    if (!existing) return send(c, { error: 'Retour introuvable' }, 404);
    const status = body.status;
    const feedback = await prisma.feedback.update({ where: { id }, data: { status } });
    if (reply) {
      await prisma.feedbackMessage.create({
        data: { feedbackId: id, authorId: user.userId, authorName: (user.username ?? user.userId).slice(0, 100), fromStaff: true, content: reply },
      });
    }
    if (existing.status !== status || reply) {
      await notifyFeedbackAuthor(client, feedback, { status: existing.status !== status ? status : undefined, reply: reply ?? undefined });
    }
    void recordAdminAudit({
      actorId: user.userId,
      actorName: user.username ?? null,
      action: 'feedback.status',
      targetType: 'feedback',
      targetId: id,
      summary: `Retour passé de ${existing.status} à ${status}`,
      ip: requestIp(c),
    });
    return send(c, { feedback });
  });

  return router;
}

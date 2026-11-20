import type { Client } from 'discord.js';
import { Hono } from 'hono';
/** Routes dashboard du module `regulation`. */
import { publishOrUpdateRegulationMessage, renumberRegulationArticles } from '../../../../services/staff/regulationService.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';
export function createRegulationRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.post(`${base}/regulation/articles`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        title?: string;
        description?: string;
        emoji?: string | null;
        sortOrder?: number | string | null;
        enabled?: boolean;
      }>(c);

      const title = body?.title?.trim() ?? '';
      const description = body?.description?.trim() ?? '';
      const emoji = body?.emoji?.trim() ?? null;
      const providedSortOrder = body?.sortOrder !== undefined ? Number(body.sortOrder) : null;
      const highestSortOrder = await prisma.guildRegulationArticle.findFirst({
        where: { guildId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const sortOrder = Number.isFinite(providedSortOrder)
        ? (providedSortOrder as number)
        : (highestSortOrder?.sortOrder ?? -1) + 1;

      if (!title || !description) {
        return send(c, { error: 'Le titre et la description sont obligatoires.' }, 400);
      }

      const article = await prisma.guildRegulationArticle.create({
        data: {
          guildId,
          title,
          description,
          emoji: emoji || null,
          sortOrder,
          enabled: body?.enabled ?? true,
        },
      });

      await renumberRegulationArticles(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Création article règlement',
        context: getGuildName(client, guildId),
        module: 'Règlement',
        eventType: 'Manuel',
        details: `Article "${article.title}" ajouté au règlement.`,
        channelId: null
      });

      return send(c, { ok: true, articleId: article.id }, 201);
    } catch (err) {
      logger.error('RegulationAPI', 'Error creating regulation article:', err);
      return fail(c, err, "Erreur lors de la création de l'article", 'RegulationAPI');
    }
  });

  router.patch(`${base}/regulation/articles/reorder`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{ articleIds?: unknown }>(c);
      const requestedIds = Array.isArray(body?.articleIds)
        ? body.articleIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];

      if (requestedIds.length === 0) {
        return send(c, { error: 'La liste des articles à réordonner est invalide.' }, 400);
      }

      const orderedIds = await renumberRegulationArticles(guildId, requestedIds);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Réordonnancement articles règlement',
        context: getGuildName(client, guildId),
        module: 'Règlement',
        eventType: 'Manuel',
        details: `${orderedIds.length} article(s) réorganisé(s).`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('RegulationAPI', 'Error reordering articles:', err);
      return fail(c, err, 'Erreur lors du réordonnancement des articles', 'RegulationAPI');
    }
  });

  router.patch(`${base}/regulation/articles/:articleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const articleId = c.req.param('articleId');
    try {
      const existingArticle = await prisma.guildRegulationArticle.findFirst({
        where: { id: articleId, guildId },
      });

      if (!existingArticle) {
        return send(c, { error: 'Article de règlement introuvable.' }, 404);
      }

      const body = await readBody<{
        title?: string;
        description?: string;
        emoji?: string | null;
        sortOrder?: number | string | null;
        enabled?: boolean;
      }>(c);

      const title = typeof body?.title === 'string' ? body.title.trim() : existingArticle.title;
      const description = typeof body?.description === 'string' ? body.description.trim() : existingArticle.description;
      const emoji = typeof body?.emoji === 'string' ? body.emoji.trim() : existingArticle.emoji;
      const sortOrderValue = body?.sortOrder !== undefined ? Number(body.sortOrder) : existingArticle.sortOrder;

      if (!title || !description) {
        return send(c, { error: 'Le titre et la description sont obligatoires.' }, 400);
      }

      const article = await prisma.guildRegulationArticle.update({
        where: { id: existingArticle.id },
        data: {
          title,
          description,
          emoji: emoji || null,
          sortOrder: Number.isFinite(sortOrderValue) ? sortOrderValue : existingArticle.sortOrder,
          enabled: typeof body?.enabled === 'boolean' ? body.enabled : existingArticle.enabled,
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modification article règlement',
        context: getGuildName(client, guildId),
        module: 'Règlement',
        eventType: 'Manuel',
        details: `Article "${article.title}" mis à jour.`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('RegulationAPI', 'Error patching article:', err);
      return fail(c, err, "Erreur lors de la modification de l'article", 'RegulationAPI');
    }
  });

  router.delete(`${base}/regulation/articles/:articleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const articleId = c.req.param('articleId');
    try {
      const article = await prisma.guildRegulationArticle.findFirst({ where: { id: articleId, guildId } });

      if (!article) {
        return send(c, { error: 'Article de règlement introuvable.' }, 404);
      }

      await prisma.guildRegulationArticle.delete({ where: { id: article.id } });

      await renumberRegulationArticles(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression article règlement',
        context: getGuildName(client, guildId),
        module: 'Règlement',
        eventType: 'Manuel',
        details: `Article "${article.title}" supprimé du règlement.`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('RegulationAPI', 'Error deleting article:', err);
      return fail(c, err, "Erreur lors de la suppression de l'article", 'RegulationAPI');
    }
  });

  router.post(`${base}/regulation/publish`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const result = await publishOrUpdateRegulationMessage(client, guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: result.mode === 'updated' ? 'Actualisation règlement' : 'Publication règlement',
        context: getGuildName(client, guildId),
        module: 'Règlement',
        eventType: 'Manuel',
        details: result.mode === 'updated'
            ? `Règlement mis à jour dans le salon de publication (${result.messageIds.length} message(s)).`
            : `Règlement publié dans le salon de publication (${result.messageIds.length} message(s)).`,
        channelId: null
      });

      return send(c, {
        ok: true,
        mode: result.mode,
        messageId: result.messageId,
        messageIds: result.messageIds,
      });
    } catch (error) {
      logger.error('RegulationAPI', `Erreur lors de la publication du règlement pour la guilde ${guildId}:`, error);
      return send(c, {
        error: publicErrorMessage(error, 'Impossible de publier le règlement.'),
      }, 400);
    }
  });

  return router;
}


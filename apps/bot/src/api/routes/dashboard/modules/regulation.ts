/** Routes dashboard du module `regulation`. */
import { publishOrUpdateRegulationMessage } from '../../../../services/staff/regulationService.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

import { jsonFailure } from '../../../shared/failure.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';
export async function handleRegulationRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser, moduleKey } = ctx;

  // Regulation routes
  if (moduleKey === 'regulation') {
    // POST /api/dashboard/guilds/:guildId/regulation/articles
    if (parts.length === 6 && parts[5] === 'articles' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          title?: string;
          description?: string;
          emoji?: string | null;
          sortOrder?: number | string | null;
          enabled?: boolean;
        }>(req);

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
          json(res, 400, { error: 'Le titre et la description sont obligatoires.' });
          return true;
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

        const orderedArticles = await prisma.guildRegulationArticle.findMany({
          where: { guildId },
          select: { id: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });

        await prisma.$transaction(
          orderedArticles.map((entry, index) =>
            prisma.guildRegulationArticle.update({
              where: { id: entry.id },
              data: { sortOrder: index },
            })
          )
        );

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Création article règlement',
          context: getGuildName(client, guildId),
          module: 'Règlement',
          eventType: 'Manuel',
          details: `Article "${article.title}" ajouté au règlement.`,
          channelId: null
        });

        json(res, 201, { ok: true, articleId: article.id });
      } catch (err) {
        logger.error('RegulationAPI', 'Error creating regulation article:', err);
        jsonFailure(res, err, "Erreur lors de la création de l'article", 'RegulationAPI');
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/regulation/articles/reorder
    if (parts.length === 7 && parts[5] === 'articles' && parts[6] === 'reorder' && method === 'PATCH') {
      try {
        const body = await readJsonBody<{ articleIds?: unknown }>(req);
        const requestedIds = Array.isArray(body?.articleIds)
          ? body.articleIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          : [];

        if (requestedIds.length === 0) {
          json(res, 400, { error: 'La liste des articles à réordonner est invalide.' });
          return true;
        }

        const existingArticles = await prisma.guildRegulationArticle.findMany({
          where: { guildId },
          select: { id: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        const existingById = new Set(existingArticles.map((article) => article.id));
        const orderedIds: string[] = [];
        const seenIds = new Set<string>();

        for (const articleId of requestedIds) {
          if (!existingById.has(articleId) || seenIds.has(articleId)) {
            continue;
          }

          orderedIds.push(articleId);
          seenIds.add(articleId);
        }

        for (const article of existingArticles) {
          if (seenIds.has(article.id)) {
            continue;
          }

          orderedIds.push(article.id);
          seenIds.add(article.id);
        }

        await prisma.$transaction(
          orderedIds.map((articleId, index) =>
            prisma.guildRegulationArticle.update({
              where: { id: articleId },
              data: { sortOrder: index },
            })
          )
        );

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Réordonnancement articles règlement',
          context: getGuildName(client, guildId),
          module: 'Règlement',
          eventType: 'Manuel',
          details: `${orderedIds.length} article(s) réorganisé(s).`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('RegulationAPI', 'Error reordering articles:', err);
        jsonFailure(res, err, 'Erreur lors du réordonnancement des articles', 'RegulationAPI');
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/regulation/articles/:articleId
    if (parts.length === 7 && parts[5] === 'articles' && method === 'PATCH') {
      const articleId = parts[6];
      try {
        const existingArticle = await prisma.guildRegulationArticle.findFirst({
          where: { id: articleId, guildId },
        });

        if (!existingArticle) {
          json(res, 404, { error: 'Article de règlement introuvable.' });
          return true;
        }

        const body = await readJsonBody<{
          title?: string;
          description?: string;
          emoji?: string | null;
          sortOrder?: number | string | null;
          enabled?: boolean;
        }>(req);

        const title = typeof body?.title === 'string' ? body.title.trim() : existingArticle.title;
        const description = typeof body?.description === 'string' ? body.description.trim() : existingArticle.description;
        const emoji = typeof body?.emoji === 'string' ? body.emoji.trim() : existingArticle.emoji;
        const sortOrderValue = body?.sortOrder !== undefined ? Number(body.sortOrder) : existingArticle.sortOrder;

        if (!title || !description) {
          json(res, 400, { error: 'Le titre et la description sont obligatoires.' });
          return true;
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

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('RegulationAPI', 'Error patching article:', err);
        jsonFailure(res, err, "Erreur lors de la modification de l'article", 'RegulationAPI');
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/regulation/articles/:articleId
    if (parts.length === 7 && parts[5] === 'articles' && method === 'DELETE') {
      const articleId = parts[6];
      try {
        const article = await prisma.guildRegulationArticle.findFirst({ where: { id: articleId, guildId } });

        if (!article) {
          json(res, 404, { error: 'Article de règlement introuvable.' });
          return true;
        }

        await prisma.guildRegulationArticle.delete({ where: { id: article.id } });

        const remainingArticles = await prisma.guildRegulationArticle.findMany({
          where: { guildId },
          select: { id: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });

        if (remainingArticles.length > 0) {
          await prisma.$transaction(
            remainingArticles.map((entry, index) =>
              prisma.guildRegulationArticle.update({
                where: { id: entry.id },
                data: { sortOrder: index },
              })
            )
          );
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression article règlement',
          context: getGuildName(client, guildId),
          module: 'Règlement',
          eventType: 'Manuel',
          details: `Article "${article.title}" supprimé du règlement.`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('RegulationAPI', 'Error deleting article:', err);
        jsonFailure(res, err, "Erreur lors de la suppression de l'article", 'RegulationAPI');
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/regulation/publish
    if (parts.length === 6 && parts[5] === 'publish' && method === 'POST') {
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

        json(res, 200, {
          ok: true,
          mode: result.mode,
          messageId: result.messageId,
          messageIds: result.messageIds,
        });
      } catch (error) {
        logger.error('RegulationAPI', `Erreur lors de la publication du règlement pour la guilde ${guildId}:`, error);
        json(res, 400, {
          error: publicErrorMessage(error, 'Impossible de publier le règlement.'),
        });
      }
      return true;
    }
  }

  return false;
}

import type { Client } from 'discord.js';
import { Hono } from 'hono';
/** Routes dashboard du module `news`. */
import { publishNewsArticle } from '../../../../services/core/newsService.js';
import prisma from '../../../../utils/db.js';
import { errorMessage } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

export function createNewsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/news`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const articles = await prisma.newsArticle.findMany({
        where: { guildId },
        orderBy: { publishedAt: 'desc' },
      });
      return send(c, articles);
    } catch (err: unknown) {
      logger.error('NewsAPI', `Error listing news for guild ${guildId}: ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la récupération des actualités' }, 500);
    }
  });

  router.post(`${base}/news`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        title: string;
        content: string;
        summary?: string;
        imageUrl?: string;
        category?: string;
        subcategory?: string;
        published?: boolean;
        publishMode?: 'summary' | 'full_embed';
      }>(c);

      if (!body || !body.title || !body.content) {
        return send(c, { error: 'Le titre et le contenu sont requis.' }, 400);
      }

      const authorUser = await client.users.fetch(user.userId).catch(() => null);
      const authorName = authorUser?.globalName || authorUser?.username || user.username || 'Staff';
      const authorAvatar = authorUser?.displayAvatarURL() || null;

      const isPublished = body.published ?? false;

      const article = await prisma.newsArticle.create({
        data: {
          guildId,
          title: body.title,
          content: body.content,
          summary: body.summary || null,
          imageUrl: body.imageUrl || null,
          category: body.category || 'Mise à jour',
          subcategory: body.subcategory || '',
          published: isPublished,
          authorId: user.userId,
          authorName,
          authorAvatar,
          publishedAt: new Date(),
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: isPublished ? 'Publication actualité' : 'Création brouillon actualité',
        context: getGuildName(client, guildId),
        module: 'Actualités',
        eventType: 'Manuel',
        details: `Article "${body.title}" de catégorie "${body.category || 'Mise à jour'}" créé.`,
        channelId: null,
      });

      if (isPublished) {
        const publishMode = body.publishMode === 'full_embed' ? 'full_embed' : 'summary';
        await publishNewsArticle(client, guildId, article.id, publishMode).catch(err => {
          logger.error('NewsAPI', `Failed to send news notification to Discord for article ${article.id}:`, err);
        });
      }

      return send(c, article, 201);
    } catch (err: unknown) {
      logger.error('NewsAPI', `Error creating news for guild ${guildId}: ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de la création de l'actualité" }, 500);
    }
  });

  router.patch(`${base}/news/:articleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const articleId = c.req.param('articleId');
    try {
      const existing = await prisma.newsArticle.findUnique({
        where: { id: articleId },
      });

      if (!existing || existing.guildId !== guildId) {
        return send(c, { error: 'Actualité introuvable' }, 404);
      }

      const body = await readBody<{
        title?: string;
        content?: string;
        summary?: string;
        imageUrl?: string;
        category?: string;
        subcategory?: string;
        published?: boolean;
        publishMode?: 'summary' | 'full_embed';
      }>(c);

      if (!body) {
        return send(c, { error: 'Données manquantes' }, 400);
      }

      const isPublishing = body.published === true && !existing.published;

      const updated = await prisma.newsArticle.update({
        where: { id: articleId },
        data: {
          title: body.title !== undefined ? body.title : undefined,
          content: body.content !== undefined ? body.content : undefined,
          summary: body.summary !== undefined ? body.summary : undefined,
          imageUrl: body.imageUrl !== undefined ? body.imageUrl : undefined,
          category: body.category !== undefined ? body.category : undefined,
          subcategory: body.subcategory !== undefined ? body.subcategory : undefined,
          published: body.published !== undefined ? body.published : undefined,
          publishedAt: isPublishing ? new Date() : undefined,
        },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: isPublishing ? 'Publication actualité' : 'Modification actualité',
        context: getGuildName(client, guildId),
        module: 'Actualités',
        eventType: 'Manuel',
        details: `Article "${updated.title}" mis à jour (Publié: ${updated.published}).`,
        channelId: null,
      });

      if (isPublishing) {
        const publishMode = body.publishMode === 'full_embed' ? 'full_embed' : 'summary';
        await publishNewsArticle(client, guildId, updated.id, publishMode).catch(err => {
          logger.error('NewsAPI', `Failed to send news notification to Discord for article ${updated.id}:`, err);
        });
      }

      return send(c, updated);
    } catch (err: unknown) {
      logger.error('NewsAPI', `Error updating news article ${articleId}: ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de la modification de l'actualité" }, 500);
    }
  });

  router.delete(`${base}/news/:articleId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const articleId = c.req.param('articleId');
    try {
      const existing = await prisma.newsArticle.findUnique({
        where: { id: articleId },
      });

      if (!existing || existing.guildId !== guildId) {
        return send(c, { error: 'Actualité introuvable' }, 404);
      }

      await prisma.newsArticle.delete({
        where: { id: articleId },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression actualité',
        context: getGuildName(client, guildId),
        module: 'Actualités',
        eventType: 'Manuel',
        details: `Article "${existing.title}" supprimé.`,
        channelId: null,
      });

      return send(c, { success: true });
    } catch (err: unknown) {
      logger.error('NewsAPI', `Error deleting news article ${articleId}: ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de la suppression de l'actualité" }, 500);
    }
  });

  router.get(`${base}/news/category-configs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const configs = await prisma.newsCategoryConfig.findMany({
        where: { guildId },
        orderBy: { category: 'asc' },
      });
      return send(c, configs);
    } catch (err: unknown) {
      logger.error('NewsAPI', `Error listing news category configs for guild ${guildId}: ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la récupération de la configuration des catégories' }, 500);
    }
  });

  router.post(`${base}/news/category-configs`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        category: string;
        subcategory?: string;
        channelId: string;
      }>(c);

      if (!body || !body.category || !body.channelId) {
        return send(c, { error: 'La catégorie et le salon Discord sont requis.' }, 400);
      }

      const category = body.category.trim();
      const subcategory = (body.subcategory || '').trim();
      const channelId = body.channelId.trim();

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!discordGuild) {
        return send(c, { error: 'Serveur introuvable' }, 404);
      }
      const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        return send(c, { error: 'Le salon Discord spécifié est introuvable ou inaccessible.' }, 400);
      }

      const config = await prisma.newsCategoryConfig.upsert({
        where: {
          guildId_category_subcategory: {
            guildId,
            category,
            subcategory,
          }
        },
        create: {
          guildId,
          category,
          subcategory,
          channelId,
        },
        update: {
          channelId,
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Config catégorie actualité',
        context: getGuildName(client, guildId),
        module: 'Actualités',
        eventType: 'Manuel',
        details: `Configuration du salon #${channel.name} pour la catégorie "${category}"${subcategory ? ` (${subcategory})` : ''}.`,
        channelId: null,
      });

      return send(c, config);
    } catch (err: unknown) {
      logger.error('NewsAPI', `Error saving news category config for guild ${guildId}: ${errorMessage(err)}`);
      return send(c, { error: "Erreur lors de l'enregistrement de la configuration de catégorie" }, 500);
    }
  });

  router.delete(`${base}/news/category-configs/:id`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const id = c.req.param('id');
    const configId = id;
    try {
      const existing = await prisma.newsCategoryConfig.findUnique({
        where: { id: configId },
      });

      if (!existing || existing.guildId !== guildId) {
        return send(c, { error: 'Configuration de catégorie introuvable' }, 404);
      }

      await prisma.newsCategoryConfig.delete({
        where: { id: configId },
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression config catégorie actualité',
        context: getGuildName(client, guildId),
        module: 'Actualités',
        eventType: 'Manuel',
        details: `Configuration de catégorie "${existing.category}"${existing.subcategory ? ` (${existing.subcategory})` : ''} supprimée.`,
        channelId: null,
      });

      return send(c, { success: true });
    } catch (err: unknown) {
      logger.error('NewsAPI', `Error deleting news category config ${configId}: ${errorMessage(err)}`);
      return send(c, { error: 'Erreur lors de la suppression de la configuration de catégorie' }, 500);
    }
  });

  return router;
}


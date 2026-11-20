/**
 * Routes publiques diverses : image de broadcast, métadonnées OAuth du MCP,
 * image d'activité d'un profil, flux RSS et actualités d'un serveur.
 */
import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { generateRssXml } from '../../../../services/core/newsService.js';
import { getDashboardUrl } from '../../../shared.js';
import { isValidMcpGuildId, mcpAuthorizationServerMetadata, mcpProtectedResourceMetadata } from '../../../mcp/mcpServer.js';
import { SNOWFLAKE, fail, send } from './kit.js';

function mcpBaseFromResource(resource: string | null | undefined): string | null {
  if (!resource) return null;
  try {
    const parsed = new URL(resource);
    const standardMatch = parsed.pathname.match(/^\/api\/mcp\/(\d{15,20})\/?$/);
    if (standardMatch) return `${parsed.protocol}//${parsed.host}/api/mcp/${standardMatch[1]}`;
    const directMatch = parsed.pathname.match(/^\/api\/mcp-direct\/(\d{15,20})\/([^/?#]+)\/?$/);
    if (directMatch) return `${parsed.protocol}//${parsed.host}/api/mcp-direct/${directMatch[1]}/${directMatch[2]}`;
    return null;
  } catch {
    return null;
  }
}

function publicBase(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? url.host;
  return `${proto}://${host}`;
}

const guildScopedMcpBase = (c: Context, guildId: string) => `${publicBase(c)}/api/mcp/${guildId}`;

export function createPublicMiscRouter(client: Client): Hono {
  const router = new Hono();

  // Sert les images de broadcast hébergées par Kotbo. Publique et sans jeton de
  // session : c'est le crawler Discord qui la télécharge. Le secret est le token
  // de 32 caractères de l'URL.
  router.get('/api/public/broadcast-media/:token', async (c) => {
    const token = c.req.param('token').replace(/\.(png|jpg|jpeg|gif|webp)$/i, '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return send(c, { error: 'Jeton invalide' }, 400);
    try {
      const { readBroadcastMediaByToken } = await import('../../../../services/system/broadcastMediaService.js');
      const media = await readBroadcastMediaByToken(token);
      if (!media) return send(c, { error: 'Image introuvable' }, 404);
      return c.body(new Uint8Array(media.data), 200, {
        'Content-Type': media.mimeType,
        'Content-Length': String(media.size),
        // Le contenu d'un token ne change jamais.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      });
    } catch (err) {
      logger.error('PublicAPI', `Error serving broadcast media ${token}:`, err);
      return fail(c, err, "Erreur lors du chargement de l'image", 'PublicAPI');
    }
  });

  // Les clients OAuth sondent aussi l'alias OIDC avant la RFC 8414.
  const authorizationServer = (c: Context) => {
    const resourceBase = mcpBaseFromResource(c.req.query('resource') ?? c.req.query('issuer'));
    if (resourceBase) return send(c, mcpAuthorizationServerMetadata(resourceBase));
    return send(c, {
      error: 'guild_scoped_mcp_endpoint_required',
      error_description: 'Utilise l endpoint MCP complet du serveur Discord: /api/mcp/:guildId',
      endpoint_format: `${publicBase(c)}/api/mcp/:guildId`,
    }, 400);
  };
  router.get('/.well-known/oauth-authorization-server', authorizationServer);
  router.get('/.well-known/openid-configuration', authorizationServer);

  router.get('/.well-known/oauth-protected-resource', (c) => {
    const resourceBase = mcpBaseFromResource(c.req.query('resource'));
    if (!resourceBase) {
      return send(c, {
        error: 'guild_scoped_mcp_endpoint_required',
        error_description: 'Ajoute ?resource=https://host/api/mcp/:guildId ou utilise /.well-known/oauth-protected-resource/api/mcp/:guildId',
      }, 400);
    }
    return send(c, mcpProtectedResourceMetadata(resourceBase));
  });

  // Formes well-known RFC 9728 / RFC 8414 d'une ressource MCP /api/mcp/:guildId.
  const scoped = (metadata: (base: string) => unknown) => (c: Context) => {
    const guildId = c.req.param('guildId') ?? '';
    if (!isValidMcpGuildId(guildId)) return send(c, { error: 'invalid_guild_id' }, 400);
    return send(c, metadata(guildScopedMcpBase(c, guildId)));
  };
  router.get('/.well-known/oauth-protected-resource/api/mcp/:guildId', scoped(mcpProtectedResourceMetadata));
  router.get('/.well-known/oauth-authorization-server/api/mcp/:guildId', scoped(mcpAuthorizationServerMetadata));
  router.get('/.well-known/openid-configuration/api/mcp/:guildId', scoped(mcpAuthorizationServerMetadata));

  router.get('/api/public/profile/:userId/activity-image', async (c) => {
    const userId = c.req.param('userId');
    if (!SNOWFLAKE.test(userId)) return send(c, { error: 'ID utilisateur invalide' }, 400);
    // Bornée : sans plafond, la fenêtre se règle sur tout l'historique du membre.
    const days = Math.min(Math.max(parseInt(c.req.query('days') || '14', 10) || 14, 1), 90);
    try {
      // Même règle que la route profil : un membre dont tous les profils sont privés n'expose pas son activité.
      const publicProfile = await prisma.memberProfile.findFirst({
        where: { userId, isProfilePrivate: false },
        select: { id: true },
      });
      if (!publicProfile) return send(c, { error: 'Profil introuvable ou privé' }, 404);

      const since = new Date();
      since.setDate(since.getDate() - days + 1);
      const startKey = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;

      const stats = await prisma.memberDailyStat.findMany({
        where: { userId, dateKey: { gte: startKey } },
        orderBy: { dateKey: 'asc' },
      });

      const map: Record<string, { messages: number; voice: number }> = Object.create(null);
      for (const s of stats) {
        if (!map[s.dateKey]) map[s.dateKey] = { messages: 0, voice: 0 };
        map[s.dateKey].messages += s.messagesCount;
        map[s.dateKey].voice += s.voiceMinutes;
      }
      const dailyData = Object.keys(map)
        .sort()
        .map((date) => ({ date, messages: map[date].messages, voice: map[date].voice }));

      const totalMessages = dailyData.reduce((a, b) => a + b.messages, 0);
      const totalVoice = dailyData.reduce((a, b) => a + b.voice, 0);
      const activeDays = dailyData.length;
      const peakDayMessages = dailyData.reduce((a, b) => Math.max(a, b.messages), 0);

      const { generateMemberStatsImage } = await import('../../../../services/core/imageService.js');
      const buffer = await generateMemberStatsImage(userId, days, { totalMessages, totalVoice, activeDays, peakDayMessages }, dailyData);
      return c.body(new Uint8Array(buffer), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
    } catch (err) {
      logger.error('PublicAPI', `Error generating activity image for ${userId}:`, err);
      return fail(c, err, 'Erreur lors de la génération du graphique', 'PublicAPI');
    }
  });

  router.get('/api/public/rss/:guildId/:category?/:subcategory?', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE.test(guildId)) return send(c, { error: 'ID de guilde invalide' }, 400);
    const category = c.req.param('category') ?? c.req.query('category') ?? null;
    const subcategory = c.req.param('subcategory') ?? c.req.query('subcategory') ?? null;
    try {
      const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { id: true } });
      if (!guild) return send(c, { error: 'Guilde introuvable' }, 404);

      const where: Prisma.NewsArticleWhereInput = { guildId, published: true };
      if (category) where.category = { equals: category, mode: 'insensitive' };
      if (subcategory) where.subcategory = { equals: subcategory, mode: 'insensitive' };
      const articles = await prisma.newsArticle.findMany({ where, orderBy: { publishedAt: 'desc' } });

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const guildName = discordGuild?.name ?? `Serveur ${guildId}`;
      const rssXml = generateRssXml(guildName, guildId, getDashboardUrl(), process.env.VITE_API_URL || '', articles, category, subcategory);
      return c.body(rssXml, 200, {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error generating RSS for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur lors de la génération du flux RSS' }, 500);
    }
  });

  router.get('/api/public/guilds/:guildId/news', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE.test(guildId)) return send(c, { error: 'ID de guilde invalide' }, 400);
    try {
      const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { id: true } });
      if (!guild) return send(c, { error: 'Guilde introuvable' }, 404);
      const articles = await prisma.newsArticle.findMany({
        where: { guildId, published: true },
        orderBy: { publishedAt: 'desc' },
      });
      return send(c, articles);
    } catch (err: unknown) {
      logger.error('PublicAPI', `Error listing public news for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
      return send(c, { error: 'Erreur lors de la récupération des actualités publiques' }, 500);
    }
  });

  return router;
}

/**
 * insights.ts
 *
 * Lectures transverses de la console admin (`/api/admin/insights/*`) :
 * activite de la flotte, fiche d'un serveur, supervision AegisAI et Kotbo
 * Vision. Lecture seule ; le controle d'acces administrateur est fait en
 * amont par `handleAdminRoutes`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import { json } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
import { clampDays, getAiSupervision, getGlobalActivity, getGuildSheet } from '../../../services/analytics/adminInsightsService.js';
import prisma from '../../../utils/db.js';

const SNOWFLAKE = /^\d{15,25}$/;

export async function handleAdminInsightRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
): Promise<boolean> {
  if (parts[2] !== 'insights' || req.method !== 'GET') return false;
  const days = clampDays(url.searchParams.get('days'));

  try {
    // GET /api/admin/insights/activity : messages, salons et categories de toute la flotte.
    if (parts[3] === 'activity' && parts.length === 4) {
      json(res, 200, await getGlobalActivity(client, days));
      return true;
    }

    // GET /api/admin/insights/ai : supervision AegisAI et Kotbo Vision.
    if (parts[3] === 'ai' && parts.length === 4) {
      json(res, 200, await getAiSupervision(client, days));
      return true;
    }

    // GET /api/admin/insights/ai/vision-images : catalogue d'images Kotbo Vision (toutes sources)
    if (parts[3] === 'ai' && parts[4] === 'vision-images' && parts.length === 5) {
      const source = url.searchParams.get('source') || undefined;
      const withThumbOnly = url.searchParams.get('thumbs') === '1';
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 300);

      const where: Record<string, unknown> = {};
      if (source && source !== 'ALL') where.source = source;
      if (withThumbOnly) where.thumb = { not: null };

      const images = await prisma.scamImageHash.findMany({
        where,
        select: {
          id: true,
          guildId: true,
          filename: true,
          thumb: true,
          source: true,
          status: true,
          hits: true,
          lastSeenAt: true,
          createdAt: true,
          addedBy: true,
        },
        orderBy: [{ hits: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      });

      // Enrichit avec le nom des serveurs s'il y a des guildId
      const guildIds = [...new Set(images.map((img) => img.guildId).filter((id): id is string => Boolean(id)))];
      const guildMap = new Map<string, string>();
      for (const gid of guildIds) {
        const g = client.guilds.cache.get(gid);
        if (g) guildMap.set(gid, g.name);
      }

      const enriched = images.map((img) => ({
        ...img,
        guildName: img.guildId ? (guildMap.get(img.guildId) ?? null) : 'Global',
      }));

      json(res, 200, { images: enriched });
      return true;
    }

    // GET /api/admin/insights/guilds/:id : fiche d'un serveur.
    if (parts[3] === 'guilds' && parts.length === 5) {
      if (!SNOWFLAKE.test(parts[4])) {
        json(res, 400, { error: 'Identifiant de serveur invalide.' });
        return true;
      }
      const sheet = await getGuildSheet(client, parts[4], days);
      json(res, sheet ? 200 : 404, sheet ?? { error: 'Serveur inconnu.' });
      return true;
    }
  } catch (err) {
    jsonFailure(res, err, 'Impossible de lire ces statistiques. Réessaie.', 'AdminInsightsAPI');
    return true;
  }

  return false;
}

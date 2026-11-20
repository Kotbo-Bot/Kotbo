/**
 * Pages fonctionnalités du site vitrine (`/api/admin/feature-pages/*`).
 *
 * L'accès administrateur bot est vérifié en amont par `handleAdminRoutes`.
 * Chaque écriture passe au journal d'audit : une page publiée engage Kotbo
 * publiquement.
 */

import type { Context } from 'hono';
import { HttpError, type AuthClaims } from '../../shared.js';
import { readBody, requestIp, send } from '../../hono/dashboard/kit.js';

const reply = (c: Context, status: number, data: unknown) => send(c, data, status);
import { logger } from '../../../utils/logger.js';
import { recordAdminAudit } from '../../../services/system/adminAuditService.js';
import {
  FeaturePageError,
  createFeaturePage,
  deleteFeaturePage,
  importFeaturePages,
  isLandingRebuildConfigured,
  listFeaturePages,
  missingForPublication,
  updateFeaturePage,
  type FeaturePageInput,
} from '../../../services/system/featurePageService.js';
import { modulesWithoutSeed } from '../../../services/system/featurePageSeeds.js';

function sendError(c: Context, err: unknown, fallback: string): Response {
  if (err instanceof FeaturePageError) {
    return reply(c, err.status, { error: err.message });
  }
  if (err instanceof HttpError) {
    return reply(c, err.statusCode, { error: err.message });
  }
  logger.error('AdminAPI', fallback, err);
  return reply(c, 500, { error: fallback });
}

export async function handleAdminFeaturePageRoutes(
  c: Context,
  parts: string[],
  user: AuthClaims,
): Promise<Response | null> {
  const method = c.req.method;
  const audit = (action: string, targetId: string, summary: string, metadata?: Parameters<typeof recordAdminAudit>[0]['metadata']) =>
    recordAdminAudit({
      actorId: user.userId,
      actorName: user.username,
      action,
      targetType: 'feature_page',
      targetId,
      summary,
      metadata,
      ip: requestIp(c),
    });

  // GET /api/admin/feature-pages - toutes les pages, brouillons compris
  if (parts.length === 3 && method === 'GET') {
    try {
      const pages = await listFeaturePages();
      return reply(c, 200, {
        pages: pages.map((page) => ({ ...page, missing: missingForPublication(page.content) })),
        rebuildConfigured: isLandingRebuildConfigured(),
        modulesWithoutSeed: modulesWithoutSeed(),
      });
    } catch (err) {
      return sendError(c, err, 'Erreur lors du chargement des pages.');
    }

  }

  // POST /api/admin/feature-pages - nouvelle page
  if (parts.length === 3 && method === 'POST') {
    try {
      const body = await readBody<FeaturePageInput>(c);
      const page = await createFeaturePage(body ?? {}, user.userId);
      await audit('feature_page.create', page.id, `Page « ${page.content.fr.name || page.key} » créée`, {
        key: page.key,
        published: page.published,
      });
      return reply(c, 201, { page: { ...page, missing: missingForPublication(page.content) } });
    } catch (err) {
      return sendError(c, err, 'Erreur lors de la création de la page.');
    }

  }

  // POST /api/admin/feature-pages/import - pages manquantes du registre
  if (parts[3] === 'import' && parts.length === 4 && method === 'POST') {
    try {
      const result = await importFeaturePages(user.userId);
      await audit('feature_page.import', 'registry', `${result.created} page(s) importée(s)`, result);
      return reply(c, 200, result);
    } catch (err) {
      return sendError(c, err, "Erreur lors de l'import des pages.");
    }

  }

  // PUT /api/admin/feature-pages/:id
  if (parts.length === 4 && method === 'PUT') {
    try {
      const body = await readBody<FeaturePageInput>(c);
      const page = await updateFeaturePage(parts[3], body ?? {}, user.userId);
      await audit('feature_page.update', page.id, `Page « ${page.content.fr.name || page.key} » modifiée`, {
        key: page.key,
        published: page.published,
      });
      return reply(c, 200, { page: { ...page, missing: missingForPublication(page.content) } });
    } catch (err) {
      return sendError(c, err, 'Erreur lors de la modification de la page.');
    }

  }

  // DELETE /api/admin/feature-pages/:id
  if (parts.length === 4 && method === 'DELETE') {
    try {
      const page = await deleteFeaturePage(parts[3]);
      await audit('feature_page.delete', page.id, `Page « ${page.content.fr.name || page.key} » supprimée`, {
        key: page.key,
        wasPublished: page.published,
      });
      return reply(c, 200, { ok: true });
    } catch (err) {
      return sendError(c, err, 'Erreur lors de la suppression de la page.');
    }

  }

  return null;
}

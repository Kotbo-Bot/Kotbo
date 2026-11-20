/**
 * analytics.ts
 *
 * Routeur d'administration pour les statistiques commerciales et le tunnel
 * d'acquisition (`/api/admin/analytics/*`).
 *
 * Toutes les routes ici sont sous contrôle d'accès administrateur bot, vérifié
 * en amont par `handleAdminRoutes`.
 */

import type { Client } from 'discord.js';
import type { AuthClaims } from '../../shared.js';
import { logger } from '../../../utils/logger.js';
import {
  getFunnelStats,
  getOnboardingFunnelStats,
  getRevenueStats,
  getRetentionCohorts,
  getSegmentsStats,
  getModuleCorrelations,
  getGuildsExplorer,
  getRisksSummary,
  getAlertThresholds,
  saveAlertThresholds,
  exportAnalyticsCsv,
  type AlertThresholds,
} from '../../../services/analytics/adminAnalyticsService.js';
import type { AnalyticsDimension } from '@kotbo/contracts';
import { getDashboardUsage } from '../../../services/analytics/dashboardUsageService.js';
import { getModuleFleetStats } from '../../../services/analytics/moduleFleetStatsService.js';

import type { Context } from 'hono';
import { fail, readBody, send } from '../../hono/dashboard/kit.js';

const reply = (c: Context, status: number, data: unknown) => send(c, data, status);
export async function handleAdminAnalyticsRoutes(
  c: Context,
  parts: string[],
  url: URL,
  client: Client,
  _user: AuthClaims
): Promise<Response | null> {
  const method = c.req.method;

  // Doit être /api/admin/analytics/...
  if (parts[0] !== 'api' || parts[1] !== 'admin' || parts[2] !== 'analytics') {
    return null;
  }

  const sub = parts[3];

  try {
    // GET /api/admin/analytics/dashboard-usage : pages et modules du dashboard consultés.
    if (sub === 'dashboard-usage' && parts.length === 4 && method === 'GET') {
      const usage = await getDashboardUsage({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        guildId: url.searchParams.get('guildId'),
        compare: url.searchParams.get('compare') === 'previous',
      });
      return reply(c, 200, usage);

    }

    // GET /api/admin/analytics/module-fleet : activation, usage et performance des modules sur le parc.
    if (sub === 'module-fleet' && parts.length === 4 && method === 'GET') {
      const stats = await getModuleFleetStats({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
      });
      return reply(c, 200, stats);

    }

    // 1. GET /api/admin/analytics/funnel/onboarding
    if (sub === 'funnel' && parts[4] === 'onboarding' && method === 'GET') {
      const stats = await getOnboardingFunnelStats({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        serverKind: url.searchParams.get('serverKind'),
        track: url.searchParams.get('track'),
      });
      return reply(c, 200, stats);

    }

    // 2. GET /api/admin/analytics/funnel
    if (sub === 'funnel' && parts.length === 4 && method === 'GET') {
      const stats = await getFunnelStats({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        compare: url.searchParams.get('compare') === 'previous',
      });
      return reply(c, 200, stats);

    }

    // 3. GET /api/admin/analytics/revenue/cohorts
    if (sub === 'revenue' && parts[4] === 'cohorts' && method === 'GET') {
      const cohorts = await getRetentionCohorts();
      return reply(c, 200, cohorts);

    }

    // 4. GET /api/admin/analytics/revenue
    if (sub === 'revenue' && parts.length === 4 && method === 'GET') {
      const stats = await getRevenueStats({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        compare: url.searchParams.get('compare') === 'previous',
      });
      return reply(c, 200, stats);

    }

    // 5. GET /api/admin/analytics/segments
    if (sub === 'segments' && method === 'GET') {
      const stats = await getSegmentsStats({
        dimension: url.searchParams.get('dimension') as AnalyticsDimension | null,
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
      });
      return reply(c, 200, stats);

    }

    // 6. GET /api/admin/analytics/modules
    if (sub === 'modules' && method === 'GET') {
      const stats = await getModuleCorrelations();
      return reply(c, 200, stats);

    }

    // 7. GET /api/admin/analytics/guilds
    if (sub === 'guilds' && method === 'GET') {
      const page = Number(url.searchParams.get('page')) || 1;
      const limit = Number(url.searchParams.get('limit')) || 25;
      const filter = url.searchParams.get('filter') as 'all' | 'paying' | 'trial' | 'churned' | 'at_risk' | 'out_of_tier' | null;
      const search = url.searchParams.get('search');
      const dimension = url.searchParams.get('dimension') as AnalyticsDimension | null;
      const bucket = url.searchParams.get('bucket');

      const data = await getGuildsExplorer(client, {
        page,
        limit,
        filter,
        search,
        dimension,
        bucket,
      });
      return reply(c, 200, data);

    }

    // 8. GET /api/admin/analytics/risks
    if (sub === 'risks' && method === 'GET') {
      const risks = await getRisksSummary(client);
      return reply(c, 200, risks);

    }

    // 9. GET /api/admin/analytics/export.csv
    if (sub === 'export.csv' && method === 'GET') {
      const view = url.searchParams.get('view') || 'funnel';
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const dimension = url.searchParams.get('dimension') as AnalyticsDimension | null;
      const filter = url.searchParams.get('filter');

      const { filename, content } = await exportAnalyticsCsv(client, view, {
        from,
        to,
        dimension,
        filter,
      });

      return c.body(content, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });

    }

    // 10. GET /api/admin/analytics/alerts
    if (sub === 'alerts' && method === 'GET') {
      const data = await getAlertThresholds();
      return reply(c, 200, data);

    }

    // 10. POST /api/admin/analytics/alerts
    if (sub === 'alerts' && method === 'POST') {
      const body = await readBody<Partial<AlertThresholds>>(c);
      if (!body) {
        return reply(c, 400, { error: 'Corps de requête manquant ou invalide' });

      }
      const updated = await saveAlertThresholds(body);
      return reply(c, 200, { thresholds: updated });

    }

    return null;
  } catch (error) {
    logger.error('AdminAnalyticsAPI', `Erreur sur /api/admin/analytics/${sub ?? ''}:`, error);
    return fail(c, error, "Erreur interne lors du traitement des statistiques d'acquisition.", 'AdminAnalyticsAPI');

  }
}

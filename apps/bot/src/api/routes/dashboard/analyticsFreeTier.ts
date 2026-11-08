import { FREE_ANALYTICS_DAYS } from '@kotbo/contracts';

/**
 * Analytics sans abonnement : la vue d'ensemble, l'activité, les membres, la
 * croissance et la modération, sur `FREE_ANALYTICS_DAYS` jours, sans filtre de
 * salon ni de rôle. Le reste de la page se montre verrouillé côté dashboard.
 */

/** Sous-routes qui ne servent que des onglets payants. */
const PAID_ROUTES = new Set([
  'audience', 'conversation', 'insights', 'climate', 'reports', 'advanced', 'interactions',
  'weekly-comparison', 'daily-algo', 'commands', 'channel-tree', 'categories', 'correlation',
  'growth-retention', 'reaction-roles',
]);

/** Lisibles en gratuit (la page Pulse lit les alertes), mais pas modifiables. */
const READ_ONLY_ROUTES = new Set(['alerts', 'views', 'annotations']);

/**
 * Applique les limites du gratuit à une requête Analytics. Renvoie `false` si
 * la route est réservée à l'offre payante ; sinon ramène la période dans la
 * fenêtre gratuite et retire les filtres de périmètre, en place dans `params`.
 */
export function applyFreeAnalyticsLimits(parts: string[], method: string | undefined, params: URLSearchParams): boolean {
  const route = parts[5];
  if (route && (PAID_ROUTES.has(route) || (READ_ONLY_ROUTES.has(route) && method !== 'GET'))) return false;

  // Les routes lisent tantôt `period`, tantôt `days` : les deux sont bornés.
  for (const key of ['period', 'days']) {
    const asked = Number.parseInt(params.get(key) ?? '', 10);
    params.set(key, String(asked > 0 ? Math.min(asked, FREE_ANALYTICS_DAYS) : FREE_ANALYTICS_DAYS));
  }
  for (const key of ['startDate', 'endDate', 'channel', 'role', 'excludeStaff']) params.delete(key);
  return true;
}

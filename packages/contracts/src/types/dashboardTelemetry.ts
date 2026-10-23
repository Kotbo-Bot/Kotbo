/**
 * Télémétrie produit du dashboard - catalogue fermé et bornes de validation.
 *
 * Le dashboard agrège ses événements dans le navigateur et les envoie par lot ;
 * le bot les revalide ici avant de les ajouter aux compteurs du jour. Comme
 * pour le tunnel d'acquisition, une liste fermée évite que chaque écran invente
 * ses propres noms, et une chaîne venue du navigateur n'atteint jamais la base
 * sans avoir été bornée.
 *
 * Rien ici n'identifie une personne : ni ID Discord, ni texte saisi, ni URL
 * complète. Les pages sont des gabarits (`/security/sanctions`, les
 * identifiants remplacés par `:id`), les dimensions des catégories courtes.
 */

export const DASHBOARD_TELEMETRY_EVENTS = [
  /** Arrivée sur une page. `dimension` : source de la navigation (voir NAV_SOURCES). */
  'page_view',
  /** Temps actif passé sur la page, onglet du navigateur visible. `value` : ms. */
  'page_time',
  /** Dernière page vue avant de quitter le dashboard. */
  'page_exit',
  /** Ouverture d'un onglet interne d'une page (`tab`). */
  'tab_view',
  /** Écriture aboutie depuis la page. `dimension` : méthode HTTP. */
  'save',
  /** Écriture refusée ou échouée. `dimension` : catégorie d'erreur. */
  'save_error',
  /** Lecture échouée. `dimension` : catégorie d'erreur. */
  'api_error',
  /** Module éteint ou section fermée au rôle. `dimension` : code du refus. */
  'blocked',
  /** Durée d'une lecture API. `value` : ms, `dimension` : tranche. */
  'api_latency',
  /** Chargement du code d'une page. `value` : ms, `dimension` : tranche. */
  'route_load',
  /** Mesure de rendu au premier chargement. `dimension` : fcp, lcp, ttfb. `value` : ms. */
  'web_vital',
  /** Erreur JavaScript non rattrapée. `dimension` : type d'erreur. */
  'js_error',
  /** Nouvelle session du dashboard. `dimension` : classe d'appareil. */
  'session_start',
  /** Contexte de la session. `dimension` : theme:dark, locale:fr, mode:simple… */
  'session_env',
  /** Palette de commandes. `dimension` : open, search_hit, search_empty, select:<groupe>. */
  'palette',
  /** Changements non enregistrés au départ d'une page. `dimension` : save, discard, stay. */
  'unsaved_prompt',
  /**
   * Réponse en un clic à une question posée au bon moment dans le produit.
   * `dimension` : `<contexte>:<réponse>`, choisie dans une liste fermée par
   * l'écran - jamais un texte saisi.
   */
  'micro_feedback',
] as const;

export type DashboardTelemetryEvent = (typeof DASHBOARD_TELEMETRY_EVENTS)[number];

export const DASHBOARD_NAV_SOURCES = [
  'entry', // première page de la session
  'sidebar',
  'palette',
  'favorite',
  'history', // précédent / suivant du navigateur
  'redirect',
  'reload', // rechargement dans la même session
  'link', // tout autre lien interne
] as const;

export type DashboardNavSource = (typeof DASHBOARD_NAV_SOURCES)[number];

/** Tranches de durée, pour lire une distribution plutôt qu'une seule moyenne. */
export const DASHBOARD_LATENCY_BUCKETS = ['lt300', '300_1000', '1000_3000', 'gt3000'] as const;
export type DashboardLatencyBucket = (typeof DASHBOARD_LATENCY_BUCKETS)[number];

export function latencyBucketFor(ms: number): DashboardLatencyBucket {
  if (ms < 300) return 'lt300';
  if (ms < 1000) return '300_1000';
  if (ms < 3000) return '1000_3000';
  return 'gt3000';
}

export const DASHBOARD_TELEMETRY_LIMITS = {
  maxEntriesPerBatch: 300,
  maxCountPerEntry: 10_000,
  /** Une valeur isolée ne dépasse pas une heure : au-delà, c'est un onglet oublié. */
  maxValue: 3_600_000,
  pageMaxLength: 120,
  tabMaxLength: 40,
  featureMaxLength: 48,
  dimensionMaxLength: 48,
  retentionDays: 180,
} as const;

export type DashboardTelemetryEntry = {
  /** "" hors serveur. */
  guildId: string;
  page: string;
  tab: string;
  feature: string;
  event: DashboardTelemetryEvent;
  dimension: string;
  count: number;
  valueSum: number;
};

const EVENT_SET = new Set<string>(DASHBOARD_TELEMETRY_EVENTS);
const GUILD_ID_RE = /^\d{17,20}$/;
const PAGE_RE = /^\/[A-Za-z0-9/:._-]*$/;
const TOKEN_RE = /^[A-Za-z0-9_:.-]*$/;

export function isDashboardTelemetryEvent(value: unknown): value is DashboardTelemetryEvent {
  return typeof value === 'string' && EVENT_SET.has(value);
}

function boundedToken(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > maxLength || !TOKEN_RE.test(value)) return null;
  return value;
}

function boundedInt(value: unknown, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(Math.max(n, 0), max);
}

/**
 * Valide et borne une entrée brute. Rend `null` pour tout ce qui sort du
 * contrat : mieux vaut perdre un compteur qu'écrire une chaîne arbitraire.
 */
export function sanitizeTelemetryEntry(raw: unknown): DashboardTelemetryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (!isDashboardTelemetryEvent(r.event)) return null;

  const guildId = r.guildId === undefined || r.guildId === null || r.guildId === '' ? '' : r.guildId;
  if (typeof guildId !== 'string' || (guildId !== '' && !GUILD_ID_RE.test(guildId))) return null;

  if (typeof r.page !== 'string' || r.page.length > DASHBOARD_TELEMETRY_LIMITS.pageMaxLength || !PAGE_RE.test(r.page)) {
    return null;
  }
  // Un identifiant Discord dans le chemin trahirait un membre ou un salon :
  // le dashboard les remplace par `:id`, le bot refuse ce qui a échappé.
  if (/\d{15,}/.test(r.page)) return null;

  const tab = boundedToken(r.tab, DASHBOARD_TELEMETRY_LIMITS.tabMaxLength);
  const feature = boundedToken(r.feature, DASHBOARD_TELEMETRY_LIMITS.featureMaxLength);
  const dimension = boundedToken(r.dimension, DASHBOARD_TELEMETRY_LIMITS.dimensionMaxLength);
  if (tab === null || feature === null || dimension === null) return null;

  const count = boundedInt(r.count, DASHBOARD_TELEMETRY_LIMITS.maxCountPerEntry, 1);
  if (count === 0) return null;
  // La somme est bornée par entrée : `count` valeurs d'au plus `maxValue`.
  const valueSum = boundedInt(r.valueSum, DASHBOARD_TELEMETRY_LIMITS.maxValue * count, 0);

  return { guildId, page: r.page, tab, feature, event: r.event, dimension, count, valueSum };
}

// ── Lecture (/api/admin/analytics/dashboard-usage) ─────────────────────────

export type DashboardUsageRow = {
  views: number;
  /** Visiteurs uniques cumulés jour par jour (une personne revenue deux jours compte deux fois). */
  visitorDays: number;
  guilds: number;
  activeMs: number;
  /** Nombre de mesures de temps, pour la moyenne activeMs / timeSamples. */
  timeSamples: number;
  saves: number;
  saveErrors: number;
  apiErrors: number;
  blocked: number;
  exits: number;
};

export type DashboardUsagePageRow = DashboardUsageRow & { page: string; feature: string };
export type DashboardUsageFeatureRow = DashboardUsageRow & { feature: string; pages: number };
export type DashboardUsageTabRow = { page: string; tab: string; views: number };
export type DashboardUsageDimensionRow = { event: string; dimension: string; count: number; valueSum: number };
export type DashboardUsageDailyRow = { dateKey: string; views: number; visitorDays: number; sessions: number; saves: number };

export type DashboardUsageResult = {
  from: string;
  to: string;
  totals: DashboardUsageRow & { sessions: number };
  previousTotals: (DashboardUsageRow & { sessions: number }) | null;
  daily: DashboardUsageDailyRow[];
  pages: DashboardUsagePageRow[];
  features: DashboardUsageFeatureRow[];
  tabs: DashboardUsageTabRow[];
  /** Répartitions par dimension : sources, appareils, environnement, erreurs, latences… */
  dimensions: DashboardUsageDimensionRow[];
  /** Pages les plus lentes et les plus en erreur. */
  health: Array<{ page: string; latencySamples: number; latencyMs: number; slowShare: number; apiErrors: number; jsErrors: number; routeLoadMs: number; routeLoads: number }>;
};

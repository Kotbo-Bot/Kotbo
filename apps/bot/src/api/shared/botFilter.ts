/**
 * Filtrage des bots, crawlers et requêtes de préchargement sur les endpoints
 * publics d'acquisition (`/api/public/invite`, `/api/public/funnel`).
 *
 * Évite que les aperçus de liens Discord/Slack/Twitter ou les robots
 * d'indexation ne gonflent artificiellement la métrique `invite_redirected`
 * ou les visites du site.
 */

type HeaderLookup = { get(name: string): string | null } | Record<string, string | undefined>;

function readHeader(headers: HeaderLookup, name: string): string {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name) ?? '';
  }
  const rec = headers as Record<string, string | undefined>;
  return rec[name] ?? rec[name.toLowerCase()] ?? '';
}

const BOT_USER_AGENT_RE =
  /discordbot|twitterbot|googlebot|bingbot|facebookexternalhit|slackbot|linkedinbot|whatsapp|telegrambot|applebot|yandexbot|duckduckbot|baiduspider|semrushbot|ahrefsbot|mj12bot|petalbot|bytespider|gptbot|claudebot|curl\/|wget\/|python-requests|go-http-client|headlesschrome|lighthouse|\bbot\b|crawler|spider/i;

/**
 * Indique si une requête HTTP provient vraisemblablement d'un robot, d'un
 * aperçu automatique ou d'un préchargement navigateur (et non d'un clic humain).
 */
export function isBotRequest(req: { method?: string; headers: HeaderLookup }): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'HEAD' || method === 'OPTIONS') return true;

  for (const headerName of ['purpose', 'sec-purpose', 'x-purpose', 'x-moz']) {
    const val = readHeader(req.headers, headerName).toLowerCase();
    if (val.includes('prefetch') || val.includes('preview')) return true;
  }

  const ua = readHeader(req.headers, 'user-agent').trim();
  if (!ua) return true;
  return BOT_USER_AGENT_RE.test(ua);
}

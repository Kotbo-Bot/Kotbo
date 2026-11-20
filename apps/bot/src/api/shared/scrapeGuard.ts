/**
 * Refus des lectures automatisées sur les routes publiques qui exposent les
 * données d'un serveur (classement des niveaux).
 *
 * Même parti qu'Arcane ou Amari : les classements se consultent sur les pages
 * de Kotbo, pas en masse par un autre bot qui viendrait les aspirer.
 *
 * Le critère est ce qu'envoie un navigateur moderne en lançant `fetch` depuis
 * une page : `Sec-Fetch-Site` à `same-origin`/`same-site`, ou un en-tête
 * `Origin` (requête cross-origin, déjà filtrée par la garde CORS en amont, qui
 * refuse toute origine hors Kotbo). Un script serveur n'envoie ni l'un ni
 * l'autre par défaut.
 *
 * shortcut: ces en-têtes se falsifient ; c'est un barrage contre les outils
 * d'import et les scripts naïfs, pas contre un aspirateur déterminé. Passer à un
 * jeton signé servi avec la page si un vrai contournement apparaît.
 */
import type { IncomingHttpHeaders } from 'node:http';

const BROWSER_SITES = new Set(['same-origin', 'same-site']);

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isBrowserPageRequest(headers: IncomingHttpHeaders): boolean {
  // Ouvrir l'URL de l'API à la main dans un onglet n'est pas consulter la page.
  if (header(headers, 'sec-fetch-mode') === 'navigate') return false;
  const site = header(headers, 'sec-fetch-site');
  if (site && BROWSER_SITES.has(site)) return true;
  return !!header(headers, 'origin');
}

export const SCRAPE_REFUSED = {
  error: 'scraping_refused',
  message: 'Lecture automatisée refusée : ce classement se consulte uniquement depuis les pages de Kotbo.',
} as const;

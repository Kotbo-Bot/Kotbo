/**
 * Preuve qu'une requête de rendu de site arrive bien par le nginx du dashboard.
 *
 * `X-Kotbo-Site-Host` ne prouve rien : n'importe quel client qui appelle l'API
 * directement peut l'envoyer, et le site serait alors servi depuis l'origine de
 * l'API, à côté du cookie de session. Quand `SITE_PROXY_SECRET` est défini, le
 * proxy doit aussi présenter ce secret dans `X-Kotbo-Site-Proxy-Secret`.
 *
 * Non défini, rien ne change : le contrôle reste facultatif tant que le nginx du
 * dashboard n'envoie pas le secret (voir `apps/dashboard/nginx.conf`).
 */
import { timingSafeEqual } from 'node:crypto';

export const SITE_PROXY_SECRET_HEADER = 'x-kotbo-site-proxy-secret';

export function isTrustedSiteProxy(given: string | null | undefined, expected: string | null | undefined): boolean {
  const wanted = expected?.trim();
  if (!wanted) return true;
  const a = Buffer.from(given?.trim() ?? '');
  const b = Buffer.from(wanted);
  return a.length === b.length && timingSafeEqual(a, b);
}

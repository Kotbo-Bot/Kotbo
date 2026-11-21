import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

/**
 * Crée un middleware de rate-limiting basé sur la Map existante de shared.ts.
 * Réutilise la même logique que `checkRateLimit` mais sous forme de middleware Hono.
 *
 * @param limiterMap - La Map partagée pour stocker les timestamps par IP
 * @param limit - Nombre max de requêtes par fenêtre
 * @param windowMs - Durée de la fenêtre en millisecondes
 * @param message - Message d'erreur (optionnel)
 */
export function rateLimit(
  limiterMap: Map<string, number[]>,
  limit: number,
  windowMs: number,
  message = 'Trop de requêtes. Veuillez réessayer plus tard.',
) {
  let lastCleanup = Date.now();

  return createMiddleware(async (c, next) => {
    const ip = getClientIp(c);
    const now = Date.now();

    // Purge stale IPs every 5 minutes to prevent memory leak
    if (now - lastCleanup > 5 * 60 * 1000) {
      lastCleanup = now;
      for (const [key, ts] of limiterMap) {
        const valid = ts.filter((t) => now - t < windowMs);
        if (valid.length === 0) limiterMap.delete(key);
        else limiterMap.set(key, valid);
      }
    }

    const timestamps = limiterMap.get(ip) ?? [];
    const validTimestamps = timestamps.filter((t) => now - t < windowMs);

    if (validTimestamps.length >= limit) {
      throw new HTTPException(429, { message });
    }

    validTimestamps.push(now);
    limiterMap.set(ip, validTimestamps);

    await next();
  });
}

/** Extrait l'IP réelle du client (compatible reverse-proxy) */
function getClientIp(c: Parameters<Parameters<typeof createMiddleware>[0]>[0]): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  // Hono sur Bun expose l'IP via le contexte
  return (c.env as { ip?: string } | undefined)?.ip ?? '127.0.0.1';
}

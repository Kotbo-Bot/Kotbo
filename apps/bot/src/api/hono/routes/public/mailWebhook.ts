import { Hono } from 'hono';
import { logger } from '../../../../utils/logger.js';
import { processInboundMailWebhook } from '../../../../services/mail/mailService.js';
import { underLimit } from './kit.js';

const LOG = 'MailInboundWebhook';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const webhookRateLimiter = new Map<string, number[]>();

/**
 * Endpoint public de réception temps réel des emails entrants (AWS SNS, Resend,
 * ou pont SMTP/IMAP). Authentifié par le secret propre au compte ou la signature
 * fournisseur (Svix / header `x-kotbo-webhook-secret` / `?secret=`).
 */
export function createMailWebhookRouter() {
  const router = new Hono();

  router.post('/webhooks/inbound-email/:accountId', async (c) => {
    if (!underLimit(c, webhookRateLimiter, 120, 60_000)) {
      return c.json({ error: 'Trop de requêtes.' }, 429);
    }

    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return c.json({ error: 'Charge utile trop volumineuse.' }, 413);
    }

    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return c.json({ error: 'Charge utile trop volumineuse.' }, 413);
    }

    const accountId = c.req.param('accountId');
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    try {
      const outcome = await processInboundMailWebhook(
        accountId,
        rawBody,
        headers,
        c.req.query('secret'),
      );
      return c.json({ ok: true, status: outcome.status, result: outcome.result }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur webhook entrant.';
      if (message.includes('Signature') || message.includes('Secret') || message.includes('secret')) {
        return c.json({ error: message }, 401);
      }
      if (message.includes('introuvable') || message.includes('désactivé')) {
        return c.json({ error: message }, 404);
      }
      if (err instanceof SyntaxError) {
        return c.json({ error: 'JSON invalide.' }, 400);
      }
      logger.error(LOG, `Échec webhook entrant pour ${accountId} :`, err);
      return c.json({ error: 'Traitement webhook échoué.' }, 500);
    }
  });

  return router;
}

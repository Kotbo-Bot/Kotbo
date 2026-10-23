import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { SecretBoxUnavailableError, openSecret, sealSecret } from '../../../utils/secretBox.js';
import { json, readJsonBody, pushAudit, getGuildName, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
import {
  OUTGOING_EVENTS,
  OUTGOING_WEBHOOK_API_VERSION,
  PING_EVENT,
  normalizeSubscribedEvents,
} from '../../../services/integrations/outgoingWebhookEvents.js';
import { WebhookUrlError, assertWebhookUrlShape, generateWebhookSecret } from '../../../services/integrations/outgoingWebhookSecurity.js';
import {
  MAX_ATTEMPTS,
  MAX_WEBHOOKS_PER_GUILD,
  DELIVERY_RETENTION_DAYS,
  redeliver,
  sendPing,
} from '../../../services/integrations/outgoingWebhookService.js';

const SEGMENT = 'outgoing-webhooks';
const LOG = 'OutgoingWebhooksAPI';
const NAME_MAX = 60;
const DELIVERY_PAGE = 50;

const WEBHOOK_SELECT = {
  id: true,
  name: true,
  url: true,
  events: true,
  enabled: true,
  disabledReason: true,
  consecutiveFailures: true,
  lastDeliveryAt: true,
  lastStatusCode: true,
  createdById: true,
  createdAt: true,
} as const;

function readName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().slice(0, NAME_MAX);
  return name || null;
}

/**
 * Webhooks sortants : réglage, journal des envois, test et renvoi.
 *
 * Réservé à qui peut configurer le serveur, lecture comprise : l'URL et le
 * journal disent où partent les données des membres, et le journal contient
 * ces données.
 */
export async function handleOutgoingWebhookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  if (parts[4] !== SEGMENT) return false;
  const method = req.method;
  const auditUser = user.username ?? `User${user.userId}`;

  if (!access.canManageSettings) {
    json(res, 403, { error: 'Réservé aux administrateurs du dashboard.' });
    return true;
  }

  const audit = (action: string, details: string) => pushAudit(guildId, {
    user: auditUser,
    action,
    context: getGuildName(client, guildId),
    module: 'Webhooks sortants',
    eventType: 'Settings',
    details,
    channelId: null,
  }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));

  const findOwned = (id: string) => prisma.outgoingWebhook.findFirst({ where: { id, guildId }, select: WEBHOOK_SELECT });

  try {
    // GET /outgoing-webhooks : liste, santé sur 24 h et catalogue.
    if (parts.length === 5 && method === 'GET') {
      const webhooks = await prisma.outgoingWebhook.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' }, select: WEBHOOK_SELECT });
      const since = new Date(Date.now() - 86_400_000);
      const grouped = webhooks.length > 0
        ? await prisma.outgoingWebhookDelivery.groupBy({
          by: ['webhookId', 'status'],
          where: { guildId, createdAt: { gte: since } },
          _count: { _all: true },
        })
        : [];
      const stats = new Map<string, { success: number; failed: number; pending: number }>();
      for (const row of grouped) {
        const entry = stats.get(row.webhookId) ?? { success: 0, failed: 0, pending: 0 };
        if (row.status === 'SUCCESS') entry.success += row._count._all;
        else if (row.status === 'FAILED') entry.failed += row._count._all;
        else entry.pending += row._count._all;
        stats.set(row.webhookId, entry);
      }

      json(res, 200, {
        webhooks: webhooks.map((hook) => ({ ...hook, last24h: stats.get(hook.id) ?? { success: 0, failed: 0, pending: 0 } })),
        catalog: OUTGOING_EVENTS.map(({ type, category, description, sample }) => ({ type, category, description, sample })),
        limits: { maxWebhooks: MAX_WEBHOOKS_PER_GUILD, maxAttempts: MAX_ATTEMPTS, retentionDays: DELIVERY_RETENTION_DAYS },
        apiVersion: OUTGOING_WEBHOOK_API_VERSION,
        pingEvent: PING_EVENT,
      });
      return true;
    }

    // POST /outgoing-webhooks : création. Le secret n'est rendu en clair qu'ici,
    // à la rotation et sur demande explicite.
    if (parts.length === 5 && method === 'POST') {
      const body = await readJsonBody<{ name?: unknown; url?: unknown; events?: unknown }>(req);
      const name = readName(body?.name);
      if (!name) {
        json(res, 400, { error: 'Donne un nom à ce webhook.' });
        return true;
      }
      const events = normalizeSubscribedEvents(body?.events);
      if (events.length === 0) {
        json(res, 400, { error: 'Choisis au moins un événement.' });
        return true;
      }
      const target = assertWebhookUrlShape(body?.url);

      const count = await prisma.outgoingWebhook.count({ where: { guildId } });
      if (count >= MAX_WEBHOOKS_PER_GUILD) {
        json(res, 400, { error: `Limite atteinte : ${MAX_WEBHOOKS_PER_GUILD} webhooks par serveur.` });
        return true;
      }

      const secret = generateWebhookSecret();
      const webhook = await prisma.outgoingWebhook.create({
        data: { guildId, name, url: target, events, secret: sealSecret(secret), createdById: user.userId },
        select: WEBHOOK_SELECT,
      });
      await audit('Création webhook sortant', `« ${name} » vers ${new URL(target).host} (${events.join(', ')}).`);
      json(res, 201, { webhook: { ...webhook, last24h: { success: 0, failed: 0, pending: 0 } }, secret });
      return true;
    }

    const webhookId = parts[5];
    if (!webhookId) return false;

    // PATCH /outgoing-webhooks/:id : nom, URL, événements, état.
    if (parts.length === 6 && method === 'PATCH') {
      const existing = await findOwned(webhookId);
      if (!existing) {
        json(res, 404, { error: 'Webhook introuvable.' });
        return true;
      }
      const body = await readJsonBody<{ name?: unknown; url?: unknown; events?: unknown; enabled?: unknown }>(req);
      const data: Record<string, unknown> = {};
      if (body?.name !== undefined) {
        const name = readName(body.name);
        if (!name) {
          json(res, 400, { error: 'Donne un nom à ce webhook.' });
          return true;
        }
        data.name = name;
      }
      if (body?.url !== undefined) data.url = assertWebhookUrlShape(body.url);
      if (body?.events !== undefined) {
        const events = normalizeSubscribedEvents(body.events);
        if (events.length === 0) {
          json(res, 400, { error: 'Choisis au moins un événement.' });
          return true;
        }
        data.events = events;
      }
      if (typeof body?.enabled === 'boolean') {
        data.enabled = body.enabled;
        // Réactiver repart d'une page blanche : sinon le premier échec suivant
        // recouperait aussitôt un webhook qu'on vient de réparer.
        if (body.enabled) Object.assign(data, { consecutiveFailures: 0, disabledReason: null });
      }

      const webhook = await prisma.outgoingWebhook.update({ where: { id: webhookId }, data, select: WEBHOOK_SELECT });
      const changes = Object.keys(data).filter((key) => key !== 'consecutiveFailures' && key !== 'disabledReason');
      await audit('Modification webhook sortant', `« ${webhook.name} » : ${changes.join(', ') || 'aucun changement'}.`);
      json(res, 200, { webhook });
      return true;
    }

    // DELETE /outgoing-webhooks/:id
    if (parts.length === 6 && method === 'DELETE') {
      const existing = await findOwned(webhookId);
      if (!existing) {
        json(res, 404, { error: 'Webhook introuvable.' });
        return true;
      }
      await prisma.outgoingWebhook.delete({ where: { id: webhookId } });
      await audit('Suppression webhook sortant', `« ${existing.name} » vers ${new URL(existing.url).host}.`);
      json(res, 200, { ok: true });
      return true;
    }

    // GET /outgoing-webhooks/:id/secret : révélation explicite, journalisée.
    if (parts.length === 7 && parts[6] === 'secret' && method === 'GET') {
      const row = await prisma.outgoingWebhook.findFirst({ where: { id: webhookId, guildId }, select: { name: true, secret: true } });
      if (!row) {
        json(res, 404, { error: 'Webhook introuvable.' });
        return true;
      }
      const secret = openSecret(row.secret);
      if (!secret) {
        json(res, 409, { error: 'Secret illisible : régénère-le.' });
        return true;
      }
      await audit('Affichage secret webhook sortant', `« ${row.name} ».`);
      json(res, 200, { secret });
      return true;
    }

    // POST /outgoing-webhooks/:id/rotate-secret
    if (parts.length === 7 && parts[6] === 'rotate-secret' && method === 'POST') {
      const existing = await findOwned(webhookId);
      if (!existing) {
        json(res, 404, { error: 'Webhook introuvable.' });
        return true;
      }
      const secret = generateWebhookSecret();
      await prisma.outgoingWebhook.update({ where: { id: webhookId }, data: { secret: sealSecret(secret) } });
      await audit('Rotation secret webhook sortant', `« ${existing.name} ».`);
      json(res, 200, { secret });
      return true;
    }

    // POST /outgoing-webhooks/:id/test : envoi de « webhook.ping », réponse attendue.
    if (parts.length === 7 && parts[6] === 'test' && method === 'POST') {
      const existing = await findOwned(webhookId);
      if (!existing) {
        json(res, 404, { error: 'Webhook introuvable.' });
        return true;
      }
      const result = await sendPing(webhookId, guildId);
      json(res, 200, { result });
      return true;
    }

    // GET /outgoing-webhooks/:id/deliveries?status=&event=&cursor=
    if (parts.length === 7 && parts[6] === 'deliveries' && method === 'GET') {
      const existing = await findOwned(webhookId);
      if (!existing) {
        json(res, 404, { error: 'Webhook introuvable.' });
        return true;
      }
      const status = url.searchParams.get('status');
      const event = url.searchParams.get('event');
      const cursor = url.searchParams.get('cursor');
      const rows = await prisma.outgoingWebhookDelivery.findMany({
        where: {
          webhookId,
          ...(status && ['SUCCESS', 'FAILED', 'PENDING'].includes(status) ? { status } : {}),
          ...(event ? { event } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: DELIVERY_PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, event: true, status: true, attempts: true, responseStatus: true, durationMs: true, nextAttemptAt: true, deliveredAt: true, createdAt: true },
      });
      const hasMore = rows.length > DELIVERY_PAGE;
      const deliveries = hasMore ? rows.slice(0, DELIVERY_PAGE) : rows;
      json(res, 200, { deliveries, nextCursor: hasMore ? deliveries[deliveries.length - 1].id : null });
      return true;
    }

    const deliveryId = parts[7];

    // GET /outgoing-webhooks/:id/deliveries/:deliveryId : requête et réponse complètes.
    if (parts.length === 8 && parts[6] === 'deliveries' && method === 'GET') {
      const delivery = await prisma.outgoingWebhookDelivery.findFirst({ where: { id: deliveryId, webhookId, guildId } });
      if (!delivery) {
        json(res, 404, { error: 'Envoi introuvable.' });
        return true;
      }
      json(res, 200, { delivery });
      return true;
    }

    // POST /outgoing-webhooks/:id/deliveries/:deliveryId/redeliver
    if (parts.length === 9 && parts[6] === 'deliveries' && parts[8] === 'redeliver' && method === 'POST') {
      const delivery = await prisma.outgoingWebhookDelivery.findFirst({ where: { id: deliveryId, webhookId, guildId }, select: { id: true } });
      if (!delivery) {
        json(res, 404, { error: 'Envoi introuvable.' });
        return true;
      }
      const result = await redeliver(deliveryId, guildId);
      json(res, 200, { result });
      return true;
    }
  } catch (err) {
    if (err instanceof WebhookUrlError) {
      json(res, 400, { error: err.message });
      return true;
    }
    if (err instanceof SecretBoxUnavailableError) {
      json(res, 503, { error: 'Le chiffrement des secrets n’est pas configuré sur cette instance.' });
      return true;
    }
    logger.error(LOG, `Erreur sur ${method} ${parts.join('/')} :`, err);
    jsonFailure(res, err, 'Erreur sur les webhooks sortants', LOG);
    return true;
  }

  return false;
}

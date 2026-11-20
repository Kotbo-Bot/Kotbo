import { isModulePaused } from '@kotbo/contracts';
import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { SecretBoxUnavailableError, openSecret, sealSecret } from '../../../utils/secretBox.js';
import { pushAudit, getGuildName } from '../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
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
export function createOutgoingWebhooksRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const adminOnly = createMiddleware(async (c, next) => {
    if (!c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Réservé aux administrateurs du dashboard.' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), adminOnly] as const;

  /** Journal et recherche d'un webhook, liés au serveur de la requête. */
  const helpers = (c: Context) => {
    const guildId = c.req.param('guildId')!;
    return {
      audit: (action: string, details: string) => pushAudit(guildId, {
        user: auditUserOf(c),
        action,
        context: getGuildName(client, guildId),
        module: 'Webhooks sortants',
        eventType: 'Settings',
        details,
        channelId: null,
      }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err)),
      findOwned: (id: string) => prisma.outgoingWebhook.findFirst({ where: { id, guildId }, select: WEBHOOK_SELECT }),
    };
  };

  router.onError((err, c) => {
    if (err instanceof WebhookUrlError) return send(c, { error: err.message }, 400);
    if (err instanceof SecretBoxUnavailableError) {
      return send(c, { error: 'Le chiffrement des secrets n’est pas configuré sur cette instance.' }, 503);
    }
    logger.error(LOG, `Erreur sur ${c.req.method} ${c.req.path} :`, err);
    return fail(c, err, 'Erreur sur les webhooks sortants', LOG);
  });


  router.get(`${base}/outgoing-webhooks`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
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

    return send(c, {
      webhooks: webhooks.map((hook) => ({ ...hook, last24h: stats.get(hook.id) ?? { success: 0, failed: 0, pending: 0 } })),
      // Un événement d'un module en pause n'est plus émis : inutile de l'offrir.
      catalog: OUTGOING_EVENTS
        .filter((event) => !isModulePaused(event.module))
        .map(({ type, category, description, sample }) => ({ type, category, description, sample })),
      limits: { maxWebhooks: MAX_WEBHOOKS_PER_GUILD, maxAttempts: MAX_ATTEMPTS, retentionDays: DELIVERY_RETENTION_DAYS },
      apiVersion: OUTGOING_WEBHOOK_API_VERSION,
      pingEvent: PING_EVENT,
    });
  });

  // à la rotation et sur demande explicite.
  router.post(`${base}/outgoing-webhooks`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const { audit } = helpers(c);
    const body = await readBody<{ name?: unknown; url?: unknown; events?: unknown }>(c);
    const name = readName(body?.name);
    if (!name) {
      return send(c, { error: 'Donne un nom à ce webhook.' }, 400);
    }
    const events = normalizeSubscribedEvents(body?.events);
    if (events.length === 0) {
      return send(c, { error: 'Choisis au moins un événement.' }, 400);
    }
    const target = assertWebhookUrlShape(body?.url);
    const count = await prisma.outgoingWebhook.count({ where: { guildId } });
    if (count >= MAX_WEBHOOKS_PER_GUILD) {
      return send(c, { error: `Limite atteinte : ${MAX_WEBHOOKS_PER_GUILD} webhooks par serveur.` }, 400);
    }

    const secret = generateWebhookSecret();
    const webhook = await prisma.outgoingWebhook.create({
      data: { guildId, name, url: target, events, secret: sealSecret(secret), createdById: user.userId },
      select: WEBHOOK_SELECT,
    });
    await audit('Création webhook sortant', `« ${name} » vers ${new URL(target).host} (${events.join(', ')}).`);
    return send(c, { webhook: { ...webhook, last24h: { success: 0, failed: 0, pending: 0 } }, secret }, 201);
  });

  router.patch(`${base}/outgoing-webhooks/:webhookId`, ...gate, async (c) => {
    const webhookId = c.req.param('webhookId');
    const { audit, findOwned } = helpers(c);
    const existing = await findOwned(webhookId);
    if (!existing) {
      return send(c, { error: 'Webhook introuvable.' }, 404);
    }
    const body = await readBody<{ name?: unknown; url?: unknown; events?: unknown; enabled?: unknown }>(c);
    const data: Record<string, unknown> = {};
    if (body?.name !== undefined) {
      const name = readName(body.name);
      if (!name) {
        return send(c, { error: 'Donne un nom à ce webhook.' }, 400);
      }
      data.name = name;
    }
    if (body?.url !== undefined) data.url = assertWebhookUrlShape(body.url);
    if (body?.events !== undefined) {
      const events = normalizeSubscribedEvents(body.events);
      if (events.length === 0) {
        return send(c, { error: 'Choisis au moins un événement.' }, 400);
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
    return send(c, { webhook });
  });

  router.delete(`${base}/outgoing-webhooks/:webhookId`, ...gate, async (c) => {
    const webhookId = c.req.param('webhookId');
    const { audit, findOwned } = helpers(c);
    const existing = await findOwned(webhookId);
    if (!existing) {
      return send(c, { error: 'Webhook introuvable.' }, 404);
    }
    await prisma.outgoingWebhook.delete({ where: { id: webhookId } });
    await audit('Suppression webhook sortant', `« ${existing.name} » vers ${new URL(existing.url).host}.`);
    return send(c, { ok: true });
  });

  router.get(`${base}/outgoing-webhooks/:webhookId/secret`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const webhookId = c.req.param('webhookId');
    const { audit } = helpers(c);
    const row = await prisma.outgoingWebhook.findFirst({ where: { id: webhookId, guildId }, select: { name: true, secret: true } });
    if (!row) {
      return send(c, { error: 'Webhook introuvable.' }, 404);
    }
    const secret = openSecret(row.secret);
    if (!secret) {
      return send(c, { error: 'Secret illisible : régénère-le.' }, 409);
    }
    await audit('Affichage secret webhook sortant', `« ${row.name} ».`);
    return send(c, { secret });
  });

  router.post(`${base}/outgoing-webhooks/:webhookId/rotate-secret`, ...gate, async (c) => {
    const webhookId = c.req.param('webhookId');
    const { audit, findOwned } = helpers(c);
    const existing = await findOwned(webhookId);
    if (!existing) {
      return send(c, { error: 'Webhook introuvable.' }, 404);
    }
    const secret = generateWebhookSecret();
    await prisma.outgoingWebhook.update({ where: { id: webhookId }, data: { secret: sealSecret(secret) } });
    await audit('Rotation secret webhook sortant', `« ${existing.name} ».`);
    return send(c, { secret });
  });

  router.post(`${base}/outgoing-webhooks/:webhookId/test`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const webhookId = c.req.param('webhookId');
    const { findOwned } = helpers(c);
    const existing = await findOwned(webhookId);
    if (!existing) {
      return send(c, { error: 'Webhook introuvable.' }, 404);
    }
    const result = await sendPing(webhookId, guildId);
    return send(c, { result });
  });

  router.get(`${base}/outgoing-webhooks/:webhookId/deliveries`, ...gate, async (c) => {
    const webhookId = c.req.param('webhookId');
    const { findOwned } = helpers(c);
    const existing = await findOwned(webhookId);
    if (!existing) {
      return send(c, { error: 'Webhook introuvable.' }, 404);
    }
    const status = (c.req.query('status') ?? null);
    const event = (c.req.query('event') ?? null);
    const cursor = (c.req.query('cursor') ?? null);
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
    return send(c, { deliveries, nextCursor: hasMore ? deliveries[deliveries.length - 1].id : null });
  });

  router.get(`${base}/outgoing-webhooks/:webhookId/deliveries/:deliveryId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const webhookId = c.req.param('webhookId');
    const deliveryId = c.req.param('deliveryId');
    const delivery = await prisma.outgoingWebhookDelivery.findFirst({ where: { id: deliveryId, webhookId, guildId } });
    if (!delivery) {
      return send(c, { error: 'Envoi introuvable.' }, 404);
    }
    return send(c, { delivery });
  });

  router.post(`${base}/outgoing-webhooks/:webhookId/deliveries/:deliveryId/redeliver`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const webhookId = c.req.param('webhookId');
    const deliveryId = c.req.param('deliveryId');
    const delivery = await prisma.outgoingWebhookDelivery.findFirst({ where: { id: deliveryId, webhookId, guildId }, select: { id: true } });
    if (!delivery) {
      return send(c, { error: 'Envoi introuvable.' }, 404);
    }
    const result = await redeliver(deliveryId, guildId);
    return send(c, { result });
  });

  return router;
}


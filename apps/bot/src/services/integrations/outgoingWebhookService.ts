/**
 * Webhooks sortants : chaque événement souscrit part en POST signé vers l'URL
 * choisie par le serveur.
 *
 * Le modèle suit Stripe et GitHub :
 * - un événement porte un identifiant stable (`evt_…`) que le destinataire
 *   peut utiliser pour dédoublonner, relances et renvois compris ;
 * - un envoi qui n'obtient pas de réponse 2xx est relancé à intervalles
 *   croissants pendant près de deux jours ;
 * - chaque tentative est journalisée (code, début de réponse, durée) et peut
 *   être renvoyée à la main depuis le dashboard ;
 * - un point de terminaison qui échoue sans discontinuer est coupé, comme le
 *   fait Svix, plutôt que de recevoir des relances pour rien pendant des mois.
 *
 * Tout tourne dans le processus du bot (un seul en production) : l'envoi
 * immédiat part en tâche de fond, les relances sont reprises chaque minute.
 */
import crypto from 'node:crypto';
import { kotboEventBus } from '@kotbo/core';
import pLimit from 'p-limit';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { fetchExternal } from '../../utils/http.js';
import { logger } from '../../utils/logger.js';
import { openSecret } from '../../utils/secretBox.js';
import {
  OUTGOING_EVENTS,
  OUTGOING_WEBHOOK_API_VERSION,
  PING_EVENT,
  buildEnvelope,
  subscribesTo,
  type OutgoingEnvelope,
} from './outgoingWebhookEvents.js';
import { WebhookUrlError, assertWebhookUrlReachable, signWebhookPayload } from './outgoingWebhookSecurity.js';

const LOG = 'OutgoingWebhooks';

/** Délais avant chaque relance : 8 tentatives sur environ 45 heures. */
export const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Tentatives échouées d'affilée avant de couper le webhook. */
export const AUTO_DISABLE_AFTER_FAILURES = 40;

export const MAX_WEBHOOKS_PER_GUILD = 10;
export const DELIVERY_RETENTION_DAYS = 30;

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 1_000;
const RETRY_BATCH = 50;

/** Envois simultanés, tous serveurs confondus : un destinataire lent ne doit pas saturer le bot. */
const sendLimit = pLimit(8);

interface CachedWebhook {
  id: string;
  events: string[];
  enabled: boolean;
}

const webhooksCacheKey = (guildId: string) => `guild:${guildId}:outgoing-webhooks`;

async function getActiveWebhooks(guildId: string): Promise<CachedWebhook[]> {
  return cache.wrap(webhooksCacheKey(guildId), 60, () =>
    prisma.outgoingWebhook.findMany({
      where: { guildId, enabled: true },
      select: { id: true, events: true, enabled: true },
    }),
  );
}

export async function invalidateWebhookCache(guildId: string): Promise<void> {
  await cache.invalidateGuild(guildId);
}

/**
 * Échéance posée sur un envoi tenté tout de suite : le balayage des relances
 * ne le reprendra que si cette tentative n'a jamais abouti (bot arrêté en
 * plein envoi), et pas pendant qu'elle est en vol.
 */
function immediateLease(): Date {
  return new Date(Date.now() + 2 * 60_000);
}

export function newEventId(): string {
  return `evt_${crypto.randomBytes(12).toString('base64url')}`;
}

export function nextAttemptDelay(attempts: number): number | null {
  return RETRY_DELAYS_MS[attempts - 1] ?? null;
}

/**
 * Publie un événement vers tous les webhooks du serveur qui y sont abonnés.
 * L'envoi part en tâche de fond : l'appelant (un abonné du bus) n'attend pas
 * un serveur distant.
 */
export async function publishOutgoingEvent(guildId: string, type: string, data: Record<string, unknown>): Promise<number> {
  const webhooks = (await getActiveWebhooks(guildId)).filter((hook) => subscribesTo(hook.events, type));
  if (webhooks.length === 0) return 0;

  const envelope = buildEnvelope(newEventId(), type, guildId, data);
  const deliveries = await Promise.all(webhooks.map((hook) =>
    prisma.outgoingWebhookDelivery.create({
      data: { webhookId: hook.id, guildId, event: type, payload: envelope as never, nextAttemptAt: immediateLease() },
      select: { id: true },
    }),
  ));

  for (const delivery of deliveries) {
    void sendLimit(() => attemptDelivery(delivery.id)).catch((err) => logger.warn(LOG, `Envoi ${delivery.id} interrompu :`, err));
  }
  return deliveries.length;
}

export interface DeliveryAttemptResult {
  ok: boolean;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
}

/**
 * Une tentative d'envoi. Met à jour la ligne d'envoi et les compteurs du
 * webhook, et planifie la relance suivante si l'envoi échoue.
 */
export async function attemptDelivery(deliveryId: string, fetcher: typeof fetchExternal = fetchExternal): Promise<DeliveryAttemptResult | null> {
  const delivery = await prisma.outgoingWebhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: { select: { id: true, guildId: true, url: true, secret: true, enabled: true, consecutiveFailures: true } } },
  });
  if (!delivery || delivery.status !== 'PENDING') return null;

  const { webhook } = delivery;
  const attempts = delivery.attempts + 1;
  const startedAt = Date.now();

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let ok = false;
  let permanent = false;

  if (!webhook.enabled) {
    responseBody = 'Webhook désactivé : envoi abandonné.';
    permanent = true;
  } else {
    try {
      const url = await assertWebhookUrlReachable(webhook.url);
      const secret = openSecret(webhook.secret);
      if (!secret) throw new Error('Secret de signature illisible : régénère-le depuis le dashboard.');

      const body = JSON.stringify(delivery.payload);
      const timestamp = Math.floor(Date.now() / 1000);
      const envelope = delivery.payload as unknown as OutgoingEnvelope;
      const response = await fetcher(url, {
        method: 'POST',
        // Une redirection pourrait renvoyer vers une adresse interne que le
        // contrôle ci-dessus n'a jamais vue : on ne la suit pas.
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Kotbo-Webhooks/1.0',
          'Kotbo-Signature': signWebhookPayload(secret, body, timestamp),
          'Kotbo-Event': delivery.event,
          'Kotbo-Event-Id': envelope?.id ?? delivery.id,
          'Kotbo-Delivery': delivery.id,
          'Kotbo-Api-Version': OUTGOING_WEBHOOK_API_VERSION,
        },
        body,
      }, REQUEST_TIMEOUT_MS);

      responseStatus = response.status;
      responseBody = (await response.text().catch(() => '')).slice(0, RESPONSE_BODY_LIMIT) || null;
      ok = response.status >= 200 && response.status < 300;
    } catch (err) {
      if (err instanceof WebhookUrlError) permanent = true;
      responseBody = err instanceof Error
        ? (err.name === 'TimeoutError' ? `Pas de réponse en ${REQUEST_TIMEOUT_MS / 1000} s.` : err.message)
        : String(err);
      responseBody = responseBody.slice(0, RESPONSE_BODY_LIMIT);
    }
  }

  const durationMs = Date.now() - startedAt;
  const delay = ok || permanent ? null : nextAttemptDelay(attempts);
  const status: DeliveryAttemptResult['status'] = ok ? 'SUCCESS' : delay === null ? 'FAILED' : 'PENDING';
  const now = new Date();

  await prisma.outgoingWebhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts,
      status,
      responseStatus,
      responseBody,
      durationMs,
      deliveredAt: ok ? now : null,
      nextAttemptAt: delay === null ? null : new Date(now.getTime() + delay),
    },
  });

  if (webhook.enabled) await recordWebhookOutcome(webhook.id, webhook.guildId, ok, responseStatus, webhook.consecutiveFailures);

  return { ok, status, responseStatus, responseBody, durationMs };
}

async function recordWebhookOutcome(webhookId: string, guildId: string, ok: boolean, responseStatus: number | null, previousFailures: number): Promise<void> {
  const failures = ok ? 0 : previousFailures + 1;
  const disable = !ok && failures >= AUTO_DISABLE_AFTER_FAILURES;

  await prisma.outgoingWebhook.update({
    where: { id: webhookId },
    data: {
      consecutiveFailures: failures,
      lastDeliveryAt: new Date(),
      lastStatusCode: responseStatus,
      ...(disable
        ? { enabled: false, disabledReason: `Coupé automatiquement après ${failures} échecs d'affilée.` }
        : {}),
    },
  }).catch((err) => logger.warn(LOG, `Compteurs du webhook ${webhookId} non mis à jour :`, err));

  if (disable) {
    logger.warn(LOG, `Webhook ${webhookId} (serveur ${guildId}) coupé après ${failures} échecs.`);
    await invalidateWebhookCache(guildId);
  }
}

/** Reprend les envois dont la relance est due. Appelé chaque minute. */
export async function retryDueDeliveries(): Promise<number> {
  const now = new Date();
  const due = await prisma.outgoingWebhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: RETRY_BATCH,
    select: { id: true, nextAttemptAt: true },
  });

  // Réservation avant l'envoi : l'échéance est repoussée seulement si personne
  // ne l'a fait entre-temps. Un second processus, ou un balayage qui chevauche
  // un envoi immédiat encore en vol, ne renverra donc pas le même événement.
  const lease = new Date(now.getTime() + 5 * 60_000);
  const claimed: string[] = [];
  for (const delivery of due) {
    const { count } = await prisma.outgoingWebhookDelivery.updateMany({
      where: { id: delivery.id, status: 'PENDING', nextAttemptAt: delivery.nextAttemptAt },
      data: { nextAttemptAt: lease },
    });
    if (count === 1) claimed.push(delivery.id);
  }

  await Promise.all(claimed.map((id) => sendLimit(() => attemptDelivery(id))));
  return claimed.length;
}

let lastPruneAt = 0;

/** Efface le journal au-delà de la rétention. Au plus une fois par heure. */
export async function pruneOldDeliveries(now = Date.now()): Promise<number> {
  if (now - lastPruneAt < 3_600_000) return 0;
  lastPruneAt = now;
  const cutoff = new Date(now - DELIVERY_RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.outgoingWebhookDelivery.deleteMany({ where: { createdAt: { lt: cutoff }, status: { not: 'PENDING' } } });
  return count;
}

export async function runOutgoingWebhookSweep(): Promise<void> {
  await retryDueDeliveries();
  await pruneOldDeliveries();
}

/** Envoie l'événement de test « webhook.ping » et attend la réponse. */
export async function sendPing(webhookId: string, guildId: string): Promise<DeliveryAttemptResult | null> {
  const envelope = buildEnvelope(newEventId(), PING_EVENT, guildId, {
    message: 'Ceci est un envoi de test depuis le dashboard Kotbo.',
    webhookId,
  });
  const delivery = await prisma.outgoingWebhookDelivery.create({
    data: { webhookId, guildId, event: PING_EVENT, payload: envelope as never, nextAttemptAt: immediateLease() },
    select: { id: true },
  });
  return attemptDelivery(delivery.id);
}

/**
 * Renvoie un envoi passé, à l'identique : même enveloppe, donc même
 * identifiant d'événement, pour que le destinataire puisse dédoublonner.
 */
export async function redeliver(deliveryId: string, guildId: string): Promise<DeliveryAttemptResult | null> {
  const original = await prisma.outgoingWebhookDelivery.findFirst({
    where: { id: deliveryId, guildId },
    select: { webhookId: true, event: true, payload: true },
  });
  if (!original) return null;
  const copy = await prisma.outgoingWebhookDelivery.create({
    data: { webhookId: original.webhookId, guildId, event: original.event, payload: original.payload as never, nextAttemptAt: immediateLease() },
    select: { id: true },
  });
  return attemptDelivery(copy.id);
}

/** Branche le catalogue sur le bus d'événements. Appelé une fois au démarrage. */
export function registerOutgoingWebhookSubscribers(): void {
  for (const definition of OUTGOING_EVENTS) {
    kotboEventBus.subscribe(definition.source, async (payload) => {
      const guildId = (payload as { guildId?: string }).guildId;
      if (!guildId) return;
      const data = definition.map(payload as never);
      if (!data) return;
      await publishOutgoingEvent(guildId, definition.type, data);
    }, 'outgoing-webhooks');
  }
}

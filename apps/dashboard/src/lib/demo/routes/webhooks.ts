/**
 * Webhooks sortants. Le catalogue reprend les événements réels du bot
 * (`services/integrations/outgoingWebhookEvents.ts`).
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { G } from '../crud';
import { DAY, ME, ago } from '../fixtures';

const EVENTS: Array<[string, 'members' | 'moderation' | 'tickets' | 'community' | 'server', string]> = [
  ['member.joined', 'members', 'Un membre rejoint le serveur.'],
  ['member.joined_via_invite', 'members', "Arrivée dont l'invitation utilisée a été identifiée."],
  ['member.left', 'members', 'Un membre quitte le serveur (départ, exclusion ou bannissement).'],
  ['member.roles_updated', 'members', 'Des rôles sont ajoutés ou retirés à un membre.'],
  ['member.level_up', 'members', 'Un membre passe un niveau.'],
  ['sanction.applied', 'moderation', 'Une sanction est appliquée (avertissement, exclusion, bannissement…).'],
  ['sanction.revoked', 'moderation', 'Une sanction est levée (débannissement, fin de mise en sourdine…).'],
  ['automod.triggered', 'moderation', "Une règle d'automodération s'est déclenchée. Le texte capté n'est pas transmis."],
  ['ticket.created', 'tickets', 'Un ticket est ouvert.'],
  ['ticket.closed', 'tickets', 'Un ticket est fermé.'],
  ['ticket.rated', 'tickets', 'Un membre note le support reçu sur un ticket.'],
  ['form.submitted', 'community', 'Une réponse est envoyée à un formulaire.'],
  ['suggestion.created', 'community', 'Une suggestion est proposée.'],
  ['suggestion.resolved', 'community', 'Une suggestion change de statut : acceptée, en cours, refusée ou mise en place.'],
  ['suggestion.threshold_reached', 'community', 'Une suggestion atteint le seuil de votes du serveur.'],
  ['giveaway.winner', 'community', 'Un membre gagne un concours.'],
  ['giveaway.ended', 'community', 'Un concours est clôturé.'],
  ['channel.created', 'server', 'Un salon est créé.'],
  ['channel.deleted', 'server', 'Un salon est supprimé.'],
  ['role.created', 'server', 'Un rôle est créé.'],
  ['role.deleted', 'server', 'Un rôle est supprimé.'],
];

const sample = (type: string) => ({ userId: '123456789012345678', userTag: 'alice', event: type, at: '2026-10-04T18:00:00.000Z' });
const catalog = () => EVENTS.map(([type, category, description]) => ({ type, category, description, sample: sample(type) }));

type Webhook = {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  lastStatusCode: number | null;
  createdById: string;
  createdAt: string;
  last24h: { success: number; failed: number; pending: number };
};

const seed = (): Webhook[] => [
  {
    id: 'wh-1',
    name: 'CRM de l’asso',
    url: 'https://hooks.exemple.fr/kotbo/membres',
    events: ['member.joined', 'member.left', 'member.level_up'],
    enabled: true,
    disabledReason: null,
    consecutiveFailures: 0,
    lastDeliveryAt: ago(14),
    lastStatusCode: 200,
    createdById: ME.id,
    createdAt: ago(21 * DAY),
    last24h: { success: 38, failed: 0, pending: 0 },
  },
  {
    id: 'wh-2',
    name: 'Alerte modération (n8n)',
    url: 'https://n8n.exemple.fr/webhook/moderation',
    events: ['sanction.applied', 'automod.triggered', 'ticket.created'],
    enabled: true,
    disabledReason: null,
    consecutiveFailures: 1,
    lastDeliveryAt: ago(48),
    lastStatusCode: 502,
    createdById: ME.id,
    createdAt: ago(9 * DAY),
    last24h: { success: 11, failed: 1, pending: 1 },
  },
];

const KEY = 'outgoing-webhooks';
const all = () => demoDb.get(KEY, seed);

function deliveries(webhook: Webhook) {
  return Array.from({ length: 12 }, (_, i) => {
    const failed = webhook.id === 'wh-2' && i === 0;
    return {
      id: `${webhook.id}-d${i}`,
      event: webhook.events[i % webhook.events.length],
      status: failed ? 'FAILED' : 'SUCCESS',
      attempts: failed ? 3 : 1,
      responseStatus: failed ? 502 : 200,
      durationMs: 80 + ((i * 37) % 220),
      nextAttemptAt: null,
      deliveredAt: failed ? null : ago(14 + i * 55),
      createdAt: ago(14 + i * 55),
    };
  });
}

const attempt = () => ({ ok: true, status: 'SUCCESS', responseStatus: 200, responseBody: '{"received":true}', durationMs: 142 });

export function registerWebhookRoutes(): void {
  const base = `${G}/outgoing-webhooks`;
  route('GET', base, () => ({
    webhooks: all(),
    catalog: catalog(),
    limits: { maxWebhooks: 10, maxAttempts: 4, retentionDays: 30 },
    apiVersion: '2026-10-01',
    pingEvent: 'webhook.ping',
  }));
  route('POST', base, ({ body }) => {
    const webhook: Webhook = {
      id: demoId(),
      name: body?.name || 'Nouveau webhook',
      url: body?.url || 'https://exemple.fr/webhook',
      events: body?.events ?? [],
      enabled: true,
      disabledReason: null,
      consecutiveFailures: 0,
      lastDeliveryAt: null,
      lastStatusCode: null,
      createdById: ME.id,
      createdAt: new Date().toISOString(),
      last24h: { success: 0, failed: 0, pending: 0 },
    };
    demoDb.set(KEY, [...all(), webhook]);
    return { webhook, secret: `whsec_demo_${Math.random().toString(36).slice(2, 18)}` };
  });
  route('PATCH', `${base}/:id`, ({ params, body }) => {
    let webhook: Webhook | undefined;
    demoDb.set(KEY, all().map((w) => (w.id === params.id ? (webhook = { ...w, ...(body ?? {}) }) : w)));
    return { webhook };
  });
  route('DELETE', `${base}/:id`, ({ params }) => {
    demoDb.set(KEY, all().filter((w) => w.id !== params.id));
    return { ok: true };
  });
  route('GET', `${base}/:id/secret`, () => ({ secret: 'whsec_demo_7d1f0c9b2a64e8f3' }));
  route('POST', `${base}/:id/rotate-secret`, () => ({ secret: `whsec_demo_${Math.random().toString(36).slice(2, 18)}` }));
  route('POST', `${base}/:id/test`, () => ({ result: attempt() }));
  route('GET', `${base}/:id/deliveries`, ({ params }) => {
    const webhook = all().find((w) => w.id === params.id);
    return { deliveries: webhook ? deliveries(webhook) : [], nextCursor: null };
  });
  route('GET', `${base}/:id/deliveries/:deliveryId`, ({ params }) => {
    const webhook = all().find((w) => w.id === params.id);
    const delivery = webhook ? deliveries(webhook).find((d) => d.id === params.deliveryId) : undefined;
    return {
      delivery: delivery && {
        ...delivery,
        payload: { id: delivery.id, type: delivery.event, apiVersion: '2026-10-01', guildId: '900000000000000001', data: sample(delivery.event) },
        responseBody: delivery.status === 'FAILED' ? '<html>502 Bad Gateway</html>' : '{"received":true}',
      },
    };
  });
  route('POST', `${base}/:id/deliveries/:deliveryId/redeliver`, () => ({ result: attempt() }));
}

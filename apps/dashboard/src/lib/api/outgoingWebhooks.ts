/** Webhooks sortants : points de terminaison, secret, journal des envois. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type DeliveryStatus = 'SUCCESS' | 'FAILED' | 'PENDING';

export interface OutgoingWebhook {
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
}

export interface OutgoingEventInfo {
  type: string;
  category: 'members' | 'moderation' | 'tickets' | 'community' | 'server';
  description: string;
  sample: Record<string, unknown>;
}

export interface OutgoingWebhookOverview {
  webhooks: OutgoingWebhook[];
  catalog: OutgoingEventInfo[];
  limits: { maxWebhooks: number; maxAttempts: number; retentionDays: number };
  apiVersion: string;
  pingEvent: string;
}

export interface DeliverySummary {
  id: string;
  event: string;
  status: DeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface DeliveryDetail extends DeliverySummary {
  payload: Record<string, unknown>;
  responseBody: string | null;
}

export interface DeliveryAttemptResult {
  ok: boolean;
  status: DeliveryStatus;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
}

export interface WebhookInput {
  name: string;
  url: string;
  events: string[];
}

const base = '/outgoing-webhooks';

export function fetchOutgoingWebhooks(guildId = authStore.selectedGuildId) {
  return dashboardRequest<OutgoingWebhookOverview>(base, { guildId, errorContext: 'API Error (Outgoing webhooks):' });
}

export function createOutgoingWebhook(input: WebhookInput, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ webhook: OutgoingWebhook; secret: string }>(base, { method: 'POST', payload: input, guildId, errorContext: 'API Error (Create webhook):' });
}

export function updateOutgoingWebhook(id: string, patch: Partial<WebhookInput> & { enabled?: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ webhook: OutgoingWebhook }>(`${base}/${id}`, { method: 'PATCH', payload: patch, guildId, errorContext: 'API Error (Update webhook):' });
}

export function deleteOutgoingWebhook(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ ok: boolean }>(`${base}/${id}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete webhook):' });
}

export function revealOutgoingWebhookSecret(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ secret: string }>(`${base}/${id}/secret`, { guildId, errorContext: 'API Error (Webhook secret):' });
}

export function rotateOutgoingWebhookSecret(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ secret: string }>(`${base}/${id}/rotate-secret`, { method: 'POST', guildId, errorContext: 'API Error (Rotate secret):' });
}

export function testOutgoingWebhook(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ result: DeliveryAttemptResult | null }>(`${base}/${id}/test`, { method: 'POST', guildId, errorContext: 'API Error (Test webhook):' });
}

export function fetchWebhookDeliveries(
  id: string,
  filters: { status?: DeliveryStatus | null; event?: string | null; cursor?: string | null } = {},
  guildId = authStore.selectedGuildId,
) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.event) params.set('event', filters.event);
  if (filters.cursor) params.set('cursor', filters.cursor);
  const query = params.toString();
  return dashboardRequest<{ deliveries: DeliverySummary[]; nextCursor: string | null }>(
    `${base}/${id}/deliveries${query ? `?${query}` : ''}`,
    { guildId, errorContext: 'API Error (Webhook deliveries):' },
  );
}

export function fetchWebhookDelivery(id: string, deliveryId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ delivery: DeliveryDetail }>(`${base}/${id}/deliveries/${deliveryId}`, { guildId, errorContext: 'API Error (Webhook delivery):' });
}

export function redeliverWebhookDelivery(id: string, deliveryId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ result: DeliveryAttemptResult | null }>(`${base}/${id}/deliveries/${deliveryId}/redeliver`, { method: 'POST', guildId, errorContext: 'API Error (Redeliver):' });
}

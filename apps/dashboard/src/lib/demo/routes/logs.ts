/**
 * Routes de démo pour les configurations d'événements de logs.
 *
 * Les types viennent du catalogue partagé, comme côté bot : la démo affiche
 * donc exactement la page réelle, sans liste à tenir à jour ici.
 */
import { LOG_EVENT_TYPES, isLogEventType } from '@kotbo/shared';
import { route } from '../backend';
import { demoDb } from '../db';

/** Quelques choix déjà faits, pour que la page de démo montre ce qu'elle sait faire. */
const DEMO_OFF = new Set(['voice_join', 'voice_leave', 'message_edit']);
const DEMO_DEDICATED: Record<string, string> = {
  moderation_ban: '900000000000000318',
  moderation_kick: '900000000000000318',
};

function logEventConfigsSeed() {
  return LOG_EVENT_TYPES.map((eventType) => ({
    eventType,
    enabled: !DEMO_OFF.has(eventType),
    channelId: DEMO_DEDICATED[eventType] ?? null,
  }));
}

export function registerLogsRoutes(): void {
  // GET /api/dashboard/guilds/:id/logs/event-configs
  route('GET', '/api/dashboard/guilds/:id/logs/event-configs', () => {
    const configs = demoDb.get('log-event-configs-v2', logEventConfigsSeed);
    return { configs, moduleChannels: {} };
  });

  // PUT /api/dashboard/guilds/:id/logs/event-configs
  route('PUT', '/api/dashboard/guilds/:id/logs/event-configs', ({ body }) => {
    const incoming = Array.isArray(body?.configs) ? body.configs : [];
    const configs = incoming.filter((cfg: { eventType?: unknown }) => isLogEventType(cfg?.eventType));
    demoDb.set('log-event-configs-v2', configs);
    return { ok: true, changed: configs.length };
  });

  // POST /api/dashboard/guilds/:id/logs/event-configs/:eventType/test
  route('POST', '/api/dashboard/guilds/:id/logs/event-configs/:eventType/test', () => {
    return { ok: true, channelId: '900000000000000319' };
  });
}

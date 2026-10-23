/**
 * Routes de démo pour les configurations d'événements de logs.
 */
import { route } from '../backend';
import { demoDb } from '../db';

const EVENT_TYPES = [
  'MEMBER_JOIN',
  'MEMBER_LEAVE',
  'MEMBER_UPDATE',
  'MEMBER_ROLE_UPDATE',
  'MESSAGE_DELETE',
  'MESSAGE_EDIT',
  'VOICE_JOIN',
  'VOICE_LEAVE',
  'VOICE_PANEL',
  'ROLE_CREATE',
  'ROLE_DELETE',
  'CHANNEL_CREATE',
  'CHANNEL_DELETE',
  'SANCTION_CREATE',
  'SANCTION_DELETE',
];

function logEventConfigsSeed() {
  return EVENT_TYPES.map((eventType) => ({
    eventType,
    enabled: true,
    channelId: '900000000000000319',
    embedColor: '#5865f2',
  }));
}

export function registerLogsRoutes(): void {
  // GET /api/dashboard/guilds/:id/logs/event-configs
  route('GET', '/api/dashboard/guilds/:id/logs/event-configs', () => {
    const configs = demoDb.get('log-event-configs', logEventConfigsSeed);
    return { configs };
  });

  // PUT /api/dashboard/guilds/:id/logs/event-configs
  route('PUT', '/api/dashboard/guilds/:id/logs/event-configs', ({ body }) => {
    const newConfigs = body?.configs ?? [];
    demoDb.set('log-event-configs', newConfigs);
    return { configs: newConfigs };
  });
}

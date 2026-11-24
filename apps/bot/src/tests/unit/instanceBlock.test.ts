/**
 * Une instance sans bail valide, ou bannie, ne coupait que ses commandes : le
 * dashboard, les fonctions automatiques et les tâches planifiées tournaient
 * encore. Ces règles disent ce qui reste ouvert une fois l'instance bloquée.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Events } from 'discord.js';
import {
  instanceBlockReason,
  isInstanceBlocked,
  isJobAllowedWhileBlocked,
  isPathAllowedWhileBlocked,
  shouldDeliverEvent,
} from '../../services/system/instanceBlock.js';

afterEach(() => {
  global.KOTBO_INSTANCE_BANNED = null;
});

describe("état de blocage de l'instance", () => {
  test('suit le drapeau posé par le ping', () => {
    global.KOTBO_INSTANCE_BANNED = null;
    expect(isInstanceBlocked()).toBe(false);
    global.KOTBO_INSTANCE_BANNED = { mode: 'DISABLE_FEATURES', reason: 'Bail expiré' };
    expect(isInstanceBlocked()).toBe(true);
    expect(instanceBlockReason()).toBe('Bail expiré');
  });
});

describe('tâches planifiées sous blocage', () => {
  test("le ping continue, sinon l'instance ne retrouverait jamais son bail", () => {
    expect(isJobAllowedWhileBlocked('stats-ping')).toBe(true);
  });

  test('les purges continuent : la conservation limitée ne dépend pas du bail', () => {
    for (const job of ['data-retention', 'message-logs-prune', 'wellbeing-cases-prune']) {
      expect(isJobAllowedWhileBlocked(job)).toBe(true);
    }
  });

  test('les fonctionnalités s arrêtent', () => {
    for (const job of ['giveaways-expiration', 'wellbeing-reminders', 'youtube', 'digest']) {
      expect(isJobAllowedWhileBlocked(job)).toBe(false);
    }
  });
});

describe("routes de l'API sous blocage", () => {
  test('la connexion et la liste des serveurs restent ouvertes, pour afficher le motif', () => {
    for (const path of ['/health', '/health/db', '/api/auth/session', '/api/auth/discord/callback', '/api/user/me', '/api/user/guilds', '/api/user/servers']) {
      expect(isPathAllowedWhileBlocked(path)).toBe(true);
    }
  });

  test('dashboard, MCP, API REST, pages publiques et administration sont fermés', () => {
    for (const path of [
      '/api/dashboard/guilds/100000000000000001/wellbeing/cases',
      '/api/mcp/100000000000000001',
      '/api/v1/100000000000000001/get_tickets',
      '/api/public/shop/100000000000000001',
      '/api/admin/instances',
      '/api/user/me/tickets',
      '/api/user/rank-card',
    ]) {
      expect(isPathAllowedWhileBlocked(path)).toBe(false);
    }
  });
});

describe('événements Discord sous blocage', () => {
  test('seules les interactions passent, pour recevoir le message de blocage', () => {
    expect(shouldDeliverEvent(Events.InteractionCreate, true)).toBe(true);
    expect(shouldDeliverEvent(Events.MessageCreate, true)).toBe(false);
    expect(shouldDeliverEvent(Events.GuildMemberAdd, true)).toBe(false);
    expect(shouldDeliverEvent(Events.MessageCreate, false)).toBe(true);
  });
});

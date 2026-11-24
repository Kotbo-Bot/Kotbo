import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { LOG_EVENT_CATEGORIES, LOG_EVENTS, LOG_EVENT_TYPES, isLogEventType, routeLogEvent } from '@kotbo/shared';
import { completeModuleMock } from '../helpers/moduleMock.js';

/**
 * Routage des journaux par type : publié ou non, et où.
 *
 * Le catalogue partagé est la seule liste des types ; ces tests vérifient que
 * le bot s'en sert vraiment (aucun type mort, aucun envoi hors catalogue) et
 * que l'ordre de priorité des salons est celui que le dashboard affiche.
 */

const GUILD = '100000000000000000';
const DEFAULT = '200000000000000000';
const OVERRIDE = '300000000000000000';
const MODULE = '400000000000000000';
const FALLBACK = '500000000000000000';

let row: { enabled: boolean; channelId: string | null } | null = null;
let guildLogChannelId: string | null = DEFAULT;

const prismaMock = {
  guildLogEventConfig: { findUnique: mock(async () => row) },
  guild: { findUnique: mock(async () => null) },
};

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/cache.ts'), {
    getCachedGuild: mock(async () => ({ logChannelId: guildLogChannelId, logIgnoredChannelIds: [] })),
    // Pas de cache : chaque appel relit `row`, ce qui laisse chaque test fixer la sienne.
    cache: { get: mock(async () => null), set: mock(async () => undefined) },
  })],
];
for (const [relatif, fabrique] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}

const { resolveEventLogChannel, resolveEventLogChannelId } = await import('../../utils/logDispatch.js');
const { resetLogChannelBackoff } = await import('../../utils/logChannel.js');

function sendable(id: string) {
  return { id, isSendable: () => true, send: mock(async () => ({ id: 'm' })) };
}

function guildWith(...channelIds: string[]) {
  const cache = new Map(channelIds.map((id) => [id, sendable(id)]));
  return { id: GUILD, channels: { cache, fetch: mock(async (id: string) => cache.get(id) ?? null) } } as never;
}

beforeEach(() => {
  row = null;
  guildLogChannelId = DEFAULT;
  resetLogChannelBackoff();
});

describe('routeLogEvent', () => {
  test('un type coupé ne part nulle part, même avec des salons partout', () => {
    expect(routeLogEvent({ enabled: false, moduleChannelId: MODULE, eventChannelId: OVERRIDE, guildLogChannelId: DEFAULT, fallbackChannelId: FALLBACK })).toBeNull();
  });

  test('module, puis type, puis serveur, puis dernier recours', () => {
    expect(routeLogEvent({ enabled: true, moduleChannelId: MODULE, eventChannelId: OVERRIDE, guildLogChannelId: DEFAULT })).toBe(MODULE);
    expect(routeLogEvent({ enabled: true, eventChannelId: OVERRIDE, guildLogChannelId: DEFAULT })).toBe(OVERRIDE);
    expect(routeLogEvent({ enabled: true, eventChannelId: null, guildLogChannelId: DEFAULT, fallbackChannelId: FALLBACK })).toBe(DEFAULT);
    expect(routeLogEvent({ enabled: true, eventChannelId: null, guildLogChannelId: null, fallbackChannelId: FALLBACK })).toBe(FALLBACK);
    expect(routeLogEvent({ enabled: true, eventChannelId: null, guildLogChannelId: null })).toBeNull();
  });
});

describe('catalogue', () => {
  test('types uniques, et chaque catégorie a au moins un type', () => {
    expect(new Set(LOG_EVENT_TYPES).size).toBe(LOG_EVENT_TYPES.length);
    for (const category of LOG_EVENT_CATEGORIES) {
      expect(LOG_EVENTS.some((event) => event.category === category)).toBe(true);
    }
    expect(isLogEventType('message_delete')).toBe(true);
    expect(isLogEventType('MESSAGE_DELETE')).toBe(false);
    expect(isLogEventType(42)).toBe(false);
  });

  test('chaque type du catalogue est réellement envoyé par le bot', () => {
    // Un type présent dans le catalogue mais jamais routé afficherait dans le
    // dashboard un interrupteur qui ne coupe rien.
    const src = path.resolve(import.meta.dir, '../..');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === 'tests' || name === 'node_modules') continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) sources.push(readFileSync(full, 'utf8'));
      }
    };
    walk(src);
    const corpus = sources.join('\n');
    const call = /(?:sendLogEmbed|resolveEventLogChannel|resolveEventLogChannelId|isLogEventEnabled)\([^;]*?'([a-z_]+)'/gs;
    const used = new Set([...corpus.matchAll(call)].map((match) => match[1]));
    const unused = LOG_EVENT_TYPES.filter((type) => !used.has(type));
    expect(unused).toEqual([]);
  });
});

describe('resolveEventLogChannelId', () => {
  test('sans ligne en base : publié dans le salon de logs du serveur', async () => {
    expect(await resolveEventLogChannelId(GUILD, 'automod_spam')).toBe(DEFAULT);
  });

  test('type coupé : rien, même si le module a son salon', async () => {
    row = { enabled: false, channelId: OVERRIDE };
    expect(await resolveEventLogChannelId(GUILD, 'automod_spam', { moduleChannelId: MODULE })).toBeNull();
  });

  test('le salon choisi pour le type remplace le salon par défaut', async () => {
    row = { enabled: true, channelId: OVERRIDE };
    expect(await resolveEventLogChannelId(GUILD, 'security_honeypot')).toBe(OVERRIDE);
  });

  test('le salon du module passe avant celui du type', async () => {
    row = { enabled: true, channelId: OVERRIDE };
    expect(await resolveEventLogChannelId(GUILD, 'automod_spam', { moduleChannelId: MODULE })).toBe(MODULE);
  });

  test('dernier recours quand le serveur n’a pas de salon de logs', async () => {
    guildLogChannelId = null;
    expect(await resolveEventLogChannelId(GUILD, 'security_ban_hygiene', { fallbackChannelId: FALLBACK })).toBe(FALLBACK);
  });
});

describe('resolveEventLogChannel', () => {
  test('salon du module introuvable : on retombe sur le routage normal', async () => {
    row = { enabled: true, channelId: OVERRIDE };
    const channel = await resolveEventLogChannel(guildWith(OVERRIDE, DEFAULT), 'vision_blocked', 'Test', { moduleChannelId: MODULE });
    expect((channel as { id: string } | null)?.id).toBe(OVERRIDE);
  });

  test('salon du module utilisable : c’est lui', async () => {
    const channel = await resolveEventLogChannel(guildWith(MODULE, DEFAULT), 'vision_blocked', 'Test', { moduleChannelId: MODULE });
    expect((channel as { id: string } | null)?.id).toBe(MODULE);
  });

  test('type coupé : aucun salon, sans même regarder celui du module', async () => {
    row = { enabled: false, channelId: null };
    expect(await resolveEventLogChannel(guildWith(MODULE, DEFAULT), 'vision_blocked', 'Test', { moduleChannelId: MODULE })).toBeNull();
  });
});

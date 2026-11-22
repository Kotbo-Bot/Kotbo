import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import type { Client } from 'discord.js';
import {
  buildBotListRequests,
  collectBotListStats,
  syncBotListStats,
} from '../../services/integrations/botListStatsService';
import { resetCurrentInstance, setCurrentInstance } from '../../utils/instanceContext';

function makeClient(options: {
  botId?: string | null;
  guildCount?: number;
  shardIds?: number[];
  shardCount?: number;
  shardGuilds?: number[];
} = {}): Client {
  const {
    botId = '1481651387317354598',
    guildCount = 42,
    shardIds,
    shardCount,
    shardGuilds,
  } = options;

  return {
    user: botId ? { id: botId } : null,
    guilds: { cache: { size: guildCount } },
    shard: shardIds
      ? {
          ids: shardIds,
          count: shardCount ?? shardGuilds?.length ?? shardIds.length,
          fetchClientValues: mock(() => Promise.resolve(shardGuilds ?? [guildCount])),
        }
      : null,
  } as unknown as Client;
}

describe('buildBotListRequests', () => {
  test('retourne une liste vide si aucun token n est configure', () => {
    const reqs = buildBotListRequests({ botId: '123', serverCount: 10 }, {});
    expect(reqs).toEqual([]);
  });

  test('construit les requetes Botillon, Top.gg v1 et Discordium', () => {
    const reqs = buildBotListRequests(
      { botId: '123456', serverCount: 250, shardCount: 2 },
      {
        BOTILLON_API_TOKEN: 'blp_test',
        TOPGG_API_TOKEN: 'topgg_test',
        DISCORDIUM_API_TOKEN: 'disc_test',
      },
    );

    expect(reqs).toEqual([
      {
        provider: 'botillon',
        url: 'https://botillon.fr/api/v1/me/runtime/stats',
        method: 'POST',
        headers: {
          Authorization: 'Bearer blp_test',
          'Content-Type': 'application/json',
          'User-Agent': 'BotillonSDK/javascript/1.0',
          'X-Botillon-SDK': 'javascript/1.0',
        },
        body: { serverCount: 250, shardCount: 2 },
      },
      {
        provider: 'topgg',
        url: 'https://top.gg/api/v1/projects/@me/metrics',
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer topgg_test',
          'Content-Type': 'application/json',
        },
        body: { server_count: 250, shard_count: 2 },
      },
      {
        provider: 'discordium',
        url: 'https://api.discordium.org/api/v1/bots/123456/stats',
        method: 'POST',
        headers: {
          Authorization: 'Bearer disc_test',
          'Content-Type': 'application/json',
        },
        body: { serverCount: 250, shardCount: 2 },
      },
    ]);
  });

  test('supporte Top.gg v0 quand TOPGG_API_VERSION=v0', () => {
    const reqs = buildBotListRequests(
      { botId: '123456', serverCount: 99 },
      { TOPGG_API_TOKEN: 'legacy_tok', TOPGG_API_VERSION: 'v0' },
    );

    expect(reqs).toEqual([
      {
        provider: 'topgg',
        url: 'https://top.gg/api/bots/123456/stats',
        method: 'POST',
        headers: {
          Authorization: 'legacy_tok',
          'Content-Type': 'application/json',
        },
        body: { server_count: 99 },
      },
    ]);
  });
});

describe('collectBotListStats', () => {
  afterEach(() => {
    resetCurrentInstance();
  });

  test('ignore les instances marque blanche', async () => {
    setCurrentInstance({
      id: 'wl-1',
      slug: 'wl',
      name: 'WL',
      isDefault: false,
    } as Parameters<typeof setCurrentInstance>[0]);

    const stats = await collectBotListStats(makeClient({ guildCount: 5 }));
    expect(stats).toBeNull();
  });

  test('ignore les shards autres que le shard 0', async () => {
    const stats = await collectBotListStats(makeClient({ shardIds: [1], shardCount: 2 }));
    expect(stats).toBeNull();
  });

  test('agrege les serveurs de tous les shards depuis le shard 0', async () => {
    const stats = await collectBotListStats(
      makeClient({ shardIds: [0], shardCount: 3, shardGuilds: [10, 20, 30] }),
    );
    expect(stats).toEqual({
      botId: '1481651387317354598',
      serverCount: 60,
      shardCount: 3,
    });
  });
});

describe('syncBotListStats', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetCurrentInstance();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCurrentInstance();
  });

  test('n envoie rien si aucun token n est defini', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('ok', { status: 200 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await syncBotListStats(makeClient(), {});
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('isole les erreurs d un fournisseur sans bloquer les autres', async () => {
    const fetchMock = mock((url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('top.gg')) {
        return Promise.resolve(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
      }
      if (href.includes('discordium')) {
        return Promise.reject(new Error('network timeout'));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await syncBotListStats(makeClient({ guildCount: 150 }), {
      BOTILLON_API_TOKEN: 'blp_123',
      TOPGG_API_TOKEN: 'topgg_123',
      DISCORDIUM_API_TOKEN: 'disc_123',
    });

    expect(results).toEqual([
      { provider: 'botillon', ok: true, status: 200 },
      { provider: 'topgg', ok: false, status: 401, error: 'Unauthorized' },
      { provider: 'discordium', ok: false, error: 'network timeout' },
    ]);
  });
});

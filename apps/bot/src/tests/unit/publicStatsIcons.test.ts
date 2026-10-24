import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Client } from 'discord.js';

const FEATURED = '506029988680695818';
const featuredRows = [
  { guildId: FEATURED, iconUrl: `https://cdn.discordapp.com/icons/${FEATURED}/6fbbb2b172d8677d849cee9c80485cf8.webp?size=128` },
];
const db = {
  featuredGuild: {
    findUnique: async ({ where }: { where: { guildId: string } }) =>
      featuredRows.find((row) => row.guildId === where.guildId) ?? null,
  },
};
mock.module('../../utils/db.js', () => ({ default: db, prisma: db, prismaRead: db }));

const { createPublicStatsRouter } = await import('../../api/hono/routes/public/stats.js');

// Aucun serveur en cache : la route retombe sur les icônes de repli, ce qui
// garde le test hors-ligne une fois `fetch` remplacé.
const emptyClient = { guilds: { cache: new Map() } } as unknown as Client;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('GET /api/public/stats/icons/:guildId', () => {
  test('refuse un serveur qui n\'est pas mis en avant : pas de proxy ouvert', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('');
    }) as unknown as typeof fetch;

    const res = await createPublicStatsRouter(emptyClient).request('/api/public/stats/icons/123456789012345678');
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  test('relaie l\'icône depuis le CDN de Discord, servie par l\'API', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } });
    }) as unknown as typeof fetch;

    const res = await createPublicStatsRouter(emptyClient).request(`/api/public/stats/icons/${FEATURED}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]).toStartWith(`https://cdn.discordapp.com/icons/${FEATURED}/`);
  });
});

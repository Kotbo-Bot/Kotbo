import { describe, expect, mock, test } from 'bun:test';
import type { Client } from 'discord.js';

const upserts: Array<{ where: { guildId: string }; update: Record<string, unknown> }> = [];
const deletes: unknown[] = [];
const db = {
  featuredGuild: {
    upsert: async (args: (typeof upserts)[number]) => { upserts.push(args); },
    deleteMany: async (args: unknown) => { deletes.push(args); return { count: 0 }; },
  },
};
mock.module('../../utils/db.js', () => ({ default: db, prisma: db, prismaRead: db }));

const { syncFeaturedGuilds } = await import('../../services/system/featuredGuildsService.js');

const guild = (id: string, memberCount: number, description: string | null = null) => ({
  id, name: `Serveur ${id}`, memberCount, description, iconURL: () => null,
});

describe('syncFeaturedGuilds', () => {
  test('garde les 1000+, retire les autres et les lignes expirées', async () => {
    const cache = new Map([
      ['1', guild('1', 1000, 'Une description')],
      ['2', guild('2', 999)],
      ['3', guild('3', 5000)],
    ]);
    const now = new Date('2026-10-25T12:00:00Z');
    await syncFeaturedGuilds({ guilds: { cache } } as unknown as Client, now);

    expect(upserts.map((u) => u.where.guildId)).toEqual(['1', '3']);
    expect(upserts[0].update.description).toBe('Une description');
    // Pas de description sur Discord : celle en base n'est pas écrasée.
    expect('description' in upserts[1].update).toBe(false);
    expect(deletes[0]).toEqual({
      where: {
        OR: [
          { guildId: { in: ['2'] } },
          { lastSeenAt: { lt: new Date('2026-10-25T06:00:00Z') } },
        ],
      },
    });
  });
});

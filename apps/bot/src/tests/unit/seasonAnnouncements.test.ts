import { describe, expect, test, mock } from 'bun:test';
import type { Client } from 'discord.js';
import path from 'node:path';

const mockDb = { guild: { findUnique: mock(async () => null) } };
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { seasonStartDescription, seasonEndDescription, announceSeasonEnd } = await import('../../services/progression/seasonAnnouncements.js');

const ROLE = '123456789012345678';
const season = { guildId: 'g', number: 2, name: 'Hiver', endDate: new Date('2026-12-01T00:00:00Z'), announceChannelId: 'c' };

describe('seasonStartDescription', () => {
  test('donne la date de fin en horodatage Discord', () => {
    expect(seasonStartDescription(season, [], null, 'fr')).toContain('<t:1796083200:D>');
  });

  test('liste le rôle du premier et les récompenses par rang', () => {
    const text = seasonStartDescription(season, [{ rank: 1, roleId: ROLE, coins: 500 }, { rank: 2, roleId: null, coins: 100 }], ROLE, 'fr');
    expect(text).toContain(`<@&${ROLE}>`);
    expect(text).toContain('#1');
    expect(text).toContain('#2');
  });

  test('sans récompense, pas de section récompenses', () => {
    expect(seasonStartDescription(season, [], null, 'en').split('\n')).toHaveLength(1);
  });
});

describe('seasonEndDescription', () => {
  const standings = [
    { userId: 'a', rank: 1, xp: 900 },
    { userId: 'b', rank: 2, xp: 400 },
    { userId: 'c', rank: 3, xp: 300 },
    { userId: 'd', rank: 4, xp: 100 },
  ];

  test('montre le podium, pas au-delà', () => {
    const text = seasonEndDescription(standings, [], 'en');
    expect(text).toContain('<@a>');
    expect(text).toContain('<@c>');
    expect(text).not.toContain('<@d>');
  });

  test('liste les récompenses données à qui', () => {
    const text = seasonEndDescription(standings, [{ userId: 'a', rank: 1, roleId: ROLE, coins: 0 }], 'en');
    expect(text).toContain(`<@a> · <@&${ROLE}>`);
  });

  test('saison sans classé : message dédié', () => {
    expect(seasonEndDescription([], [], 'en')).not.toContain('<@');
  });
});

describe('announceSeasonEnd', () => {
  /** Client dont le serveur n'est pas en cache : le salon est lu par l'API. */
  function clientWith(channelGuildId: string) {
    const send = mock(async (..._args: unknown[]) => ({}));
    const channel = { guildId: channelGuildId, isTextBased: () => true, isSendable: () => true, send };
    const client = {
      guilds: { cache: new Map() },
      channels: { fetch: mock(async () => channel) },
    } as unknown as Client;
    return { client, send };
  }

  test('lit le salon par l\'API quand le serveur n\'est pas en cache', async () => {
    const { client, send } = clientWith('g');
    await announceSeasonEnd(client, season, [], []);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('n\'écrit pas dans le salon d\'un autre serveur', async () => {
    const { client, send } = clientWith('autre');
    await announceSeasonEnd(client, season, [], []);
    expect(send).not.toHaveBeenCalled();
  });

  test('sans salon réglé, rien n\'est lu ni envoyé', async () => {
    const { client, send } = clientWith('g');
    await announceSeasonEnd(client, { ...season, announceChannelId: null }, [], []);
    expect(send).not.toHaveBeenCalled();
  });
});

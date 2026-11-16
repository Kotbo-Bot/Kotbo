import { describe, expect, test, mock } from 'bun:test';
import type { Client } from 'discord.js';
import path from 'node:path';

const mockDb = { guild: { findUnique: mock(async () => null) } };
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { seasonStartText, seasonEndText, seasonReminderText, announceSeasonEnd, seasonAnnouncementLabels } = await import('../../services/progression/seasonAnnouncements.js');

const ROLE = '123456789012345678';
const season = { guildId: 'g', number: 2, name: 'Hiver', endDate: new Date('2026-12-01T00:00:00Z'), announceChannelId: 'c' };

describe('seasonStartText', () => {
  test('donne la date de fin en horodatage Discord', () => {
    expect(seasonStartText(season, [], null, 'fr').description).toContain('<t:1796083200:D>');
  });

  test('liste le rôle du premier et les récompenses par rang', () => {
    const text = seasonStartText(season, [{ rank: 1, roleId: ROLE, coins: 500 }, { rank: 2, roleId: null, coins: 100 }], ROLE, 'fr').description;
    expect(text).toContain(`<@&${ROLE}>`);
    expect(text).toContain('#1');
    expect(text).toContain('#2');
  });

  test('sans récompense, pas de section récompenses', () => {
    expect(seasonStartText(season, [], null, 'en').description.split('\n')).toHaveLength(1);
  });
});

describe('seasonEndText', () => {
  const standings = [
    { userId: 'a', rank: 1, xp: 900 },
    { userId: 'b', rank: 2, xp: 400 },
    { userId: 'c', rank: 3, xp: 300 },
    { userId: 'd', rank: 4, xp: 100 },
  ];

  test('montre le podium, pas au-delà', () => {
    const text = seasonEndText(season, standings, [], 'en').description;
    expect(text).toContain('<@a>');
    expect(text).toContain('<@c>');
    expect(text).not.toContain('<@d>');
  });

  test('liste les récompenses données à qui', () => {
    const text = seasonEndText(season, standings, [{ userId: 'a', rank: 1, roleId: ROLE, coins: 0 }], 'en').description;
    expect(text).toContain(`<@a> · <@&${ROLE}>`);
  });

  test('saison sans classé : message dédié', () => {
    expect(seasonEndText(season, [], [], 'en').description).not.toContain('<@');
  });
});

describe('paliers', () => {
  test('l\'ouverture mentionne le rôle du palier', () => {
    const text = seasonStartText(season, [], null, 'fr', [{ minXp: 1000, roleId: ROLE, coins: 0 }]).description;
    expect(text).toContain(`<@&${ROLE}>`);
  });

  test('la clôture compte les membres de chaque palier', () => {
    const text = seasonEndText(season, [{ userId: 'a', rank: 1, xp: 9 }], [], 'en', [{ minXp: 1000, count: 12 }]).description;
    expect(text).toContain('12');
  });
});

describe('seasonReminderText', () => {
  test('date de fin relative et podium provisoire en mentions', () => {
    const text = seasonReminderText(season, [{ userId: 'a', rank: 1, xp: 900 }], 'fr');
    expect(text.title).toContain('Hiver');
    expect(text.description).toContain('<t:1796083200:R>');
    expect(text.description).toContain('<@a>');
  });
});

describe('seasonAnnouncementLabels', () => {
  test('rend des gabarits à trous, sans valeur réelle', () => {
    const labels = seasonAnnouncementLabels('fr');
    expect(labels.startTitle).toContain('{number}');
    expect(labels.startTitle).toContain('{name}');
    expect(labels.endLine).toContain('{user}');
    expect(labels.reminderTitle).toContain('{name}');
    expect(labels.reminderBody).toContain('{date}');
    expect(labels.tierLine).toContain('{reward}');
    expect(labels.tierReachedLine).toContain('{count}');
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

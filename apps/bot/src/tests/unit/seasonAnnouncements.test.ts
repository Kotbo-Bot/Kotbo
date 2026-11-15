import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';

const mockDb = { guild: { findUnique: mock(async () => null) } };
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { seasonStartDescription, seasonEndDescription } = await import('../../services/progression/seasonAnnouncements.js');

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

/**
 * Lecture des classements MEE6 et DraftBot. Les deux formats ne sont pas
 * documentés : ces cas figent ce qu'on en lit, relevé sur leurs réponses.
 */
import { describe, expect, test } from 'bun:test';
import {
  isLevelImportSource,
  isValidImportApiKey,
  parseDraftbotPage,
  parseLurkrPage,
  parseMee6Page,
  parseTatsuPage,
} from '../../services/progression/levelImportSources.js';

describe('parseMee6Page', () => {
  test('lit niveau et avancement dans le palier', () => {
    const rows = parseMee6Page({
      players: [{ id: '441302111817433088', level: 12, xp: 9000, detailed_xp: [250, 1000, 9000] }],
      role_rewards: [],
    });
    expect(rows).toEqual([{ userId: '441302111817433088', level: 12, progress: 0.25 }]);
  });

  test('écarte les lignes douteuses', () => {
    const rows = parseMee6Page({
      players: [
        { id: 'pas-un-id', level: 3, detailed_xp: [0, 10, 0] },
        { id: '441302111817433088', level: -1, detailed_xp: [0, 10, 0] },
        { id: '441302111817433089', level: 2 },
      ],
    });
    expect(rows).toEqual([{ userId: '441302111817433089', level: 2, progress: 0 }]);
  });

  test('un format inattendu lève une erreur lisible', () => {
    expect(() => parseMee6Page({ error: 'x' })).toThrow('MEE6');
  });
});

describe('parseDraftbotPage', () => {
  test('lit les XP en chaînes et le nombre de pages', () => {
    const { entries, pages } = parseDraftbotPage({
      users: [{ id: '441302111817433088', level: 132, currentLevelXp: '7680', levelXp: '93820', totalXp: '4243010' }],
      page: 0,
      total: 162,
    });
    expect(pages).toBe(162);
    // Les pages suivantes n'ont pas de total.
    expect(parseDraftbotPage({ users: [], page: 1 }).pages).toBeNull();
    expect(entries[0].userId).toBe('441302111817433088');
    expect(entries[0].level).toBe(132);
    expect(entries[0].progress).toBeCloseTo(7680 / 93820);
  });

  test('un format inattendu lève une erreur lisible', () => {
    expect(() => parseDraftbotPage(null)).toThrow('DraftBot');
  });
});

describe('parseLurkrPage', () => {
  test('progress en pourcentage, entrées anonymes écartées', () => {
    const rows = parseLurkrPage({
      levels: [
        { userId: '441302111817433088', level: 20, progress: 40, xp: 12000, nextLevelXp: 500, rank: 1 },
        { userId: 'anonymous:2', level: 18, progress: 10, xp: 9000, nextLevelXp: 400, rank: 2 },
      ],
    });
    expect(rows).toEqual([{ userId: '441302111817433088', level: 20, progress: 0.4 }]);
  });

  test('un format inattendu lève une erreur lisible', () => {
    expect(() => parseLurkrPage({ message: 'Guild not found' })).toThrow('Lurkr');
  });
});

describe('parseTatsuPage', () => {
  test('le score devient l\'XP, sans niveau', () => {
    const rows = parseTatsuPage({
      guild_id: '173184118492889089',
      rankings: [
        { rank: 1, score: 15234.6, user_id: '441302111817433088' },
        { rank: 2, score: -3, user_id: '441302111817433089' },
      ],
    });
    expect(rows).toEqual([{ userId: '441302111817433088', xp: 15234 }]);
  });
});

test('isValidImportApiKey refuse ce qui casserait l\'en-tête', () => {
  expect(isValidImportApiKey('abcDEF12-3456.7890_xyz')).toBe(true);
  expect(isValidImportApiKey('court')).toBe(false);
  expect(isValidImportApiKey('abcdefgh\r\nX-Evil: 1')).toBe(false);
  expect(isValidImportApiKey(undefined)).toBe(false);
});

test('isLevelImportSource', () => {
  expect(isLevelImportSource('mee6')).toBe(true);
  expect(isLevelImportSource('draftbot')).toBe(true);
  expect(isLevelImportSource('lurkr')).toBe(true);
  expect(isLevelImportSource('tatsu')).toBe(true);
  expect(isLevelImportSource('amari')).toBe(false);
});

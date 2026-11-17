import { describe, test, expect } from 'bun:test';
import { FUN_GAMES, activeGameCount, gamesInGroup } from './funGames';

describe('FUN_GAMES', () => {
  test('chaque jeu a son propre salon', () => {
    const keys = FUN_GAMES.map((game) => game.channelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('les jeux se répartissent entre jeux à score et salons à règle', () => {
    expect(gamesInGroup('score').map((game) => game.id)).toEqual(['counting', 'guess', 'wordchain', 'emojiriddle']);
    expect(gamesInGroup('rule').map((game) => game.id)).toEqual(['oneword', 'neversay', 'emojionly', 'imageofday']);
  });

  test('tout jeu à score a un état à montrer', () => {
    expect(gamesInGroup('score').every((game) => game.tracked)).toBe(true);
  });
});

describe('activeGameCount', () => {
  test('compte les jeux dont le salon est choisi', () => {
    expect(activeGameCount({})).toBe(0);
    expect(activeGameCount({ funCountingChannelId: '1', funNeverSayChannelId: '2', funWordChainChannelId: null })).toBe(2);
  });

  test('ignore les salons qui ne sont pas des jeux, comme les confessions', () => {
    expect(activeGameCount({ funConfessionChannelId: '3' } as Record<string, string>)).toBe(0);
  });

  test('un identifiant vide ne compte pas', () => {
    expect(activeGameCount({ funCountingChannelId: '' })).toBe(0);
  });
});

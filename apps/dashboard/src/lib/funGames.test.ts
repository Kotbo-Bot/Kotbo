import { describe, test, expect } from 'bun:test';
import { FUN_GAMES, activeGames } from './funGames';

describe('FUN_GAMES', () => {
  test('chaque jeu a son propre salon', () => {
    const keys = FUN_GAMES.map((game) => game.channelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('activeGames', () => {
  test('garde les jeux dont le salon est choisi, dans l\'ordre de la liste', () => {
    const ids = activeGames({ funNeverSayChannelId: '2', funCountingChannelId: '1' }).map((game) => game.id);
    expect(ids).toEqual(['counting', 'neversay']);
  });

  test('ignore les salons qui ne sont pas des jeux, comme les confessions', () => {
    expect(activeGames({ funConfessionChannelId: '3' } as Record<string, string>)).toEqual([]);
  });

  test('un identifiant vide ne compte pas', () => {
    expect(activeGames({ funCountingChannelId: '', funWordChainChannelId: null })).toEqual([]);
  });
});

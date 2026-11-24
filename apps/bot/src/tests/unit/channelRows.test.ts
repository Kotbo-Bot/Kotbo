import { describe, expect, test } from 'bun:test';
import { mergeChannelRows } from '../../services/analytics/channelRows';

describe('mergeChannelRows', () => {
  test('un salon renommé ne compte qu\'une fois, sous son nom le plus fréquent', () => {
    const rows = [
      { channelId: 'c1', channelName: 'general', count: 40 },
      { channelId: 'c2', channelName: 'memes', count: 30 },
      { channelId: 'c1', channelName: 'ancien-general', count: 5 },
    ];
    expect(mergeChannelRows(rows, 10)).toEqual([
      { channelId: 'c1', channelName: 'general', count: 45 },
      { channelId: 'c2', channelName: 'memes', count: 30 },
    ]);
  });

  test('retrie après fusion et coupe à la limite', () => {
    const rows = [
      { channelId: 'a', channelName: 'a', count: 10 },
      { channelId: 'b', channelName: 'b', count: 8 },
      { channelId: 'b', channelName: 'b2', count: 7 },
    ];
    expect(mergeChannelRows(rows, 1)).toEqual([{ channelId: 'b', channelName: 'b', count: 15 }]);
  });
});

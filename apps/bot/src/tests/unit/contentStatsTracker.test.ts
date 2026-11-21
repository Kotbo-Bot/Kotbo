import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Events } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const queueContentCounters = mock((..._args: unknown[]) => undefined);

const mocks: Array<[string, Record<string, unknown>]> = [
  ['utils/activation', { isGuildActivated: () => true }],
  ['services/analytics/analyticsConsent', { isAnalyticsCollectionEnabled: async () => true }],
  ['services/analytics/contentStatsService', {
    dateKeyOf: () => '2026-11-20',
    queueContentCounters,
    queueContentItem: () => undefined,
    startContentStatsFlusher: () => undefined,
  }],
  ['services/analytics/assetSourceService', { startAssetSourceResolver: () => undefined }],
];
for (const [relatif, overrides] of mocks) {
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `../../${relatif}.${ext}`), () =>
      completeModuleMock(path.resolve(import.meta.dir, `../../${relatif}.ts`), overrides));
  }
}

const { registerContentStatsTracker } = await import('../../events/contentStatsTracker.js');

describe('messages avec réaction', () => {
  test('retirer puis remettre la seule réaction ne recompte pas le message', async () => {
    const client = new EventEmitter();
    registerContentStatsTracker(client as never);
    const message = {
      id: 'message-1',
      guild: { id: 'g1' },
      author: { id: 'auteur', bot: false },
      reactions: { cache: new Map([['👍', { count: 1 }]]) },
    };

    // Le total en cache vaut 1 à chaque ajout : la réaction a été retirée entre-temps.
    for (let i = 0; i < 2; i++) {
      client.emit(Events.MessageReactionAdd, { message, emoji: { id: null, name: '👍' } }, { id: 'membre', bot: false });
      await Bun.sleep(0);
    }

    const comptes = queueContentCounters.mock.calls.filter(([, , , , compteurs]) => (compteurs as { reactedMessages?: number }).reactedMessages);
    expect(comptes).toHaveLength(1);
  });
});

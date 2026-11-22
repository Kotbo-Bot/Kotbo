import { describe, expect, mock, test } from 'bun:test';
import { notifyInteractionFailure } from '../../utils/interactionResponses.js';

describe('notifyInteractionFailure', () => {
  test('une interaction différée qui échoue reçoit quand même le message d’erreur', async () => {
    const differee = { deferred: true, isRepliable: () => true, followUp: mock(async () => undefined) };

    await notifyInteractionFailure(differee as never, '❌ Échec');

    expect(differee.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: '❌ Échec' }));
  });
});

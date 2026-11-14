/**
 * Quiz : passage de question et page web publique.
 *
 * - La question suivante était écrite en base avant l'édition du message Discord :
 *   quand Discord échouait, le quiz avançait quand même, et chaque nouveau clic
 *   sautait une question de plus. Un échec Discord ne doit plus rien écrire.
 * - La page web publique ne doit jamais exposer la bonne réponse de la question en cours.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const questions = [
  { id: 'q1', eventId: 'ev1', text: 'Capitale de la France ?', options: ['Lyon', 'Paris'], correctOptionIndex: 1, status: 'COMPLETED', imageUrl: null, startTime: null },
  { id: 'q2', eventId: 'ev1', text: 'Deux plus deux ?', options: ['3', '5', '4'], correctOptionIndex: 2, status: 'ONGOING', imageUrl: null, startTime: new Date() },
  { id: 'q3', eventId: 'ev1', text: 'Couleur du ciel ?', options: ['Bleu', 'Vert'], correctOptionIndex: 0, status: 'DRAFT', imageUrl: null, startTime: null },
];

let writes: string[] = [];

const mockDb: any = new Proxy({}, {
  get(_target, model: string) {
    if (model === '$transaction') return async (arg: any) => { writes.push('$transaction'); return Promise.all(arg); };
    return new Proxy({}, {
      get(_t, method: string) {
        return async () => {
          const key = `${model}.${method}`;
          if (['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'].includes(method)) {
            writes.push(key);
            return {};
          }
          if (key === 'event.findUnique') {
            return { id: 'ev1', guildId: 'g1', title: 'Quiz', description: null, status: 'ONGOING', channelId: 'c1', messageId: 'm1', questions };
          }
          if (key === 'eventParticipant.findMany') return [{ userId: 'u1', username: 'alice', score: 1 }];
          if (method === 'findMany') return [];
          return null;
        };
      },
    });
  },
});

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { nextQuestion, prevQuestion, getPublicQuizState } = await import('../../services/features/eventService.js');

const clientWithoutChannel: any = { channels: { fetch: async () => null } };

beforeEach(() => {
  writes = [];
});

describe('passage de question', () => {
  test('un salon Discord introuvable ne fait pas avancer le quiz', async () => {
    await expect(nextQuestion(clientWithoutChannel, 'ev1')).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  test('ni reculer', async () => {
    await expect(prevQuestion(clientWithoutChannel, 'ev1')).rejects.toThrow();
    expect(writes).toEqual([]);
  });
});

describe('page web publique', () => {
  test('ne révèle pas la bonne réponse de la question en cours', async () => {
    const state = await getPublicQuizState('ev1', null);
    expect(state?.current?.id).toBe('q2');
    expect(state?.current?.options).toEqual(['3', '5', '4']);
    expect(JSON.stringify(state?.current)).not.toContain('correctOptionIndex');
    expect(state?.current?.myAnswer).toBeNull();
  });

  test('révèle celle de la question précédente', async () => {
    const state = await getPublicQuizState('ev1', null);
    expect(state?.previous).toEqual({ text: 'Capitale de la France ?', answer: 'Paris' });
    expect(state?.leaderboard).toEqual([{ userId: 'u1', name: 'alice', score: 1 }]);
  });
});

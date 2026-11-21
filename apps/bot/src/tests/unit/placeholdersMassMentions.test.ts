import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Guild, Message } from 'discord.js';

/** La mention neutralisée : un espace de largeur nulle après l'arobase. */
const ZWSP = '\u200b';

const rule = { id: 'rule-1', trigger: 'bonjour', matchType: 'CONTAINS', response: '@here {username} ({tag}) a dit bonjour', responseDestination: 'CHANNEL' };
const mockDb = {
  autoResponse: { findMany: async () => [rule] },
};
for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { resolvePlaceholders } = await import('../../utils/placeholders.js');
const { handleAutoResponse } = await import('../../services/features/autoResponseService.js');

describe('gabarits d\'accueil, de départ et de boost', () => {
  test('neutralise @everyone et @here dans le pseudo du membre, pas dans le texte de l\'administrateur', () => {
    const ctx = { guild: {} as Guild, member: { id: '42', displayName: '@everyone gratuit', user: { username: 'salut @here' } } };

    expect(resolvePlaceholders('@everyone accueillez {displayName} ({username})', ctx))
      .toBe(`@everyone accueillez @${ZWSP}everyone gratuit (salut @${ZWSP}here)`);
    expect(resolvePlaceholders('{nom} / {pseudo}', ctx)).toBe(`@${ZWSP}everyone gratuit / salut @${ZWSP}here`);
  });
});

describe('réponses automatiques', () => {
  test('le pseudo et le tag de l\'auteur repris dans la réponse ne notifient personne', async () => {
    const sent: unknown[] = [];
    const message = {
      guildId: 'guild-1',
      content: 'bonjour tout le monde',
      author: { id: 'user-1', bot: false, username: '@everyone' },
      member: { id: 'user-1', displayName: 'vite @here', user: { username: '@everyone' } },
      channel: { isTextBased: () => true, isSendable: () => true },
      reply: async (payload: unknown) => { sent.push(payload); },
    } as unknown as Message;

    await handleAutoResponse(message);

    expect(sent).toEqual([`@here vite @${ZWSP}here (@${ZWSP}everyone) a dit bonjour`]);
  });
});

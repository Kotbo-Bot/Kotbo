import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';

for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: {}, prisma: {}, prismaRead: {}, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { announceTicketClaim } = await import('../../services/features/ticketService.js');

const BOT_ID = 'bot';

function fakeChannel(messages: Array<{ authorId: string; title?: string }>) {
  const edits: unknown[] = [];
  const sends: unknown[] = [];
  const list = messages.map((m) => ({
    author: { id: m.authorId },
    embeds: m.title ? [{ title: m.title }] : [],
    edit: async (payload: unknown) => { edits.push(payload); },
  }));
  const channel = {
    client: { user: { id: BOT_ID } },
    messages: { fetch: async () => ({ find: (fn: (m: unknown) => boolean) => list.find(fn) }) },
    send: async (payload: unknown) => { sends.push(payload); },
  };
  return { channel: channel as never, edits, sends };
}

const claim = () => new EmbedBuilder().setTitle('Pris en charge');

describe('annonce de prise en charge', () => {
  test("remplace l'encart « Ticket verrouillé » au lieu d'en poser un second", async () => {
    const { channel, edits, sends } = fakeChannel([{ authorId: BOT_ID, title: '🔒 Ticket verrouillé' }]);
    await announceTicketClaim(channel, claim(), { mentionUserIds: ['u1'] });
    expect(edits).toHaveLength(1);
    expect(sends).toHaveLength(0);
  });

  test('envoie un message quand il n’y a pas d’encart', async () => {
    const { channel, edits, sends } = fakeChannel([{ authorId: BOT_ID, title: 'Autre chose' }, { authorId: 'u2', title: '🔒 Ticket verrouillé' }]);
    await announceTicketClaim(channel, claim());
    expect(edits).toHaveLength(0);
    expect(sends).toHaveLength(1);
  });

  test('la mention part à part, l’encart modifié ne notifiant personne', async () => {
    const { channel, edits, sends } = fakeChannel([{ authorId: BOT_ID, title: '🔒 Ticket verrouillé' }]);
    await announceTicketClaim(channel, claim(), { content: '<@u1>', mentionUserIds: ['u1'] });
    expect(edits).toHaveLength(1);
    expect(sends).toEqual([{ content: '<@u1>', allowedMentions: { users: ['u1'] } }]);
  });
});

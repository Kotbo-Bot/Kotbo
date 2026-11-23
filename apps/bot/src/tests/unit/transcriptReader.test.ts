import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { APIMessage } from 'discord-api-types/v10';

for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: {}, prisma: {}, prismaRead: {}, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { loadTranscriptMessages, transcriptConversation, transcriptDataOf } = await import('../../services/features/transcriptReader.js');
const { parseLegacyTimestamp } = await import('../../services/features/transcriptService.js');

const apiUser = (id: string, name: string, bot = false) => ({ id, username: name.toLowerCase(), global_name: name, discriminator: '0', avatar: null, ...(bot ? { bot: true } : {}) });

function apiMessage(extra: Partial<APIMessage>): APIMessage {
  return {
    id: '1', channel_id: '9', type: 0, author: apiUser('11', 'Alice'), content: '', timestamp: '2026-11-20T10:00:00.000Z',
    edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [],
    components: [], pinned: false, ...extra,
  } as APIMessage;
}

const data = {
  version: 1 as const,
  guildId: 'g',
  channel: { id: '9', name: 'ticket-alice', topic: null },
  generatedAt: '2026-11-20T11:00:00.000Z',
  entities: { users: { 11: { name: 'Alice (modo)' } } },
  authors: {
    11: { displayName: 'Alice (modo)', avatarUrl: 'https://cdn/alice.png', color: '#ff0000', bot: false, verified: false },
    22: { displayName: 'Kotbo', avatarUrl: 'https://cdn/kotbo.png', bot: true, verified: true },
  },
  messages: [
    apiMessage({
      id: '1',
      content: 'Bonjour <@22>',
      attachments: [
        { id: 'a1', filename: 'photo.png', url: 'https://cdn/photo.png', proxy_url: 'https://media/photo.png', size: 10, content_type: 'image/png' },
        { id: 'a2', filename: 'logs.txt', url: 'https://cdn/logs.txt', proxy_url: 'https://media/logs.txt', size: 10, content_type: 'text/plain' },
      ],
      reactions: [{ emoji: { id: null, name: '👍' }, count: 2, count_details: { burst: 0, normal: 2 }, me: false, me_burst: false, burst_colors: [] }],
    }),
    apiMessage({
      id: '2',
      author: apiUser('22', 'Kotbo', true),
      timestamp: '2026-11-20T10:01:00.000Z',
      flags: 1 << 15,
      embeds: [{ title: 'Ticket', description: 'Décris ton souci', color: 0x5865f2, fields: [{ name: 'Motif', value: 'Aide', inline: true }] }],
      sticker_items: [{ id: 's1', name: 'Coucou', format_type: 4 }],
      components: [
        {
          type: 17,
          accent_color: 0x00ff00,
          components: [
            { type: 9, components: [{ type: 10, content: '### Ticket ouvert' }], accessory: { type: 11, media: { url: 'https://cdn/thumb.png' } } },
            { type: 10, content: 'Un membre du staff arrive.' },
            { type: 12, items: [{ media: { url: 'https://cdn/a.png' } }, { media: { url: 'https://cdn/b.png' } }] },
          ],
        },
        { type: 10, content: 'Texte hors conteneur' },
        { type: 1, components: [{ type: 2, style: 4, label: 'Fermer', custom_id: 'close', emoji: { name: '🔒' } }] },
      ],
    } as Partial<APIMessage>),
  ],
};

const json = { format: 'json', html: null, data };

describe('transcriptDataOf', () => {
  test('ne lit que le JSON v1', () => {
    expect(transcriptDataOf(json)).toBe(data);
    expect(transcriptDataOf({ format: 'html', html: '<div></div>', data: null })).toBeNull();
    expect(transcriptDataOf({ format: 'json', html: null, data: { version: 2, messages: [] } })).toBeNull();
    expect(transcriptDataOf({ format: 'json', html: null, data: null })).toBeNull();
  });
});

describe('loadTranscriptMessages', () => {
  test('JSON : auteurs figés, vraies dates, V2 lus comme embeds, images jointes', () => {
    const [first, second] = loadTranscriptMessages(json);
    expect(first).toEqual({
      avatarUrl: 'https://cdn/alice.png', username: 'Alice (modo)', isBot: false,
      timestamp: '2026-11-20T10:00:00.000Z', createdAt: '2026-11-20T10:00:00.000Z',
      content: 'Bonjour <@22>', embeds: [], imageUrls: ['https://cdn/photo.png'],
    });
    expect(second.username).toBe('Kotbo');
    expect(second.isBot).toBe(true);
    expect(second.content).toBe('Texte hors conteneur');
    expect(second.embeds).toHaveLength(2);
    expect(second.embeds[0]).toMatchObject({ title: 'Ticket', color: '#5865f2', fields: [{ name: 'Motif', value: 'Aide', inline: true }] });
    expect(second.embeds[1]).toMatchObject({
      color: '#00ff00', description: '### Ticket ouvert\n\nUn membre du staff arrive.',
      thumbnailUrl: 'https://cdn/thumb.png', imageUrl: 'https://cdn/a.png',
    });
    expect(second.imageUrls).toEqual(['https://cdn/b.png']);
  });

  test('HTML historique : parseur inchangé, date décodée', () => {
    const html = `<div class="message-group"><img class="avatar" src="https://cdn/a.png"><span class="username" style="color:#fff">Bob</span>
      <span class="timestamp">16 juil. 2022, 09:14</span><div class="message-text">Salut</div></div>`;
    expect(loadTranscriptMessages({ format: 'html', html, data: null })).toEqual([{
      avatarUrl: 'https://cdn/a.png', username: 'Bob', isBot: false, timestamp: '16 juil. 2022, 09:14',
      createdAt: '2022-07-16T09:14:00.000Z', content: 'Salut', embeds: [], imageUrls: [],
    }]);
  });

  test('HTML historique : texte des conteneurs V2 (blocs v2-text) repris en Markdown', () => {
    const html = `<div class="message-group"><img class="avatar" src="https://cdn/bot.png"><span class="username" style="color:#fff">Kotbo</span><span class="bot-tag">BOT</span>
      <span class="timestamp">22 nov. 2026 à 08:42</span>
      <div class="discord-embed" style="border-left-color: #5865f2"><div class="discord-embed-content"><div class="discord-embed-text">
      <div class="v2-text"><span class="v2-heading v2-h3">🎫 Ticket d&#039;Assistance</span></div>
      <div class="v2-text">Bonjour <span class="mention">@Chris</span> !<br/><strong>Description :</strong> aide</div>
      <div class="v2-separator-space"></div><div class="v2-text"><span class="v2-subtext">Ticket ID: abc</span></div>
      </div></div></div></div>`;
    const [message] = loadTranscriptMessages({ format: 'html', html, data: null });
    expect(message.isBot).toBe(true);
    expect(message.createdAt).toBe('2026-11-22T08:42:00.000Z');
    expect(message.embeds[0]).toMatchObject({
      color: '#5865f2',
      description: "### 🎫 Ticket d'Assistance\n\nBonjour @Chris !\n**Description :** aide\n\n-# Ticket ID: abc",
    });
  });

  test('ni JSON lisible ni HTML : aucun message', () => {
    expect(loadTranscriptMessages({ format: 'json', html: null, data: null })).toEqual([]);
  });
});

describe('parseLegacyTimestamp', () => {
  test('les deux séparateurs du format français, en UTC', () => {
    expect(parseLegacyTimestamp('16 juil. 2022, 09:14')).toBe('2022-07-16T09:14:00.000Z');
    expect(parseLegacyTimestamp('3 févr. 2024 à 18:05')).toBe('2024-02-03T18:05:00.000Z');
    expect(parseLegacyTimestamp('5 mai 2023, 07:00')).toBe('2023-05-05T07:00:00.000Z');
    expect(parseLegacyTimestamp('1 déc. 2025, 23:59')).toBe('2025-12-01T23:59:00.000Z');
  });

  test('valeur illisible : null', () => {
    expect(parseLegacyTimestamp('')).toBeNull();
    expect(parseLegacyTimestamp('16 foo. 2022, 09:14')).toBeNull();
    expect(parseLegacyTimestamp('2022-07-16')).toBeNull();
  });
});

describe('transcriptConversation', () => {
  test('JSON : messages bruts, Components V2 intacts, noms et auteurs figés', () => {
    const conversation = transcriptConversation(json, '2026-11-20T12:00:00.000Z');
    expect(conversation.messages).toBe(data.messages);
    expect(conversation.messages[1].components?.[0]).toMatchObject({ type: 17, accent_color: 0x00ff00 });
    expect(conversation.entities).toBe(data.entities);
    expect(conversation.authors).toBe(data.authors);
  });

  test('HTML historique : auteurs synthétiques par pseudo, embeds et images au format API', () => {
    const html = `<div class="message-group"><img class="avatar" src="https://cdn/bob.png"><span class="username" style="color:#fff">Bob</span>
      <span class="timestamp">16 juil. 2022, 09:14</span><div class="message-text">Salut</div>
      <img src="https://cdn/capture.png" class="discord-img" alt="Image jointe" /></div>
      <div class="message-group"><img class="avatar" src="https://cdn/bot.png"><span class="username" style="color:#fff">Tickets</span><span class="bot-tag">BOT</span>
      <span class="timestamp">pas une date</span>
      <div class="discord-embed" style="border-left-color: #5865f2"><div class="discord-embed-title">Ticket fermé</div></div></div>
      <div class="message-group"><img class="avatar" src="https://cdn/bob.png"><span class="username" style="color:#fff">Bob</span>
      <span class="timestamp">16 juil. 2022, 09:20</span><div class="message-text">Merci</div></div>`;
    const conversation = transcriptConversation({ format: 'html', html, data: null }, '2026-11-20T12:00:00.000Z');

    expect(conversation.entities).toEqual({});
    expect(conversation.authors).toEqual({
      '1': { displayName: 'Bob', avatarUrl: 'https://cdn/bob.png', bot: false, verified: false },
      '2': { displayName: 'Tickets', avatarUrl: 'https://cdn/bot.png', bot: true, verified: false },
    });
    const [first, second, third] = conversation.messages;
    expect(first).toMatchObject({
      id: 'transcript-0', author: { id: '1', username: 'Bob' }, content: 'Salut', timestamp: '2022-07-16T09:14:00.000Z',
      attachments: [{ filename: 'capture.png', url: 'https://cdn/capture.png', content_type: 'image/png' }],
    });
    expect(second).toMatchObject({ author: { id: '2', bot: true }, timestamp: '2026-11-20T12:00:00.000Z' });
    expect(second.embeds[0]).toMatchObject({ title: 'Ticket fermé', color: 0x5865f2 });
    expect(third.author.id).toBe('1');
  });
});

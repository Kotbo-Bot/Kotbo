import { describe, expect, test } from 'bun:test';
import { conversationOf, conversationViews, type DiscordApiMessage, type DiscordConversation } from './discordConversation';

const user = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, username: name.toLowerCase(), global_name: name, discriminator: '0', avatar: null, ...extra });

function message(extra: Record<string, unknown>): DiscordApiMessage {
  return {
    id: '1', channel_id: '9', type: 0, author: user('11', 'Alice'), content: '', timestamp: '2026-11-20T10:00:00.000Z',
    edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [],
    components: [], pinned: false, ...extra,
  } as DiscordApiMessage;
}

const authors: DiscordConversation['authors'] = {
  11: { displayName: 'Alice (modo)', avatarUrl: 'https://cdn/alice.png', color: '#ff0000', bot: false, verified: false },
  22: { displayName: 'Kotbo', avatarUrl: 'https://cdn/kotbo.png', bot: true, verified: true },
};

describe('conversationOf', () => {
  test('lit la réponse de l’API, vide si elle ne porte rien', () => {
    expect(conversationOf(null)).toEqual({ messages: [], entities: {}, authors: {} });
    const conversation = conversationOf({ messages: [message({})], entities: { users: { 11: { name: 'Alice' } } }, authors });
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.entities.users).toEqual({ 11: { name: 'Alice' } });
  });
});

describe('conversationViews', () => {
  test('auteur figé : pseudo, avatar, couleur du rôle, application vérifiée', () => {
    const [alice, kotbo] = conversationViews({
      messages: [message({ content: 'Salut' }), message({ id: '2', author: user('22', 'kotbo-bot', { bot: true }) })],
      entities: {},
      authors,
    });
    expect(alice.author).toMatchObject({ id: '11', displayName: 'Alice (modo)', avatarUrl: 'https://cdn/alice.png', color: '#ff0000', bot: false });
    expect(alice.body).toEqual({ kind: 'markdown', content: 'Salut' });
    expect(kotbo.author).toMatchObject({ displayName: 'Kotbo', bot: true, verified: true });
  });

  test('Components V2 rendus tels quels', () => {
    const [view] = conversationViews({
      messages: [message({
        flags: 1 << 15,
        components: [{ type: 17, accent_color: 0x5865f2, components: [{ type: 10, content: '### Ticket ouvert' }] }],
      })],
      entities: {},
      authors,
    });
    expect(view.body.kind).toBe('components-v2');
    expect(view.body.kind === 'components-v2' && view.body.components[0]).toMatchObject({ kind: 'container', accentColor: '#5865f2' });
  });

  test('réponses : à un message (auteur figé), supprimé, à une commande', () => {
    const [reply, deleted, command] = conversationViews({
      messages: [
        message({
          id: '3', type: 19, author: user('22', 'kotbo', { bot: true }), content: 'Réponse',
          message_reference: { type: 0, message_id: '1', channel_id: '9' },
          referenced_message: message({ content: 'Question' }),
        }),
        message({ id: '4', type: 19, message_reference: { type: 0, message_id: '0', channel_id: '9' }, referenced_message: null }),
        message({ id: '5', type: 20, author: user('22', 'kotbo', { bot: true }), interaction: { id: '7', type: 2, name: 'ticket fermer', user: user('11', 'Alice') } }),
      ],
      entities: {},
      authors,
    });
    expect(reply.reply).toMatchObject({ messageId: '1', content: 'Question', author: { displayName: 'Alice (modo)', color: '#ff0000' } });
    expect(deleted.reply).toEqual({ messageId: '0', unavailable: true });
    expect(command.reply).toMatchObject({ kind: 'interaction', commandName: 'ticket fermer', author: { displayName: 'Alice (modo)' } });
  });

  test('transcription historique : auteur synthétique numérique, embed conservé', () => {
    const [view] = conversationViews({
      messages: [message({ author: user('1', 'Kotbo test', { bot: true }), embeds: [{ description: '### Ticket', color: 0x5865f2 }] })],
      entities: {},
      authors: { 1: { displayName: 'Kotbo test', avatarUrl: 'https://cdn/bot.png', bot: true, verified: false } },
    });
    expect(view.embeds).toEqual([{ id: 'embed:0', description: '### Ticket', color: '#5865f2' }]);
  });

  test('message illisible pour la lib : auteur et texte conservés', () => {
    const [view] = conversationViews({
      messages: [message({ content: 'Texte', embeds: null as unknown as [] })],
      entities: {},
      authors,
    });
    expect(view).toMatchObject({ id: '1', body: { kind: 'markdown', content: 'Texte' }, author: { displayName: 'Alice (modo)' } });
  });
});

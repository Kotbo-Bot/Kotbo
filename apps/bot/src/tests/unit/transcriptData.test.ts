import { describe, expect, test } from 'bun:test';
import type { Guild, Message } from 'discord.js';

const { buildConversation, buildTranscriptData, serializeMessage } = await import('../../services/features/transcriptData.js');

/** Collection discord.js réduite à ce que lit le sérialiseur. */
function collection<V extends { id: string }>(items: V[]) {
  const map = new Map(items.map((item) => [item.id, item]));
  return Object.assign(map, { first: () => items[0] });
}

const VERIFIED_BOT = 1 << 16;

function user(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    username: name.toLowerCase(),
    globalName: name,
    displayName: name,
    discriminator: '0',
    avatar: `hash-${id}`,
    bot: false,
    system: false,
    flags: { bitfield: 0 },
    primaryGuild: null,
    displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/hash-${id}.webp`,
    ...extra,
  };
}

const alice = user('100000000000000001', 'Alice');
const kotbo = user('100000000000000002', 'Kotbo', { bot: true, flags: { bitfield: VERIFIED_BOT } });
const bob = user('100000000000000003', 'Bob');

const roles = new Map([
  ['200000000000000001', { id: '200000000000000001', name: 'Staff', color: 0xff0000, hexColor: '#ff0000' }],
]);
const members = new Map<string, unknown>([
  [alice.id, {
    nickname: 'Alice (modo)', avatar: null, displayName: 'Alice (modo)', displayColor: 0xff0000, displayHexColor: '#ff0000',
    displayAvatarURL: () => alice.displayAvatarURL(),
  }],
]);
const guild = {
  id: '300000000000000001',
  members: { cache: members },
  roles: { cache: roles },
  channels: { cache: new Map([['400000000000000002', { name: 'support' }]]) },
  client: { users: { cache: new Map([[bob.id, bob]]) } },
} as unknown as Guild;

const channelCache = new Map<string, unknown>();

function message(id: string, author: ReturnType<typeof user>, extra: Record<string, unknown> = {}): Message {
  return {
    id,
    channelId: '400000000000000001',
    channel: { messages: { cache: channelCache } },
    type: 0,
    author,
    member: members.get(author.id) ?? null,
    content: '',
    createdAt: new Date('2026-11-20T10:00:00.000Z'),
    editedAt: null,
    tts: false,
    pinned: false,
    flags: { bitfield: 0 },
    webhookId: null,
    mentions: { everyone: false, users: collection([]), roles: collection([]) },
    attachments: collection([]),
    embeds: [],
    components: [],
    stickers: collection([]),
    reactions: { cache: collection([]) },
    reference: null,
    interaction: null,
    interactionMetadata: null,
    fetchReference: () => Promise.reject(new Error('Unknown Message')),
    ...extra,
  } as unknown as Message;
}

describe('serializeMessage', () => {
  test('texte, auteur, membre, mentions au format de l’API', () => {
    const msg = message('500000000000000001', alice, {
      content: 'Salut <@100000000000000003> et <@&200000000000000001>',
      editedAt: new Date('2026-11-20T10:05:00.000Z'),
      mentions: {
        everyone: false,
        users: collection([bob]),
        roles: collection([roles.get('200000000000000001')!]),
      },
    });
    const api = serializeMessage(msg);
    expect(api).toMatchObject({
      id: '500000000000000001',
      channel_id: '400000000000000001',
      type: 0,
      content: 'Salut <@100000000000000003> et <@&200000000000000001>',
      timestamp: '2026-11-20T10:00:00.000Z',
      edited_timestamp: '2026-11-20T10:05:00.000Z',
      author: { id: alice.id, username: 'alice', global_name: 'Alice', avatar: `hash-${alice.id}`, public_flags: 0 },
      member: { nick: 'Alice (modo)', avatar: null },
      mention_roles: ['200000000000000001'],
      attachments: [],
      embeds: [],
      components: [],
    });
    expect(api.mentions.map((mentioned) => mentioned.id)).toEqual([bob.id]);
    expect(api.referenced_message).toBeUndefined();
  });

  test('application vérifiée : drapeau public conservé', () => {
    const api = serializeMessage(message('500000000000000002', kotbo));
    expect(api.author).toMatchObject({ bot: true, public_flags: VERIFIED_BOT });
  });

  test('embeds et Components V2 repris via toJSON, pièces jointes et réactions', () => {
    const embed = { title: 'Ticket', description: 'Bonjour', color: 0x5865f2, fields: [{ name: 'Motif', value: 'Aide', inline: false }] };
    const container = { type: 17, components: [{ type: 10, content: 'Texte V2' }] };
    const msg = message('500000000000000003', kotbo, {
      flags: { bitfield: 1 << 15 },
      embeds: [{ toJSON: () => embed }],
      components: [{ toJSON: () => container }],
      attachments: collection([{
        id: '600000000000000001', name: 'photo.png', url: 'https://cdn/photo.png', proxyURL: 'https://media/photo.png', size: 1234,
        contentType: 'image/png', description: null, width: 640, height: 480, duration: null, waveform: null, flags: { bitfield: 0 },
      }]),
      reactions: { cache: collection([{
        id: 'r', emoji: { id: null, name: '👍', animated: false }, count: 2, countDetails: { burst: 0, normal: 2 },
        me: false, meBurst: false, burstColors: [],
      }]) },
    });
    const api = serializeMessage(msg);
    expect(api.flags).toBe(1 << 15);
    expect(api.embeds).toEqual([embed]);
    expect(api.components).toEqual([container] as never);
    expect(api.attachments).toEqual([{
      id: '600000000000000001', filename: 'photo.png', url: 'https://cdn/photo.png', proxy_url: 'https://media/photo.png',
      size: 1234, content_type: 'image/png', width: 640, height: 480,
    }]);
    expect(api.reactions).toEqual([{
      emoji: { id: null, name: '👍' }, count: 2, count_details: { burst: 0, normal: 2 }, me: false, me_burst: false, burst_colors: [],
    }]);
  });

  test('réponse à un message : référence et message référencé sans récursion', () => {
    const original = message('500000000000000004', bob, {
      content: 'Question',
      reference: { type: 0, messageId: '500000000000000000', channelId: '400000000000000001', guildId: guild.id },
    });
    const reply = message('500000000000000005', alice, {
      type: 19,
      content: 'Réponse',
      reference: { type: 0, messageId: original.id, channelId: '400000000000000001', guildId: guild.id },
    });
    const api = serializeMessage(reply, original);
    expect(api.message_reference).toEqual({ type: 0, message_id: original.id, channel_id: '400000000000000001', guild_id: guild.id });
    expect(api.referenced_message).toMatchObject({ id: original.id, content: 'Question', author: { id: bob.id } });
    expect(api.referenced_message?.referenced_message).toBeUndefined();
    expect(serializeMessage(reply, null).referenced_message).toBeNull();
  });

  test('réponse à une commande : interaction et métadonnées', () => {
    const msg = message('500000000000000006', kotbo, {
      type: 20,
      interaction: { id: '700000000000000001', type: 2, commandName: 'ticket ouvrir', user: alice },
      interactionMetadata: {
        id: '700000000000000001', type: 2, user: alice, authorizingIntegrationOwners: { 0: guild.id },
        originalResponseMessageId: null, interactedMessageId: null, triggeringInteractionMetadata: null,
      },
    });
    const api = serializeMessage(msg);
    expect(api.type).toBe(20);
    expect(api.interaction).toMatchObject({ id: '700000000000000001', type: 2, name: 'ticket ouvrir', user: { id: alice.id } });
    expect(api.interaction_metadata).toMatchObject({
      id: '700000000000000001', type: 2, user: { id: alice.id }, authorizing_integration_owners: { 0: guild.id },
    });
  });
});

describe('buildTranscriptData', () => {
  test('auteurs figés, réponses résolues, entités des textes et des mentions', async () => {
    const question = message('500000000000000010', bob, { content: 'Besoin d’aide dans <#400000000000000002>' });
    const answer = message('500000000000000011', alice, {
      type: 19,
      content: 'Je regarde <:check:800000000000000001>',
      reference: { type: 0, messageId: question.id, channelId: '400000000000000001', guildId: guild.id },
    });
    const deletedReply = message('500000000000000012', alice, {
      type: 19,
      content: 'Réponse à un message supprimé',
      reference: { type: 0, messageId: '500000000000000099', channelId: '400000000000000001', guildId: guild.id },
    });
    const command = message('500000000000000013', kotbo, {
      type: 20,
      interaction: { id: '700000000000000002', type: 2, commandName: 'ticket fermer', user: alice },
      embeds: [{ toJSON: () => ({ description: 'Fermé par <@100000000000000001>' }), title: null, description: 'Fermé par <@100000000000000001>', footer: null, author: null, fields: [] }],
    });

    const data = await buildTranscriptData(
      { id: '400000000000000001', name: 'ticket-bob', topic: null, guild },
      [question, answer, deletedReply, command],
    );

    expect(data.version).toBe(1);
    expect(data.channel).toEqual({ id: '400000000000000001', name: 'ticket-bob', topic: null });
    expect(data.messages.map((msg) => msg.id)).toEqual([question.id, answer.id, deletedReply.id, command.id]);
    expect(data.messages[1].referenced_message?.id).toBe(question.id);
    expect(data.messages[2].referenced_message).toBeNull();

    expect(data.authors[alice.id]).toEqual({
      displayName: 'Alice (modo)', avatarUrl: alice.displayAvatarURL(), color: '#ff0000', bot: false, verified: false,
    });
    expect(data.authors[bob.id]).toEqual({ displayName: 'Bob', avatarUrl: bob.displayAvatarURL(), bot: false, verified: false });
    expect(data.authors[kotbo.id]).toEqual({ displayName: 'Kotbo', avatarUrl: kotbo.displayAvatarURL(), bot: true, verified: true });

    expect(data.entities).toEqual({
      users: { [alice.id]: { name: 'Alice (modo)' } },
      channels: { '400000000000000002': { name: 'support' } },
      emojis: { '800000000000000001': { name: 'check', image: 'https://cdn.discordapp.com/emojis/800000000000000001.png?size=48' } },
    });
  });
});

describe('buildConversation', () => {
  test('vue rafraîchie : une citation hors fenêtre n’est pas demandée à Discord', async () => {
    let fetched = 0;
    const reply = message('500000000000000020', alice, {
      type: 19,
      reference: { type: 0, messageId: '500000000000000001', channelId: '400000000000000001', guildId: guild.id },
      fetchReference: () => { fetched++; return Promise.reject(new Error('Unknown Message')); },
    });
    const live = await buildConversation(guild, [reply], { fetchMissingReferences: false });
    expect(fetched).toBe(0);
    expect(live.messages[0].referenced_message).toBeUndefined();
    expect(live.messages[0].message_reference?.message_id).toBe('500000000000000001');
    expect(live).not.toHaveProperty('version');

    const archived = await buildConversation(guild, [reply]);
    expect(fetched).toBe(1);
    expect(archived.messages[0].referenced_message).toBeNull();
  });
});

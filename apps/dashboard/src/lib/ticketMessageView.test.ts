import { describe, expect, test } from 'bun:test';
import { mergeTicketEntities, toTicketMessageView, type TicketChatMessage } from './ticketMessageView';

const base: TicketChatMessage = {
  id: '1',
  authorId: '42',
  authorName: 'Lina',
  authorAvatar: 'https://cdn.discordapp.com/avatars/42/a.png',
  isStaff: false,
  content: 'Bonjour <@42>',
  createdAt: '2026-11-21T10:00:00.000Z',
};

describe('toTicketMessageView', () => {
  test('auteur, horodatage et Markdown brut', () => {
    const view = toTicketMessageView(base);
    expect(view.author).toEqual({ id: '42', displayName: 'Lina', avatarUrl: base.authorAvatar ?? undefined, bot: false });
    expect(view.timestamp).toBe(base.createdAt);
    expect(view.body).toEqual({ kind: 'markdown', content: 'Bonjour <@42>' });
    expect(view.embeds).toBeUndefined();
    expect(view.components).toBeUndefined();
  });

  test('le bot porte le badge, pas le message local en cours d’envoi', () => {
    expect(toTicketMessageView({ ...base, isStaff: true }).author.bot).toBe(true);
    expect(toTicketMessageView({ ...base, id: 'temp-1', isStaff: true }).author.bot).toBe(false);
  });

  test('pièces jointes : images et vidéos en média, le reste en fichier', () => {
    const view = toTicketMessageView({
      ...base,
      attachments: [
        { url: 'https://cdn/a/photo.png?ex=1', contentType: 'image/png' },
        { url: 'https://cdn/a/clip.mp4', contentType: 'video/mp4' },
        { url: 'https://cdn/a/voice.ogg', contentType: 'audio/ogg' },
        { url: 'https://cdn/a/logs.txt', contentType: 'text/plain' },
      ],
    });
    expect(view.media).toEqual([
      { id: '1-attachment-0', url: 'https://cdn/a/photo.png?ex=1', alt: 'photo.png' },
      { id: '1-attachment-1', kind: 'video', url: 'https://cdn/a/clip.mp4', alt: 'clip.mp4' },
    ]);
    expect(view.attachments).toEqual([
      { id: '1-attachment-2', kind: 'audio', url: 'https://cdn/a/voice.ogg', name: 'voice.ogg' },
      { id: '1-attachment-3', kind: 'file', url: 'https://cdn/a/logs.txt', name: 'logs.txt' },
    ]);
  });

  test('un lien déjà montré par un embed ou joint ne se répète pas', () => {
    const view = toTicketMessageView({
      ...base,
      mediaUrls: [
        { type: 'image', url: 'https://media.tenor.com/x/cat.gif' },
        { type: 'image', url: 'https://cdn/a/photo.png' },
        { type: 'image', url: 'https://exemple.fr/libre.png' },
      ],
      attachments: [{ url: 'https://cdn/a/photo.png', contentType: 'image/png' }],
      embeds: [{ video: { url: 'https://media.tenor.com/y/cat.mp4' } }],
    });
    expect(view.media?.map((media) => media.url)).toEqual([
      'https://exemple.fr/libre.png',
      'https://cdn/a/photo.png',
      'https://media.tenor.com/y/cat.mp4',
    ]);
  });

  test('embeds, boutons par rangées de cinq et réactions', () => {
    const button = (label: string, style = 2) => ({ label, emoji: null, url: null, style, disabled: false });
    const view = toTicketMessageView({
      ...base,
      embeds: [{
        title: 'Ticket',
        description: 'Décris ton souci',
        color: '#5865f2',
        fields: [{ name: 'Motif', value: 'Support' }],
        thumbnail: { url: 'https://cdn/t.png' },
        buttons: [button('Fermer', 4), button('Prendre', 1)],
      }],
      buttons: [button('A'), button('B'), button('C'), { label: 'Doc', emoji: '📘', url: 'https://doc', style: 5, disabled: false }],
      reactions: [{ emoji: '👍', imageUrl: null, name: '👍', count: 2 }],
    });
    expect(view.embeds?.[0]).toEqual({
      id: '1-embed-0',
      title: 'Ticket',
      description: 'Décris ton souci',
      color: '#5865f2',
      fields: [{ id: '1-embed-0-field-0', name: 'Motif', value: 'Support' }],
      image: undefined,
      thumbnail: { id: '1-embed-0-thumbnail', url: 'https://cdn/t.png', alt: '' },
    });
    expect(view.components?.map((row) => row.buttons?.map((entry) => entry.label))).toEqual([
      ['Fermer', 'Prendre', 'A', 'B', 'C'],
      ['Doc'],
    ]);
    expect(view.components?.[0].buttons?.[0]).toMatchObject({ kind: 'button', style: 'danger' });
    expect(view.components?.[1].buttons?.[0]).toMatchObject({ kind: 'link-button', url: 'https://doc', emoji: { name: '📘' } });
    expect(view.reactions).toEqual([{ id: '1-reaction-0', emoji: { name: '👍', image: undefined }, count: 2 }]);
  });
});

describe('mergeTicketEntities', () => {
  test('fusionne les noms de toute la conversation', () => {
    const merged = mergeTicketEntities([
      { ...base, entities: { users: { 42: { name: 'Lina' } }, roles: { 7: { name: 'Staff', color: '#ff0000' } } } },
      { ...base, id: '2', entities: { channels: { 9: { name: 'support' } } } },
      { ...base, id: '3' },
    ]);
    expect(merged.users).toEqual({ 42: { name: 'Lina' } });
    expect(merged.roles).toEqual({ 7: { name: 'Staff', color: '#ff0000' } });
    expect(merged.channels).toEqual({ 9: { name: 'support' } });
  });
});

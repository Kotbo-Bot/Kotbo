import { describe, expect, test } from 'bun:test';
import { buildGuildEntities, toLoggedMessageView } from './loggedMessageView';

describe('buildGuildEntities', () => {
  test('résout les rôles et les salons du serveur', () => {
    const entities = buildGuildEntities({
      roles: [{ id: '1', name: 'Staff', color: '#5865F2' }, { id: '2', name: 'Membre', color: null }],
      channels: [{ id: '10', name: 'general' }],
    });

    expect(entities.roles).toEqual({
      '1': { name: 'Staff', color: '#5865F2' },
      '2': { name: 'Membre' },
    });
    expect(entities.channels).toEqual({ '10': { name: 'general' } });
  });
});

describe('toLoggedMessageView', () => {
  test('extrait les émojis personnalisés, l’état bot/édité et les entités serveur', () => {
    const { view, entities } = toLoggedMessageView(
      {
        id: 'm1',
        authorId: 'u1',
        authorName: 'Kotbo',
        authorAvatar: null,
        isBot: true,
        content: 'Bonjour <:wave:123456789012345678> dans <#10> <@&1>',
        createdAt: '2026-11-26T10:00:00.000Z',
        editedAt: '2026-11-26T10:05:00.000Z',
      },
      {
        roles: [{ id: '1', name: 'Staff', color: '#5865F2' }],
        channels: [{ id: '10', name: 'general' }],
      },
    );

    expect(view.author.bot).toBe(true);
    expect(view.author.displayName).toBe('Kotbo');
    expect(view.edited).toBe(true);
    expect(view.timestamp).toBe('2026-11-26T10:00:00.000Z');
    expect(view.body).toEqual({
      kind: 'markdown',
      content: 'Bonjour <:wave:123456789012345678> dans <#10> <@&1>',
    });
    expect(entities.emojis?.['123456789012345678']?.name).toBe('wave');
    expect(entities.roles?.['1']?.name).toBe('Staff');
    expect(entities.channels?.['10']?.name).toBe('general');
  });

  test('sépare images, vidéos et fichiers joints', () => {
    const { view } = toLoggedMessageView({
      id: 'm2',
      authorId: 'u2',
      authorName: 'Alice',
      content: '',
      createdAt: '2026-11-26T10:00:00.000Z',
      attachments: [
        { name: 'photo.png', url: 'https://cdn.example/photo.png', contentType: 'image/png' },
        { name: 'clip.mp4', url: 'https://cdn.example/clip.mp4', contentType: 'video/mp4' },
        { name: 'notes.pdf', url: 'https://cdn.example/notes.pdf', contentType: 'application/pdf' },
      ],
    });

    expect(view.body).toEqual({ kind: 'markdown', content: '' });
    if (view.body.kind === 'components-v2') throw new Error('unexpected body kind');
    expect(view.media).toEqual([
      { id: 'm2-img-0', url: 'https://cdn.example/photo.png', alt: 'photo.png' },
      { id: 'm2-vid-1', kind: 'video', url: 'https://cdn.example/clip.mp4', alt: 'clip.mp4' },
    ]);
    expect(view.attachments).toEqual([
      { id: 'm2-file-2', kind: 'file', url: 'https://cdn.example/notes.pdf', name: 'notes.pdf' },
    ]);
  });
});

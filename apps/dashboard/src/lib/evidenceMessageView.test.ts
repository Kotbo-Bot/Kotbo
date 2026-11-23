import { describe, expect, test } from 'bun:test';
import { toEvidenceMessageView, type EvidenceMessage } from './evidenceMessageView';

const author = { id: 'evidence-target', displayName: 'spammer#0' };

const base: EvidenceMessage = {
  id: 'm1', content: 'Nitro gratuit ici @Lina', createdAt: '2026-11-20T10:00:00.000Z', attachments: [], embeds: [], stickers: [],
};

describe('toEvidenceMessageView', () => {
  test('auteur sanctionné, texte en Markdown, date', () => {
    expect(toEvidenceMessageView(base, author)).toEqual({
      id: 'm1', author, timestamp: '2026-11-20T10:00:00.000Z', body: { kind: 'markdown', content: 'Nitro gratuit ici @Lina' },
    });
  });

  test('pièces jointes : images et vidéos en média, le reste en fichier avec sa taille', () => {
    const view = toEvidenceMessageView({
      ...base,
      attachments: [
        { url: 'https://cdn/a.png', name: 'a.png', contentType: 'image/png', size: 10, kind: 'image' },
        { url: 'https://cdn/b.mp4', name: 'b.mp4', contentType: 'video/mp4', size: 10, kind: 'video' },
        { url: 'https://cdn/c.zip', name: 'c.zip', contentType: 'application/zip', size: 2_621_440, kind: 'file' },
      ],
    }, author);
    expect(view.media).toEqual([
      { id: 'm1-0', url: 'https://cdn/a.png', alt: 'a.png' },
      { id: 'm1-1', kind: 'video', url: 'https://cdn/b.mp4', alt: 'b.mp4' },
    ]);
    expect(view.attachments).toEqual([{ id: 'm1-file-0', kind: 'file', url: 'https://cdn/c.zip', name: 'c.zip', size: '2.5 MB' }]);
  });

  test('embed complet et autocollants', () => {
    const view = toEvidenceMessageView({
      ...base,
      embeds: [{
        color: '#ff0000', authorName: 'Bot', authorIconUrl: null, authorUrl: null, title: 'Offre', url: 'https://scam',
        description: 'Clique', fields: [{ name: 'Prix', value: '0 €', inline: true }], thumbnailUrl: null, imageUrl: 'https://cdn/i.png',
        footerText: 'Pied', footerIconUrl: null,
      }],
      stickers: [{ id: 's1', name: 'wave', url: 'https://media.discordapp.net/stickers/s1.gif' }],
    }, author);
    expect(view.embeds?.[0]).toEqual({
      id: 'm1-embed-0', color: '#ff0000', title: 'Offre', url: 'https://scam', description: 'Clique', author: { name: 'Bot' },
      fields: [{ id: 'm1-embed-0-field-0', name: 'Prix', value: '0 €', inline: true }],
      image: { id: 'm1-embed-0-image', url: 'https://cdn/i.png', alt: '' }, footer: { text: 'Pied' },
    });
    expect(view.stickers).toEqual([{ id: 's1', name: 'wave', url: 'https://media.discordapp.net/stickers/s1.gif', format: 'gif' }]);
  });
});

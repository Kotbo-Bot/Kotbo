import { describe, expect, test } from 'bun:test';
import { botEmbedToV2 } from './botEmbedV2';

describe('botEmbedToV2', () => {
  test('annonce de giveaway : la même structure que le message publié par le bot', () => {
    const view = botEmbedToV2({
      title: 'GIVEAWAY : Prix',
      description: "J'adore ce giveaway\n\n**Nombre de gagnants :** 1",
      color: '#5865f2',
      footer: 'ID : cmwrrih1x003z0017lrg7i92l',
    }, 'g');
    expect(view).toEqual({
      id: 'g',
      kind: 'container',
      accentColor: '#5865f2',
      components: [
        { id: 'g-title', kind: 'text-display', content: '### GIVEAWAY : Prix' },
        { id: 'g-description', kind: 'text-display', content: "J'adore ce giveaway\n\n**Nombre de gagnants :** 1" },
        { id: 'g-footer-separator', kind: 'separator', divider: false, spacing: 'small' },
        { id: 'g-footer', kind: 'text-display', content: '-# ID : cmwrrih1x003z0017lrg7i92l' },
      ],
    });
  });

  test('titre lié en gras, auteur au-dessus, vignette en accessoire', () => {
    const view = botEmbedToV2({ title: 'Patch [v2]', url: 'https://exemple.fr/a(b)', authorName: 'Kotbo', thumbnailUrl: 'https://cdn/t.png' }, 'e');
    expect(view.components[0]).toEqual({
      id: 'e-header',
      kind: 'section',
      components: [{ id: 'e-title', kind: 'text-display', content: '**Kotbo**\n**[Patch \\[v2\\]](https://exemple.fr/a%28b%29)**' }],
      accessory: { id: 'e-thumbnail', kind: 'thumbnail', media: { id: 'e-thumbnail-media', url: 'https://cdn/t.png', alt: '' } },
    });
  });

  test('champs sous un séparateur, image en galerie, couleur par défaut', () => {
    const view = botEmbedToV2({ fields: [{ name: 'Prix', value: 'Nitro' }, { name: '', value: 'ignoré' }], imageUrl: 'https://cdn/i.png' }, 'f');
    expect(view.accentColor).toBe('#5865f2');
    expect(view.components).toEqual([
      { id: 'f-fields-separator', kind: 'separator', divider: true, spacing: 'small' },
      { id: 'f-field-0', kind: 'text-display', content: '**Prix**\nNitro' },
      { id: 'f-image', kind: 'media-gallery', items: [{ id: 'f-image-media', url: 'https://cdn/i.png', alt: '' }] },
    ]);
  });

  test('lien non http : titre gardé en heading', () => {
    expect(botEmbedToV2({ title: 'Titre', url: 'javascript:alert(1)' }, 'x').components[0]).toMatchObject({ content: '### Titre' });
  });
});

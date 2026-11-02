/**
 * Galerie de modèles : ce qui part dans la galerie ne doit rien emporter du
 * serveur d'origine (textes, liens externes, salons, formulaires), seulement
 * la mise en page.
 */
import { describe, expect, test } from 'bun:test';
import { extractSiteDocumentText, normalizeSiteDocument, type SiteNode } from '@kotbo/shared';
import { mapDocumentImages, toTemplateDocument } from '../../services/site/siteTemplateGallery.js';

const doc = normalizeSiteDocument({
  type: 'doc',
  content: [
    {
      type: 'section',
      attrs: { background: 'image', bgImage: '/s/_/a/abcdefghijklmnopqrstuvwx.webp', layout: '1-1', anchor: 'rejoindre' },
      content: [
        {
          type: 'column',
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Les Nerds de Bordeaux' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Écris à jean@example.com', marks: [{ type: 'link', attrs: { href: 'mailto:jean@example.com' } }] }] },
            { type: 'button', attrs: { label: 'Rejoindre', href: 'https://discord.gg/secret' } },
            { type: 'button', attrs: { label: 'Règles', href: '/~/wiki/regles' } },
          ],
        },
        {
          type: 'column',
          content: [
            { type: 'module', attrs: { module: 'channelFeed', config: { channelId: '123456789012345678' } } },
            { type: 'faq', content: [{ type: 'faqItem', attrs: { question: 'Où est Jean ?' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Chez lui.' }] }] }] },
            { type: 'image', attrs: { src: 'https://cdn.example/photo.png', alt: '' } },
          ],
        },
      ],
    },
  ],
});

describe('document envoyé dans la galerie', () => {
  const out = toTemplateDocument(doc, 'fr');
  const text = extractSiteDocumentText(out);
  const json = JSON.stringify(out);

  test('garde la mise en page et le style de section', () => {
    expect(out.content[0].type).toBe('section');
    expect(out.content[0].attrs).toMatchObject({ background: 'image', layout: '1-1', anchor: 'rejoindre' });
    expect(out.content[0].content?.map((c) => c.content?.map((b) => b.type))).toEqual([
      ['heading', 'paragraph', 'button', 'button'],
      ['module', 'faq', 'image'],
    ]);
  });

  test('aucun texte, nom ni adresse du serveur d\'origine', () => {
    for (const leak of ['Nerds', 'Bordeaux', 'jean', 'Jean', 'Chez lui', 'discord.gg', '123456789012345678']) {
      expect(text.includes(leak) || json.includes(leak)).toBe(false);
    }
  });

  test('liens internes gardés, liens externes renvoyés vers le site', () => {
    const buttons = (out.content[0].content?.[0].content ?? []).filter((b: SiteNode) => b.type === 'button').map((b) => b.attrs?.href);
    expect(buttons).toEqual(['/~/', '/~/wiki/regles']);
  });

  test('les images se laissent réécrire, fond de section compris', () => {
    const mapped = mapDocumentImages(out, (url) => (url.startsWith('/s/_/a/') ? '/s/_/a/zzzzzzzzzzzzzzzzzzzzzzzz.webp' : url));
    expect(mapped.content[0].attrs?.bgImage).toBe('/s/_/a/zzzzzzzzzzzzzzzzzzzzzzzz.webp');
    expect(JSON.stringify(mapped)).toContain('https://cdn.example/photo.png');
  });
});

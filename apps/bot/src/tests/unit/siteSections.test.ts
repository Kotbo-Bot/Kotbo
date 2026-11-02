/**
 * Sections de page (bandes à colonnes) : liste blanche, découpage des pages
 * d'avant les sections, rendu.
 */
import { describe, expect, test } from 'bun:test';
import { isSectionedDocument, normalizeSiteDocument, sectionizeSiteDocument, type SiteNode } from '@kotbo/shared';
import { renderSiteDocument } from '../../services/site/siteRenderer.js';

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const col = (...content: unknown[]) => ({ type: 'column', content });
const env = { basePath: '/s/nerds', host: 'dash.kotbo.fr', moduleHtml: [], labels: { toc: 'Sommaire', video: 'Vidéo', gallery: 'Galerie' } };
const render = (content: unknown[]) => renderSiteDocument(normalizeSiteDocument({ type: 'doc', content }), env);

describe('liste blanche des sections', () => {
  test('garde une section et ses colonnes, attributs bornés', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [{ type: 'section', attrs: { layout: '2-1', background: 'gradient', bgGradient: 'ocean', overlay: 500, animation: 'spin', anchor: 'Rejoindre' }, content: [col(p('a')), col(p('b'))] }],
    });
    const section = doc.content[0];
    expect(section.type).toBe('section');
    expect(section.content?.map((n) => n.type)).toEqual(['column', 'column']);
    expect(section.attrs).toMatchObject({ layout: '2-1', background: 'gradient', bgGradient: 'ocean', overlay: 80, animation: 'none', anchor: 'rejoindre' });
  });

  test('la disposition suit le nombre réel de colonnes, quatre au plus', () => {
    const three = normalizeSiteDocument({ type: 'doc', content: [{ type: 'section', attrs: { layout: '1-1' }, content: [col(p('a')), col(p('b')), col(p('c'))] }] });
    expect(three.content[0].attrs?.layout).toBe('1-1-1');
    const six = normalizeSiteDocument({ type: 'doc', content: [{ type: 'section', content: [1, 2, 3, 4, 5, 6].map((i) => col(p(String(i)))) }] });
    expect(six.content[0].content).toHaveLength(4);
    expect(six.content[0].attrs?.layout).toBe('1-1-1-1');
  });

  test('ni section imbriquée, ni colonne hors section', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [col(p('orpheline')), { type: 'section', content: [col({ type: 'section', content: [col(p('x'))] }, p('gardé'))] }],
    });
    expect(doc.content.map((n) => n.type)).toEqual(['section']);
    expect(doc.content[0].content?.[0].content?.map((n) => n.type)).toEqual(['paragraph']);
  });

  test('fond couleur ou image sans valeur valide : aucun fond', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [
        { type: 'section', attrs: { background: 'color', bgColor: 'red' }, content: [col(p('a'))] },
        { type: 'section', attrs: { background: 'image', bgImage: 'javascript:alert(1)' }, content: [col(p('b'))] },
      ],
    });
    expect(doc.content.map((n) => n.attrs?.background)).toEqual(['none', 'none']);
  });

  test('une section vide reçoit une colonne vide', () => {
    const doc = normalizeSiteDocument({ type: 'doc', content: [{ type: 'section', content: [] }] });
    expect(doc.content[0].content).toEqual([{ type: 'column', content: [{ type: 'paragraph' }] }]);
  });
});

describe('découpage en sections', () => {
  test('regroupe les blocs, coupe aux titres 1-2 et isole les bannières', () => {
    const doc = sectionizeSiteDocument(
      normalizeSiteDocument({
        type: 'doc',
        content: [p('intro'), h(2, 'A'), p('a'), h(3, 'sous-titre'), p('a2'), { type: 'banner', content: [p('appel')] }, p('fin')],
      }),
    );
    expect(isSectionedDocument(doc)).toBe(true);
    const groups = doc.content.map((s) => (s.content?.[0].content ?? []).map((n: SiteNode) => n.type));
    expect(groups).toEqual([['paragraph'], ['heading', 'paragraph', 'heading', 'paragraph'], ['banner'], ['paragraph']]);
    // Sections neutres : le rendu reste celui d'avant.
    expect(doc.content.every((s) => s.attrs?.padding === 'none' && s.attrs?.background === 'none')).toBe(true);
  });

  test('laisse les sections existantes et rend un document stable', () => {
    const once = sectionizeSiteDocument(normalizeSiteDocument({ type: 'doc', content: [{ type: 'section', attrs: { background: 'dark' }, content: [col(p('x'))] }, p('après')] }));
    expect(once.content.map((s) => s.attrs?.background)).toEqual(['dark', 'none']);
    expect(sectionizeSiteDocument(normalizeSiteDocument(once))).toEqual(normalizeSiteDocument(once));
  });

  test('un document vide reçoit une section vide', () => {
    const doc = sectionizeSiteDocument({ type: 'doc', content: [] });
    expect(doc.content).toHaveLength(1);
    expect(isSectionedDocument(normalizeSiteDocument(doc))).toBe(true);
  });
});

describe('rendu des sections', () => {
  test('classes de style, colonnes et ancre', () => {
    const html = render([{ type: 'section', attrs: { layout: '1-2', background: 'dark', padding: 'large', width: 'full', animation: 'fade', visibleOn: 'desktop', anchor: 'equipe' }, content: [col(p('a')), col(p('b'))] }]);
    expect(html).toContain('id="equipe"');
    expect(html).toContain('class="sect bg-dark pad-large w-full only-desktop tone-inverse"');
    expect(html).toContain('data-anim="fade"');
    expect(html).toContain('<div class="sect-cols layout-1-2"><div class="sect-col"><p>a</p></div><div class="sect-col"><p>b</p></div></div>');
  });

  test('couleur claire : texte sombre ; couleur sombre : texte clair', () => {
    const light = render([{ type: 'section', attrs: { background: 'color', bgColor: '#fef3c7' }, content: [col(p('a'))] }]);
    const dark = render([{ type: 'section', attrs: { background: 'color', bgColor: '#111827' }, content: [col(p('a'))] }]);
    expect(light).toContain('style="--sect-color:#fef3c7"');
    expect(light).not.toContain('tone-inverse');
    expect(dark).toContain('tone-inverse');
  });

  test('image de fond limitée aux URL sûres pour un style', () => {
    const html = render([{ type: 'section', attrs: { background: 'image', bgImage: 'https://cdn.example/fond.webp', overlay: 30 }, content: [col(p('a'))] }]);
    expect(html).toContain('style="--sect-image:url(&quot;https://cdn.example/fond.webp&quot;);--sect-overlay:0.3"');
  });
});

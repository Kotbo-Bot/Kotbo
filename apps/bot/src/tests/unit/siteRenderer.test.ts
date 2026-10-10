/**
 * Rendu HTML des pages du site communautaire.
 *
 * Le HTML produit ici est servi sous le domaine du dashboard : tout texte doit
 * sortir échappé, et aucun attribut ne doit pouvoir porter de script.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeSiteDocument } from '@kotbo/shared';
import { renderSiteDocument, resolveSiteHref } from '../../services/site/siteRenderer.js';

const env = { basePath: '/s/nerds', host: 'dash.kotbo.fr', moduleHtml: [], labels: { toc: 'Sommaire', video: 'Vidéo', gallery: 'Galerie' } };
const render = (content: unknown[], moduleHtml: string[] = []) =>
  renderSiteDocument(normalizeSiteDocument({ type: 'doc', content }), { ...env, moduleHtml });

describe('échappement', () => {
  test('le texte ne peut pas ouvrir de balise', () => {
    const html = render([{ type: 'paragraph', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] }]);
    expect(html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  test('un attribut ne peut pas sortir de ses guillemets', () => {
    const html = render([{ type: 'image', attrs: { src: 'https://cdn.example/a.png', alt: '" onload="alert(1)' } }]);
    expect(html).toContain('alt="&quot; onload=&quot;alert(1)"');
  });

  test('questions de FAQ et légendes échappées', () => {
    const html = render([{ type: 'faq', content: [{ type: 'faqItem', attrs: { question: '<b>Q</b>' }, content: [] }] }]);
    expect(html).toContain('<summary>&lt;b&gt;Q&lt;/b&gt;</summary>');
  });
});

describe('liens', () => {
  test('lien interne résolu sur le site courant', () => {
    expect(resolveSiteHref('/~/wiki/regles', '/s/nerds')).toBe('/s/nerds/wiki/regles');
    const html = render([{ type: 'paragraph', content: [{ type: 'text', text: 'règles', marks: [{ type: 'link', attrs: { href: '/~/wiki/regles' } }] }] }]);
    expect(html).toBe('<p><a href="/s/nerds/wiki/regles">règles</a></p>');
  });

  test('lien externe ouvert à part, sans référent', () => {
    const html = render([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://kotbo.fr' } }, { type: 'bold' }] }] }]);
    expect(html).toBe('<p><a href="https://kotbo.fr/" rel="noopener noreferrer ugc" target="_blank"><strong>x</strong></a></p>');
  });
});

describe('structure', () => {
  test('titres décalés d’un niveau, avec ancre', () => {
    const html = render([{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Été' }] }]);
    expect(html).toBe('<h2 id="ete" class="doc-h1">Été<a class="anchor" href="#ete" aria-hidden="true" tabindex="-1">#</a></h2>');
  });

  test('sommaire construit sur les titres', () => {
    const html = render([
      { type: 'toc', attrs: { maxLevel: 2 } },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'B' }] },
    ]);
    expect(html).toContain('<li class="toc-l2"><a href="#a">A</a></li>');
    expect(html).not.toContain('toc-l3');
  });

  test('blocs de modules insérés dans l’ordre du document', () => {
    const html = render(
      [
        { type: 'module', attrs: { module: 'staff' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
        { type: 'module', attrs: { module: 'join' } },
      ],
      ['<section>1</section>', '<section>2</section>'],
    );
    expect(html).toBe('<section>1</section>\n<p>x</p>\n<section>2</section>');
  });

  test('vidéo Twitch : parent = hôte de la page', () => {
    const html = render([{ type: 'video', attrs: { provider: 'twitch', videoId: 'kotbo' } }]);
    expect(html).toContain('https://player.twitch.tv/?channel=kotbo&amp;parent=dash.kotbo.fr');
  });

  test('grille bento', () => {
    const html = render([{ type: 'grid', attrs: { columns: 3 }, content: [{ type: 'gridCell', attrs: { span: 2 }, content: [{ type: 'paragraph' }] }] }]);
    expect(html).toBe('<div class="bento cols-3"><div class="cell span-2 surface"><p><br></p></div></div>');
  });
});

describe('sections prêtes à l’emploi', () => {
  test('bannière : texte éditable, image filtrée, ton et alignement bornés', () => {
    const ok = render([{ type: 'banner', attrs: { image: '/s/_/a/abcdefghijklmnopqrstuvwx.webp', tone: 'accent', align: 'left', tall: true }, content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Rejoins-nous' }] }] }]);
    expect(ok).toContain('class="sec-banner tone-accent align-left is-tall has-image"');
    expect(ok).toContain('--banner-image:url(&quot;/s/_/a/abcdefghijklmnopqrstuvwx.webp&quot;)');
    expect(ok).toContain('Rejoins-nous');
    const bad = render([{ type: 'banner', attrs: { image: 'javascript:alert(1)', tone: 'fuchsia' }, content: [{ type: 'paragraph' }] }]);
    expect(bad).toContain('class="sec-banner tone-surface align-center"');
    expect(bad).not.toContain('banner-image');
  });

  test('galerie : sources filtrées, plafond, mise en page', () => {
    const images = [{ src: 'https://cdn.exemple.fr/a.png', alt: 'A<b>', caption: 'Légende' }, { src: 'http://non-https.fr/b.png' }, { src: 'data:image/png;base64,AAAA' }];
    const grid = render([{ type: 'gallery', attrs: { images, columns: 9 } }]);
    expect(grid).toContain('class="gallery gallery-grid cols-4"');
    expect(grid.match(/<figure/g)?.length).toBe(1);
    expect(grid).toContain('alt="A&lt;b&gt;"');
    const carousel = render([{ type: 'gallery', attrs: { images, layout: 'carousel' } }]);
    expect(carousel).toContain('gallery-carousel');
    expect(render([{ type: 'gallery', attrs: { images: [] } }])).toBe('');
  });

  test('témoignages : citation éditable, nom et rôle échappés, conteneur vide retiré', () => {
    const html = render([{ type: 'testimonials', attrs: { columns: 2 }, content: [{ type: 'testimonial', attrs: { name: '<Léa>', role: 'Modo' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Super serveur' }] }] }] }]);
    expect(html).toContain('class="testimonials cols-2"');
    expect(html).toContain('<strong>&lt;Léa&gt;</strong><span>Modo</span>');
    expect(html).toContain('Super serveur');
    expect(normalizeSiteDocument({ type: 'doc', content: [{ type: 'testimonials', content: [] }] }).content).toEqual([]);
    expect(normalizeSiteDocument({ type: 'doc', content: [{ type: 'testimonial', content: [] }] }).content).toEqual([]);
  });
});

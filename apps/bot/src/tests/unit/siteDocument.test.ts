/**
 * Normalisation des documents du site communautaire.
 *
 * `normalizeSiteDocument` est la seule barrière entre ce qu'envoie un éditeur
 * (ou n'importe qui imitant l'éditeur) et le HTML servi sous le domaine du
 * dashboard : ce qui la traverse est rendu, échappé mais tel quel.
 */
import { describe, expect, test } from 'bun:test';
import {
  collectSiteHeadings,
  collectSiteModules,
  extractSiteDocumentText,
  foldSearchText,
  normalizeSiteDocument,
  parseSiteVideo,
  sanitizeSiteHref,
  sanitizeSiteImageSrc,
  SITE_DOCUMENT_LIMITS,
} from '@kotbo/shared';

const p = (text: string, marks?: unknown[]) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });

describe('liste blanche', () => {
  test('retire les nœuds inconnus et garde le reste', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [p('a'), { type: 'iframe', attrs: { src: 'https://evil' } }, { type: 'htmlBlock', content: [] }, p('b')],
    });
    expect(doc.content.map((n) => n.type)).toEqual(['paragraph', 'paragraph']);
  });

  test('rejette une entrée qui n’est pas un document', () => {
    expect(normalizeSiteDocument(null)).toEqual({ type: 'doc', content: [] });
    expect(normalizeSiteDocument({ type: 'paragraph' })).toEqual({ type: 'doc', content: [] });
    expect(normalizeSiteDocument('pas du json')).toEqual({ type: 'doc', content: [] });
  });

  test('un nœud enfant n’est accepté que là où son parent le permet', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [{ type: 'listItem', content: [p('orphelin')] }, { type: 'bulletList', content: [p('pas un élément de liste')] }],
    });
    expect(doc.content).toEqual([]);
  });

  test('ne garde que les attributs connus', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 9, onclick: 'x', textAlign: 'center' }, content: [{ type: 'text', text: 'T' }] }],
    });
    expect(doc.content[0].attrs).toEqual({ level: 4, textAlign: 'center' });
  });

  test('fusionne les textes voisins de mêmes marques', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }, { type: 'text', text: 'ef', marks: [{ type: 'bold' }] }] }],
    });
    expect(doc.content[0].content).toEqual([
      { type: 'text', text: 'abcd' },
      { type: 'text', text: 'ef', marks: [{ type: 'bold' }] },
    ]);
  });

  test('borne le nombre de nœuds', () => {
    const content = Array.from({ length: SITE_DOCUMENT_LIMITS.maxNodes + 500 }, (_, i) => ({ type: 'horizontalRule', i }));
    const doc = normalizeSiteDocument({ type: 'doc', content });
    expect(doc.content.length).toBe(SITE_DOCUMENT_LIMITS.maxNodes);
  });

  test('donne un paragraphe vide aux conteneurs vides plutôt que de les casser', () => {
    const doc = normalizeSiteDocument({ type: 'doc', content: [{ type: 'callout', attrs: { variant: 'warning' } }] });
    expect(doc.content[0]).toEqual({ type: 'callout', attrs: { variant: 'warning', icon: '' }, content: [{ type: 'paragraph' }] });
  });
});

describe('liens et images', () => {
  test('refuse les schémas exécutables', () => {
    expect(sanitizeSiteHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeSiteHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(sanitizeSiteHref('data:text/html,<script>')).toBeNull();
    expect(sanitizeSiteHref('vbscript:x')).toBeNull();
  });

  test('refuse les URL absolues déguisées en chemins', () => {
    expect(sanitizeSiteHref('//evil.example/x')).toBeNull();
    expect(sanitizeSiteHref('/\\evil.example')).toBeNull();
  });

  test('accepte http(s), mailto, chemins et ancres', () => {
    expect(sanitizeSiteHref('https://kotbo.fr/a')).toBe('https://kotbo.fr/a');
    expect(sanitizeSiteHref('mailto:a@b.fr')).toBe('mailto:a@b.fr');
    expect(sanitizeSiteHref('/s/mon-serveur/wiki/regles')).toBe('/s/mon-serveur/wiki/regles');
    expect(sanitizeSiteHref('#reglement')).toBe('#reglement');
  });

  test('un lien invalide perd sa marque, pas son texte', () => {
    const doc = normalizeSiteDocument({ type: 'doc', content: [p('clic', [{ type: 'link', attrs: { href: 'javascript:x' } }])] });
    expect(doc.content[0].content).toEqual([{ type: 'text', text: 'clic' }]);
  });

  test('images : https ou fichiers téléversés uniquement', () => {
    expect(sanitizeSiteImageSrc('http://x.fr/a.png')).toBeNull();
    expect(sanitizeSiteImageSrc('data:image/png;base64,AAA')).toBeNull();
    expect(sanitizeSiteImageSrc('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
    expect(sanitizeSiteImageSrc('/s/_/a/clx1234567890abcdefghij.png')).toBe('/s/_/a/clx1234567890abcdefghij.png');
    expect(sanitizeSiteImageSrc('/s/_/a/../../etc/passwd')).toBeNull();
  });

  test('une image sans source valide disparaît', () => {
    const doc = normalizeSiteDocument({ type: 'doc', content: [{ type: 'image', attrs: { src: 'javascript:x' } }] });
    expect(doc.content).toEqual([]);
  });

  test('vidéos : identifiants extraits et vérifiés', () => {
    expect(parseSiteVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({ provider: 'youtube', videoId: 'dQw4w9WgXcQ' });
    expect(parseSiteVideo('https://youtu.be/dQw4w9WgXcQ')).toEqual({ provider: 'youtube', videoId: 'dQw4w9WgXcQ' });
    expect(parseSiteVideo('https://www.twitch.tv/kotbo')).toEqual({ provider: 'twitch', videoId: 'kotbo' });
    expect(parseSiteVideo('https://vimeo.com/123456789')).toEqual({ provider: 'vimeo', videoId: '123456789' });
    const doc = normalizeSiteDocument({ type: 'doc', content: [{ type: 'video', attrs: { provider: 'youtube', videoId: '"><script>' } }] });
    expect(doc.content).toEqual([]);
  });
});

describe('blocs de modules', () => {
  test('refuse un module inconnu', () => {
    const doc = normalizeSiteDocument({ type: 'doc', content: [{ type: 'module', attrs: { module: 'shell' } }] });
    expect(doc.content).toEqual([]);
  });

  test('borne la configuration', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [{ type: 'module', attrs: { module: 'leaderboard', config: { variant: 'nope', limit: 5000, extra: true } } }],
    });
    expect(doc.content[0].attrs).toEqual({ module: 'leaderboard', config: { variant: 'xp', limit: 100 } });
  });

  test('partenaires saisis à la main : URL vérifiées', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [{ type: 'module', attrs: { module: 'partners', config: { items: [{ name: 'A', url: 'javascript:x', logoUrl: 'http://x/a.png' }, { url: 'https://b' }] } } }],
    });
    expect(doc.content[0].attrs?.config).toEqual({ items: [{ name: 'A', description: '', logoUrl: '', url: '' }] });
  });

  test('liste les modules utilisés, même imbriqués', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [
        { type: 'grid', attrs: { columns: 2 }, content: [{ type: 'gridCell', content: [{ type: 'module', attrs: { module: 'staff' } }] }] },
        { type: 'module', attrs: { module: 'join' } },
      ],
    });
    expect(collectSiteModules(doc).sort()).toEqual(['join', 'staff']);
  });
});

describe('texte, titres, recherche', () => {
  test('replie accents et casse', () => {
    expect(foldSearchText('  Règlement   ÉTÉ  ')).toBe('reglement ete');
  });

  test('extrait le texte, questions de FAQ comprises', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titre' }] },
        { type: 'faq', content: [{ type: 'faqItem', attrs: { question: 'Comment ?' }, content: [p('Ainsi.')] }] },
      ],
    });
    expect(extractSiteDocumentText(doc)).toBe('Titre Comment ? Ainsi.');
  });

  test('ancres uniques pour des titres identiques', () => {
    const doc = normalizeSiteDocument({
      type: 'doc',
      content: [1, 2, 3].map(() => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Été 2026' }] })),
    });
    expect(collectSiteHeadings(doc).map((h) => h.id)).toEqual(['ete-2026', 'ete-2026-2', 'ete-2026-3']);
  });
});

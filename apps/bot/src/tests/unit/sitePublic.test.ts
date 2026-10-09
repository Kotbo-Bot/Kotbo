/**
 * Briques pures du rendu public des sites : CSP, langue, recherche, aperçus,
 * mesure d'audience.
 */
import { describe, expect, test } from 'bun:test';
import { pickLocale, robotsTxt, siteCsp } from '../../services/site/sitePages.js';
import { buildSnippet, searchTerms } from '../../services/site/siteSearch.js';
import { createPreviewToken, verifyPreviewToken } from '../../services/site/sitePreview.js';
import { deviceOf, isBotUserAgent, referrerHost } from '../../services/site/siteAnalyticsService.js';
import { renderSiteShell, renderThemeCss, safeBannerUrl, safeJson } from '../../services/site/siteLayout.js';
import type { SiteRecord } from '../../services/site/siteService.js';

describe('CSP du site', () => {
  test('scripts limités au site et au nonce', () => {
    const csp = siteCsp('abc', 'https://api.kotbo.fr');
    expect(csp).toContain("script-src 'self' 'nonce-abc'");
    expect(csp).not.toContain("'unsafe-inline' https");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://api.kotbo.fr");
  });

  test('seule la page d’intégration accepte d’être encadrée', () => {
    expect(siteCsp('abc', 'https://api.kotbo.fr', true)).toContain('frame-ancestors *');
  });
});

describe('langue', () => {
  test('paramètre lang prioritaire, puis Accept-Language, sinon français', () => {
    expect(pickLocale(new URLSearchParams('lang=en'), 'fr-FR')).toBe('en');
    expect(pickLocale(new URLSearchParams(), 'de-DE,en;q=0.8')).toBe('en');
    expect(pickLocale(new URLSearchParams(), 'de-DE')).toBe('fr');
    expect(pickLocale(new URLSearchParams(), null)).toBe('fr');
  });
});

describe('recherche', () => {
  test('termes repliés et nettoyés', () => {
    expect(searchTerms("Règlement d'été & co")).toEqual(['reglement', 'ete', 'co']);
    expect(searchTerms("a ' ; DROP")).toEqual(['drop']);
  });

  test('extrait pris dans le texte d’origine, accents compris, et échappé', () => {
    const snippet = buildSnippet('Le <b>règlement</b> du serveur', ['reglement']);
    expect(snippet).toBe('Le &lt;b&gt;<mark>règlement</mark>&lt;/b&gt; du serveur');
  });
});

describe('aperçus de brouillon', () => {
  test('un jeton valide désigne sa page', () => {
    const { token } = createPreviewToken('clx1234567890abcdefghijk');
    expect(verifyPreviewToken(token)).toBe('clx1234567890abcdefghijk');
  });

  test('jeton retouché ou expiré refusé', () => {
    const { token } = createPreviewToken('clx1234567890abcdefghijk', Date.now() - 8 * 24 * 3600 * 1000);
    expect(verifyPreviewToken(token)).toBeNull();
    const fresh = createPreviewToken('clx1234567890abcdefghijk').token;
    expect(verifyPreviewToken(fresh.replace('clx1234567890abcdefghijk', 'clx1234567890abcdefghijz'))).toBeNull();
  });
});

describe('mesure d’audience', () => {
  test('robots écartés', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Discordbot/2.0)')).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')).toBe(false);
  });

  test('appareil', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
  });

  test('source : domaine, le site lui-même compte comme direct', () => {
    expect(referrerHost('https://www.google.com/search?q=x', 'dash.kotbo.fr')).toBe('google.com');
    expect(referrerHost('https://dash.kotbo.fr/s/nerds', 'dash.kotbo.fr')).toBe('direct');
    expect(referrerHost(null, 'dash.kotbo.fr')).toBe('direct');
  });
});

describe('divers', () => {
  test('JSON dans une balise script : impossible de la fermer', () => {
    expect(safeJson({ a: '</script><script>alert(1)</script>' })).not.toContain('</script>');
  });

  test('robots.txt annonce le plan des sites', () => {
    expect(robotsTxt('https://dash.kotbo.fr')).toContain('Sitemap: https://dash.kotbo.fr/s/sitemap.xml');
  });
});

describe('gabarit', () => {
  const site = {
    id: 'site1',
    guildId: '111111111111111111',
    slug: 'kotdev',
    name: 'Kotdev',
    tagline: 'La communauté des devs',
    theme: 'verre',
    themeSettings: {},
    navigation: [],
    homePageId: null,
    logoUrl: null,
    faviconUrl: null,
    bannerUrl: null,
    customCss: '.site-root h1{color:red}',
    updatedAt: new Date('2026-10-09T10:00:00Z'),
  } as unknown as SiteRecord;

  const shell = (extra: Partial<Parameters<typeof renderSiteShell>[0]> = {}) =>
    renderSiteShell({
      site,
      identity: { name: 'Kotdev', iconUrl: null, bannerUrl: null },
      locale: 'fr',
      basePath: '/s/kotdev',
      origin: 'https://dash.kotbo.fr',
      apiOrigin: 'https://api.kotbo.fr',
      nonce: 'abc',
      path: '/s/kotdev',
      title: 'Kotdev',
      navPages: [],
      hasWiki: true,
      hasBlog: true,
      main: '<p>contenu</p>',
      ...extra,
    });

  test('mode clair/sombre : défaut du thème, script à nonce avant les styles, bascule', () => {
    const html = shell();
    expect(html).toContain('data-default-mode="auto"');
    expect(html).toContain('<script nonce="abc">(function(){');
    expect(html.indexOf('kotbo-site-mode:site1')).toBeLessThan(html.indexOf('/s/_/site.css'));
    expect(html).toContain('data-mode-toggle');
  });

  test('bannière d’accueil entre la barre et le contenu, pied de page en colonnes', () => {
    const html = shell({ hero: '<section class="site-hero">H</section>', inviteUrl: 'https://discord.gg/abc' });
    expect(html.indexOf('site-header')).toBeLessThan(html.indexOf('site-hero'));
    expect(html.indexOf('site-hero')).toBeLessThan(html.indexOf('id="contenu"'));
    expect(html).toContain('footer-grid');
    expect(html).toContain('https://discord.gg/abc');
    expect(html).toContain('/s/kotdev/rss.xml');
  });

  test('feuille du thème : deux palettes, puis le CSS libre', () => {
    const css = renderThemeCss(site, null);
    expect(css).toContain('--site-header:');
    expect(css).toContain('[data-mode="dark"]');
    expect(css.indexOf('[data-mode="dark"]')).toBeLessThan(css.indexOf('.site-root h1'));
  });

  test('image de bannière : seulement HTTPS ou image du site, sans caractère qui casse url()', () => {
    expect(safeBannerUrl('https://cdn.discordapp.com/banners/1/a.png')).toBe('https://cdn.discordapp.com/banners/1/a.png');
    expect(safeBannerUrl('/s/_/a/abc.webp')).toBe('/s/_/a/abc.webp');
    expect(safeBannerUrl('http://exemple.fr/a.png')).toBeNull();
    expect(safeBannerUrl('https://a.fr/x.png")}body{display:none')).toBeNull();
    expect(safeBannerUrl("https://a.fr/x'.png")).toBeNull();
  });
});

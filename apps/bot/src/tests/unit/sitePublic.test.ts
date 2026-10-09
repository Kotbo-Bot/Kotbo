/**
 * Briques pures du rendu public des sites : CSP, langue, recherche, aperçus,
 * mesure d'audience.
 */
import { describe, expect, test } from 'bun:test';
import { pickLocale, robotsTxt, siteCsp } from '../../services/site/sitePages.js';
import { buildSnippet, searchTerms } from '../../services/site/siteSearch.js';
import { createPreviewToken, verifyPreviewToken } from '../../services/site/sitePreview.js';
import { deviceOf, isBotUserAgent, referrerHost } from '../../services/site/siteAnalyticsService.js';
import { safeJson } from '../../services/site/siteLayout.js';

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

import { describe, expect, test } from 'bun:test';
import { sanitizePublicTheme } from '../../utils/publicTheme.js';

describe('sanitizePublicTheme', () => {
  test('rejette ce qui n\'est pas un objet et un thème vide', () => {
    expect(sanitizePublicTheme(null)).toBeNull();
    expect(sanitizePublicTheme('x')).toBeNull();
    expect(sanitizePublicTheme({})).toBeNull();
  });

  test('conserve les valeurs valides', () => {
    expect(sanitizePublicTheme({ accentColor: '#22d3ee', background: 'grid', density: 'compact', fontFamily: 'Outfit', borderRadius: 12 }))
      .toEqual({ accentColor: '#22d3ee', background: 'grid', density: 'compact', fontFamily: 'Outfit', borderRadius: 12 });
  });

  test('écarte les couleurs, polices, fonds et URLs invalides', () => {
    const out = sanitizePublicTheme({
      accentColor: 'red; background:url(x)',
      fontFamily: 'Comic Sans',
      background: 'video',
      bannerUrl: 'http://exemple.fr/a.png',
      logoUrl: 'javascript:alert(1)',
      borderRadius: 999,
    });
    expect(out).toEqual({ borderRadius: 32 });
  });

  test('assainit le CSS personnalisé et borne le titre', () => {
    const out = sanitizePublicTheme({
      customCss: '.a{position:fixed;color:red} @import url(//evil);',
      siteTitle: 'x'.repeat(200),
    });
    expect(out?.customCss).not.toContain('fixed');
    expect(out?.customCss).not.toContain('@import');
    expect(out?.siteTitle?.length).toBe(80);
  });
});

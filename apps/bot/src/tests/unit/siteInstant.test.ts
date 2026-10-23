/**
 * Site instantané : type de communauté deviné, jetons d'aperçu du site entier.
 */
import { describe, expect, test } from 'bun:test';
// Chargé d'abord, comme en production : les blocs se référencent entre eux par le rendu.
import '../../services/site/sitePages.js';
import { guessSiteTemplate } from '../../services/site/siteInstantService.js';
import { createSitePreviewToken, readCookie, verifySitePreviewToken } from '../../services/site/sitePreview.js';

describe('type de communauté', () => {
  test('nom, description et salons', () => {
    expect(guessSiteTemplate({ name: 'Les Chroniques d’Aldor', description: 'Serveur RP médiéval', channels: ['fiches-personnages', 'hrp-discussion'] })).toBe('rp');
    expect(guessSiteTemplate({ name: 'Team Nova', description: null, channels: ['scrims', 'roster', 'valorant'] })).toBe('esport');
    expect(guessSiteTemplate({ name: 'Entraide Bac 2027', channels: ['maths', 'physique'] })).toBe('etude');
    expect(guessSiteTemplate({ name: 'Le QG', channels: ['minecraft', 'fortnite', 'général'] })).toBe('gaming');
  });

  test('un seul indice ne suffit pas, les accents ne gênent pas', () => {
    expect(guessSiteTemplate({ name: 'Le Café', channels: ['général', 'jeux'] })).toBe('general');
    expect(guessSiteTemplate({ name: 'Révisions Prépa', channels: [] })).toBe('etude');
  });

  test('à égalité, le plus spécifique l’emporte sur le jeu', () => {
    expect(guessSiteTemplate({ name: 'Minecraft RP', channels: [] })).toBe('rp');
  });
});

describe('aperçu du site entier', () => {
  const siteId = 'cmabc123def456ghi789jkl0';

  test('jeton valide pour son site seulement, puis expiré', () => {
    const now = Date.UTC(2026, 9, 11);
    const { token } = createSitePreviewToken(siteId, now);
    expect(verifySitePreviewToken(token, siteId, now + 1000)).toBe(true);
    expect(verifySitePreviewToken(token, 'cmzzz999zzz999zzz999zzz9', now + 1000)).toBe(false);
    expect(verifySitePreviewToken(token, siteId, now + 8 * 86_400_000)).toBe(false);
    expect(verifySitePreviewToken(`${token.slice(0, -2)}xx`, siteId, now)).toBe(false);
    expect(verifySitePreviewToken(null, siteId)).toBe(false);
  });

  test('lecture d’un cookie parmi d’autres', () => {
    expect(readCookie('a=1; kotbo_site_preview=site.x.y.z==; b=2', 'kotbo_site_preview')).toBe('site.x.y.z==');
    expect(readCookie('a=1', 'kotbo_site_preview')).toBeNull();
    expect(readCookie(null, 'kotbo_site_preview')).toBeNull();
  });
});

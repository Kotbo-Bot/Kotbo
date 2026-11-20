/**
 * Garde contre l'aspiration du classement public : un navigateur sur une page
 * Kotbo passe, un script ou un autre bot non.
 */
import { describe, expect, test } from 'bun:test';
import { isBrowserPageRequest } from '../../api/shared/scrapeGuard.js';

describe('isBrowserPageRequest', () => {
  test('fetch depuis la même origine ou un sous-domaine Kotbo', () => {
    expect(isBrowserPageRequest({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).toBe(true);
    expect(isBrowserPageRequest({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' })).toBe(true);
  });

  test('fetch cross-origin : l\'origine, déjà filtrée par la garde CORS, suffit', () => {
    expect(isBrowserPageRequest({ 'sec-fetch-site': 'cross-site', origin: 'https://mon-serveur.fr' })).toBe(true);
  });

  test('script sans en-têtes de navigateur', () => {
    expect(isBrowserPageRequest({ 'user-agent': 'curl/8.0' })).toBe(false);
    expect(isBrowserPageRequest({ 'user-agent': 'Mozilla/5.0' })).toBe(false);
  });

  test('URL de l\'API ouverte directement dans un onglet', () => {
    expect(isBrowserPageRequest({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })).toBe(false);
    expect(isBrowserPageRequest({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' })).toBe(false);
  });
});

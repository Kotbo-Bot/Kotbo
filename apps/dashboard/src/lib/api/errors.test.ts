import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DashboardApiError, messageForApiCode, TRANSLATED_API_CODES } from './errors';
import { m } from '../i18n';

/**
 * Table code -> message des erreurs de la route vocale (`tv_*`) : le dashboard
 * traduit le code AVANT de montrer le texte français du serveur.
 */
const ROUTE = join(import.meta.dir, '..', '..', '..', '..', 'bot', 'src', 'api', 'routes', 'dashboard', 'modules', 'channels-management.ts');
const routeSource = readFileSync(ROUTE, 'utf-8');
const messages = (lang: 'fr' | 'en') =>
  JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'messages', `${lang}.json`), 'utf-8')) as Record<string, string>;

/** Tous les codes `tv_*` que la route émet (littéraux entre apostrophes). */
const emitted = [...new Set([...routeSource.matchAll(/'(tv_[a-z_]+)'/g)].map((x) => x[1]))];

describe('codes d\'erreur de la route vocale', () => {
  test('la route émet bien des codes (garde contre un motif de recherche cassé)', () => {
    expect(emitted.length).toBeGreaterThanOrEqual(25);
  });

  test('chaque code émis par la route a son entrée dans la table du dashboard', () => {
    const manquants = emitted.filter((code) => !TRANSLATED_API_CODES.includes(code));
    expect(manquants).toEqual([]);
  });

  test('chaque entrée de la table correspond à un code que la route émet encore', () => {
    expect(TRANSLATED_API_CODES.filter((code) => !emitted.includes(code))).toEqual([]);
  });

  test('chaque code a sa clé api_err_<code> en français ET en anglais', () => {
    for (const lang of ['fr', 'en'] as const) {
      const dict = messages(lang);
      expect(emitted.filter((code) => !dict[`api_err_${code}`])).toEqual([]);
    }
  });

  test('un code connu remplace le texte du serveur', () => {
    const error = new DashboardApiError({
      kind: 'not_found',
      status: 404,
      code: 'tv_channel_not_found',
      serverMessage: 'Salon introuvable',
    });
    expect(error.message).toBe(m.api_err_tv_channel_not_found());
    expect(error.message).not.toBe('Salon introuvable');
    expect(error.userMessage).toBe(m.api_err_tv_channel_not_found());
  });

  test('les paramètres du corps de réponse sont insérés dans le message', () => {
    const error = new DashboardApiError({
      kind: 'client',
      status: 400,
      code: 'tv_setting_invalid_range',
      data: { code: 'tv_setting_invalid_range', params: { field: 'denyCooldownMinutes', value: '0', min: 1, max: 1440 } },
      serverMessage: 'repli',
    });
    expect(error.message).toContain('denyCooldownMinutes');
    expect(error.message).toContain('1440');
    expect(error.message).not.toBe('repli');
  });

  test('un code inconnu, un code absent ou un nom du prototype gardent le message du serveur', () => {
    for (const code of ['tv_inconnu', undefined, 'constructor', '__proto__', 'internal_error']) {
      const error = new DashboardApiError({ kind: 'client', status: 400, code, serverMessage: 'Texte du serveur' });
      expect(error.message).toBe('Texte du serveur');
      expect(messageForApiCode(code)).toBeUndefined();
    }
  });

  test('sans code ni message, le texte de la catégorie reste le repli', () => {
    expect(new DashboardApiError({ kind: 'not_found', status: 404 }).message).toBe(m.api_err_not_found());
  });
});

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Une clé appelée par `m.cle()` mais absente d'une langue n'est pas compilée par
 * Paraglide : `m.cle` vaut `undefined` et la page plante à l'affichage
 * (« (void 0) is not a function »). Ni svelte-check ni les tests de logique ne
 * le voient, d'où ce contrôle sur la source.
 */
const SRC = join(import.meta.dir, '..');
const dict = (lang: 'fr' | 'en') =>
  JSON.parse(readFileSync(join(SRC, '..', 'messages', `${lang}.json`), 'utf-8')) as Record<string, string>;

function fichiers(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return nom === 'paraglide' ? [] : fichiers(chemin);
    return /\.(svelte|ts)$/.test(nom) && !nom.endsWith('.test.ts') ? [chemin] : [];
  });
}

// Seuls les fichiers qui importent `m` depuis le module i18n ; les commentaires
// sont retirés, et une clé a toujours la forme `mot_mot`.
const IMPORT_M = /import\s*\{[^}]*\bm\b[^}]*\}\s*from\s*['"][^'"]*i18n['"]/;
const sansCommentaires = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function clesUtilisees(): Map<string, string[]> {
  const usages = new Map<string, string[]>();
  for (const fichier of fichiers(SRC)) {
    const code = readFileSync(fichier, 'utf-8');
    if (!IMPORT_M.test(code)) continue;
    for (const [, cle] of sansCommentaires(code).matchAll(/\bm\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g)) {
      usages.set(cle, [...(usages.get(cle) ?? []), relative(SRC, fichier)]);
    }
  }
  return usages;
}

describe('clés de traduction', () => {
  const usages = clesUtilisees();

  test('la source appelle bien des clés (le contrôle lit quelque chose)', () => {
    expect(usages.size).toBeGreaterThan(1000);
    expect(usages.has('cm_tv_generator_taken_hint')).toBe(true);
  });

  for (const lang of ['fr', 'en'] as const) {
    test(`chaque clé appelée existe en ${lang}`, () => {
      const messages = dict(lang);
      const manquantes = [...usages].filter(([cle]) => !(cle in messages)).map(([cle, ou]) => `${cle} (${[...new Set(ou)].join(', ')})`);
      expect(manquantes).toEqual([]);
    });
  }
});

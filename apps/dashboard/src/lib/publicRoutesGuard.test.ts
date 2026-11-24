import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou : une route déclarée dans le bloc public d'App.svelte ne s'affiche
 * que si `isPublicPage` la reconnaît. Le formulaire de support et la boutique y
 * étaient déclarés sans y figurer : la page ne s'affichait jamais, et un
 * visiteur non connecté était renvoyé vers la connexion.
 */
const APP = readFileSync(join(import.meta.dir, '..', 'App.svelte'), 'utf-8');
const predicate = APP.slice(APP.indexOf('const isPublicPage = $derived('), APP.indexOf('function profileUserIdFromPath'));

describe('pages publiques', () => {
  for (const prefix of ['/support/', '/boutique/']) {
    test(`${prefix} est reconnu comme page publique`, () => {
      expect(predicate).toContain(`$router.path.startsWith("${prefix}")`);
    });
  }
});

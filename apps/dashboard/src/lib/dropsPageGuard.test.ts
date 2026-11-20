import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fous de la page Drops.svelte, lus dans la source (pas de harnais de
 * rendu dans le depot, meme motif que `channelsManagementGuard.test.ts`).
 *
 *  G1 - le droit d'edition lu sur une autre fonctionnalite. L'API rattache le
 *       segment `drops` a la fonctionnalite `drops` (featureGate.ts) : une page
 *       qui teste `featureAccess.leveling` s'ouvre en lecture seule pour le role
 *       autorise sur Drops, et en edition pour un role que le serveur refusera
 *       a l'enregistrement.
 *       QUAND IL TOMBE : tester `featureAccess?.drops?.canConfigure`.
 *
 *  G2 - la correspondance type de drop -> module recopiee dans la page. Elle
 *       existe dans `@kotbo/shared` (`DROP_TYPE_MODULE`), lue par le bot : une
 *       copie locale divergera a l'ajout du prochain type.
 *       QUAND IL TOMBE : importer `DROP_TYPE_MODULE` depuis `@kotbo/shared`.
 */
const source = readFileSync(join(import.meta.dir, '../pages/Drops.svelte'), 'utf8');

describe('page Drops', () => {
  test('G1 - le droit d\'edition est celui de la fonctionnalite drops', () => {
    const lus = [...source.matchAll(/featureAccess\?\.(\w+)\?\.canConfigure/g)].map((match) => match[1]);
    expect(lus).toEqual(['drops']);
  });

  test('G2 - la correspondance type -> module vient de @kotbo/shared', () => {
    expect(source).toContain('DROP_TYPE_MODULE');
    expect(source).not.toMatch(/const\s+TYPE_MODULES\b/);
  });
});

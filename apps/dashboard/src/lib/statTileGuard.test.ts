import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La tuile de chiffre clé (icône, valeur, libellé) était recopiée en snippet
 * `statTile` dans chaque page qui en affichait. Elle vit désormais dans
 * `ui/StatTile.svelte` : une copie locale divergerait à la prochaine retouche.
 *
 * QUAND IL TOMBE : importer `StatTile` depuis `../lib/components/ui` au lieu
 * de redéfinir le snippet.
 */
const PAGES = join(import.meta.dir, '../pages');

describe('tuile de chiffre clé', () => {
  test('aucune page ne redéfinit le snippet statTile', () => {
    const copies = readdirSync(PAGES)
      .filter((file) => file.endsWith('.svelte'))
      .filter((file) => /\{#snippet\s+statTile\s*\(/.test(readFileSync(join(PAGES, file), 'utf-8')));
    expect(copies).toEqual([]);
  });

  test('la tuile est exportée par les primitives ui', () => {
    const index = readFileSync(join(import.meta.dir, 'components/ui/index.ts'), 'utf-8');
    expect(index).toContain("export { default as StatTile } from './StatTile.svelte';");
  });
});

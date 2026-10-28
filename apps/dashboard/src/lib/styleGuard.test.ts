import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou de l'homogeneisation visuelle.
 *
 * Le dashboard avait derive faute de regle : plus de 5 000 couleurs Tailwind
 * brutes a la place des jetons du theme, des libelles a 8-10px, des
 * majuscules espacees partout. Ce test compte ces motifs dans les composants
 * et echoue si leur nombre augmente. Il fonctionne comme un cliquet : quand
 * un nettoyage fait baisser un compteur, baisser aussi le plafond ci-dessous.
 *
 * A la place :
 * - statut        -> text-success / text-warning / text-error (et bg-/border-)
 * - gris          -> text-on-surface(-variant), border-outline-variant, bg-surface-container*
 * - taille        -> text-2xs (11px) au minimum
 * - libelle       -> casse normale, sans tracking-widest
 * - onglets       -> <Tabs> ; filtres -> <FilterPills> ; boutons -> <Button>
 *
 * Les pages au decor sombre impose gardent leurs couleurs : elles sont exclues.
 */
const SRC = join(import.meta.dir, '..');
const DARK_DECOR = new Set([
  'ClanBoardPublic.svelte', 'LevelingClanPublic.svelte', 'GiveawaysPublic.svelte',
  'LevelingPublic.svelte', 'PrestigePublic.svelte', 'MCPSettings.svelte',
  'GlobalInteractionGraph.svelte', 'Activation.svelte', 'Verify.svelte',
  'SanctionEvidenceFile.svelte', 'Config.svelte',
]);

const PATTERNS = {
  /** Texte sous 11px. Restent les pastilles de taille fixe (compteurs, initiales). */
  tinyText: { regex: /text-\[(?:[0-9]|10(?:\.5)?)px\]/g, max: 11 },
  /** Couleur de statut brute la ou un jeton existe. */
  rawStatusColor: {
    regex: /(?<![\w-])(?:[a-z-]+:)*(?:text-(?:emerald|green|amber|yellow|red|rose)-(?:400|500|600|700)|border-(?:emerald|green|amber|yellow|red|rose)-(?:200|300|400|500|600)|bg-(?:emerald|green|amber|yellow|red|rose)-(?:400|500|600)\/\d+)(?![\w-])/g,
    max: 0,
  },
  /** Variante dark: : les jetons portent deja le theme sombre. */
  darkVariant: { regex: /(?<![\w-])dark:/g, max: 81 },
  /** Micro-libelle en majuscules espacees. */
  shoutingLabel: { regex: /uppercase[^"'`\n]*tracking-(?:widest|wider)|tracking-(?:widest|wider)[^"'`\n]*uppercase/g, max: 35 },
  /** Onglet ecrit a la main plutot qu'avec <Tabs>. */
  handMadeTab: { regex: /class="[^"]*\btab-button\b/g, max: 0 },
  /**
   * Texte secondaire attenue sous 80 % : il tombe sous 4,5:1 (AA) sur les
   * fonds clairs comme sombres. Garder la couleur pleine ; /30 et /40 restent
   * pour les icones decoratives et les elements desactives.
   */
  dimSecondaryText: { regex: /text-on-surface-variant\/(?:50|60|70)(?![\w])/g, max: 0 },
} as const;

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'paraglide' || name === 'node_modules') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return svelteFiles(path);
    return name.endsWith('.svelte') && !DARK_DECOR.has(name) ? [path] : [];
  });
}

describe('garde-fou visuel', () => {
  const sources = svelteFiles(SRC)
    // Le composant Tabs est le seul a avoir le droit d'ecrire tab-button.
    .filter((file) => !file.endsWith(join('ui', 'Tabs.svelte')))
    .map((file) => ({ file, text: readFileSync(file, 'utf-8') }));

  test('le garde-fou lit bien les composants', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  for (const [name, { regex, max }] of Object.entries(PATTERNS)) {
    test(`${name} : pas plus de ${max} occurrence(s)`, () => {
      const offenders: string[] = [];
      let total = 0;
      for (const { file, text } of sources) {
        const count = text.match(regex)?.length ?? 0;
        if (count > 0) offenders.push(`${file.slice(SRC.length + 1)} (${count})`);
        total += count;
      }
      if (total > max) {
        throw new Error(`${name} : ${total} > ${max}. Fichiers concernes :\n  ${offenders.join('\n  ')}`);
      }
      expect(total).toBeLessThanOrEqual(max);
    });
  }
});

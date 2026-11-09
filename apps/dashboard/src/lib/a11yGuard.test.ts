import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou d'accessibilite (RGAA), comme uxGuard.test.ts : un cliquet qui ne
 * remonte jamais.
 *
 * - Une fenetre sans nom : le lecteur d'ecran annonce « boite de dialogue »
 *   sans dire laquelle (RGAA 7.1). Passer `title`, ou `ariaLabel` quand
 *   l'en-tete est dessine par le contenu.
 * - `aria-labelledby="modal-title"` en dur : avec deux fenetres ouvertes, l'id est double et
 *   la fenetre du dessus prend le nom de celle du dessous.
 */
const SRC = join(import.meta.dir, '..');

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'paraglide' || name === 'node_modules') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return svelteFiles(path);
    return name.endsWith('.svelte') ? [path] : [];
  });
}

/** Attributs d'une balise ouvrante, en sautant les `>` des expressions (`() => x`). */
function openingTags(text: string, tag: string): string[] {
  const tags: string[] = [];
  const pattern = new RegExp(`<${tag}\\b`, 'g');
  for (const match of text.matchAll(pattern)) {
    let depth = 0;
    let i = match.index + match[0].length;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push(text.slice(match.index, i + 1));
  }
  return tags;
}

describe("garde-fou d'accessibilite", () => {
  const sources = svelteFiles(SRC).map((file) => ({ file: file.slice(SRC.length + 1), text: readFileSync(file, 'utf-8') }));

  test('openingTags saute les fleches des expressions', () => {
    const [tag] = openingTags('<Modal onClose={() => (x = 1)} title="A">corps</Modal>', 'Modal');
    expect(tag).toBe('<Modal onClose={() => (x = 1)} title="A">');
  });

  test('toute Modal a un nom accessible', () => {
    const offenders = sources.flatMap(({ file, text }) =>
      openingTags(text, 'Modal')
        .filter((tag) => !/\b(title|ariaLabel)=|\{(title|ariaLabel)\}/.test(tag) && !/\{\.\.\./.test(tag))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  test('pas d\'aria-labelledby vers un id "modal-title" partage', () => {
    const offenders = sources.filter(({ text }) => /aria-labelledby="modal-title"/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

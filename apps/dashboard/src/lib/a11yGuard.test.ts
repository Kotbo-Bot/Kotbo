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

  test('l\'anneau de focus global couvre tous les roles interactifs (RGAA 10.7)', () => {
    // 651 `outline-none` dans les composants : sans regle globale, un menuitem
    // ou un switch focalise au clavier ne montre rien.
    const css = readFileSync(join(SRC, 'app.css'), 'utf-8');
    const rule = css.match(/:where\(([^)]*(?:\([^)]*\)[^)]*)*)\):focus-visible\s*\{/)?.[1] ?? '';
    const expected = [
      'a', 'button', 'summary', '[tabindex]:not([tabindex="-1"])',
      '[role="tab"]', '[role="button"]', '[role="menuitem"]', '[role="option"]',
      '[role="switch"]', '[role="checkbox"]', '[role="slider"]', '[role="combobox"]',
    ];
    const selectors = rule.split(',').map((s) => s.trim());
    expect(expected.filter((s) => !selectors.includes(s))).toEqual([]);
  });

  test('les boutons d\'epinglage nomment ce qu\'ils epinglent, avec un nom fixe (RGAA 11.9)', () => {
    // « Epingler » repete sur chaque ligne du menu ne dit pas quoi ; et un
    // bouton a bascule garde le meme nom, aria-pressed porte l'etat.
    for (const lang of ['fr', 'en']) {
      const messages = JSON.parse(readFileSync(join(SRC, '..', 'messages', `${lang}.json`), 'utf-8'));
      expect(messages.nav_favorite).toContain('{name}');
    }
    const offenders = sources.filter(({ text }) => /m\.nav_unfavorite\(|m\.nav_favorite\(\)/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test('toute fenetre modale faite main garde le focus (RGAA 7.1, 12.9)', () => {
    // Hors du composant Modal, une fenetre aria-modal laissait Tab partir
    // derriere le voile et ne rendait pas le focus a la fermeture.
    const offenders = sources.flatMap(({ file, text }) =>
      openingTags(text, 'div')
        .filter((tag) => /aria-modal="true"/.test(tag) && !/use:dialogFocus/.test(tag))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  test('toute fenetre a un nom accessible (RGAA 7.1)', () => {
    const offenders = sources.flatMap(({ file, text }) =>
      openingTags(text, 'div')
        .filter((tag) => /role="dialog"/.test(tag) && !/aria-label(ledby)?=/.test(tag))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  test('les graphiques donnent leurs donnees en tableau (RGAA 1.1, 1.10)', () => {
    // Un canvas Chart.js est muet pour un lecteur d'ecran : il est masque, et
    // le tableau des memes donnees prend le relais.
    const chart = sources.find(({ file }) => file.endsWith('charts/Chart.svelte'))?.text ?? '';
    expect(openingTags(chart, 'canvas').every((tag) => /aria-hidden="true"/.test(tag))).toBe(true);
    expect(chart).toContain('chartTable(');
    expect(chart).toContain('<table');
  });

  test('role="combobox" sur le champ de saisie, pas sur son cadre (RGAA 11.1)', () => {
    // Pose sur un div, le role faisait deux arrets de Tab, et le `for` du
    // label visait le div au lieu du champ : le champ restait sans etiquette.
    const offenders = sources.flatMap(({ file, text }) =>
      ['div', 'span', 'button']
        .flatMap((tag) => openingTags(text, tag))
        .filter((tag) => /role="combobox"/.test(tag))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  test('pas d\'aria-labelledby vers un id "modal-title" partage', () => {
    const offenders = sources.filter(({ text }) => /aria-labelledby="modal-title"/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

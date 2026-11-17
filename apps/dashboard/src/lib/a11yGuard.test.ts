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

  test('pas de nom accessible ecrit en dur hors back-office (RGAA 8.7)', () => {
    // Un aria-label en francais reste en francais pour un lecteur d'ecran en
    // anglais ; le garde-fou i18n ne le voit pas sans lettre accentuee.
    const offenders = sources
      .filter(({ file }) => !file.includes('admin/'))
      .flatMap(({ file, text }) =>
        [...text.matchAll(/\baria-label="([^"]*)"/g)]
          .filter(([, value]) => /\p{L}/u.test(value.replace(/\{[^}]*\}/g, '')))
          .map(([attr]) => `${file}: ${attr}`),
      );
    expect(offenders).toEqual([]);
  });

  test('pas de alt generique qui double le nom affiche a cote (RGAA 1.2)', () => {
    const offenders = sources.filter(({ text }) => /\balt="(Avatar|Server Logo|Logo)"/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test('un champ qui retire son contour de focus en affiche un autre (RGAA 10.7)', () => {
    // La regle globale de app.css couvre liens, boutons et roles, pas les
    // champs : un `outline-none` sans remplacement laissait le champ focalise
    // identique aux autres.
    const REMOVES = /(?:^|[\s"'{`])(?:focus:)?outline-(?:none|hidden)\b/;
    const REPLACES = /focus(?:-visible|-within)?:(?:ring|border|outline-(?!none|hidden)|shadow|bg)|class="(?:[^"]*\s)?input(?:\s[^"]*)?"/;
    const offenders = sources.flatMap(({ file, text }) =>
      ['input', 'textarea', 'select']
        .flatMap((tag) => openingTags(text, tag))
        .filter((tag) => !/type="hidden"/.test(tag) && REMOVES.test(tag) && !REPLACES.test(tag))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  test('les champs ont une etiquette accessible (RGAA 11.1)', () => {
    // Un placeholder n'est pas une etiquette : il disparait a la saisie et
    // n'est pas toujours lu. Un champ est etiquete par aria-label(ledby), par
    // un <label for> vers son id, ou en etant dans un <label>. Les composants
    // d'emballage recoivent leur etiquette de l'appelant.
    const WRAPPERS = new Set([
      'lib/components/FormInput.svelte',
      'lib/components/FormSelect.svelte',
      'lib/components/FormTextarea.svelte',
      'lib/components/MultiSelect.svelte',
    ]);
    const unlabeled = sources.flatMap(({ file, text }) => {
      // `labelFor` (SettingsRow) et l'`id` d'un <Field> posent eux-memes le <label for>.
      const fors = new Set(
        [...text.matchAll(/(?:\bfor|\blabelFor|<Field\b[^>]*?\bid)=(?:"([^"]+)"|\{([^}]+)\})/g)].map((m) => m[1] || m[2]),
      );
      const tags = ['FormInput', 'FormSelect', 'FormTextarea', ...(WRAPPERS.has(file) ? [] : ['input', 'textarea', 'select'])];
      return tags.flatMap((tag) => {
        const found: string[] = [];
        let from = 0;
        for (const opening of openingTags(text, tag)) {
          const index = text.indexOf(opening, from);
          from = index + opening.length;
          if (/type="(hidden|submit|button|reset|image)"/.test(opening)) continue;
          // Masque (class hidden) : hors de l'arbre d'accessibilite, declenche par un bouton.
          if (/\bhidden\b(?!-)/.test(opening.match(/class="([^"]*)"/)?.[1] ?? '') || /\shidden[\s/>]|aria-hidden="true"|display:\s*none/.test(opening)) continue;
          if (/aria-label(ledby)?=|\bariaLabel=|\{ariaLabel\}|\blabel=|\{\.\.\./.test(opening)) continue;
          const id = opening.match(/\bid=(?:"([^"]+)"|\{([^}]+)\})|\{id\}/);
          if (id && (fors.has(id[1] || id[2] || 'id') || !(id[1] || id[2]))) continue;
          const before = text.slice(0, index);
          if ((before.match(/<label\b/g) ?? []).length > (before.match(/<\/label>/g) ?? []).length) continue;
          found.push(`${file}:${before.split('\n').length}`);
        }
        return found;
      });
    });
    expect(unlabeled).toEqual([]);
  });

  test('l\'aide ou l\'erreur d\'un <Field> est reliee a son controle (RGAA 11.2)', () => {
    // Field fournit `describedBy` a son contenu ; s'il n'est pas pose sur le
    // controle, l'aide s'affiche mais un lecteur d'ecran ne la lit pas.
    const offenders = sources.flatMap(({ file, text }) =>
      openingTags(text, 'Field')
        .filter((tag) => !tag.endsWith('/>') && /\b(hint|error)=/.test(tag))
        .filter((tag) => {
          const start = text.indexOf(tag) + tag.length;
          const body = text.slice(start, text.indexOf('</Field>', start));
          return !/aria-describedby|describedBy/.test(body);
        })
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  test('la liste de MultiSelect ne contient que des options (RGAA 7.1)', () => {
    // Un listbox ne porte que des role="option" : le message « aucun resultat »
    // y etait lu comme un element de liste.
    const text = sources.find(({ file }) => file.endsWith('components/MultiSelect.svelte'))?.text ?? '';
    const start = text.indexOf('role="listbox"');
    const listbox = text.slice(start, text.indexOf('{/each}', start));
    expect(start).toBeGreaterThan(-1);
    expect(listbox).not.toContain('d4_no_result_for');
  });

  const fileText = (suffix: string) => sources.find(({ file }) => file.endsWith(suffix))?.text ?? '';

  test('les icones Papicon sont decoratives (RGAA 1.2)', () => {
    // Aucun appel ne leur donne de nom : c'est le bouton ou le texte voisin qui
    // porte le sens. Sans aria-hidden, chaque svg est annonce comme une image vide.
    const papicon = fileText('components/Papicon.svelte');
    expect(openingTags(papicon, 'svg').every((tag) => /aria-hidden="true"/.test(tag))).toBe(true);
    expect(openingTags(papicon, 'LucideComponent').every((tag) => /aria-hidden="true"/.test(tag))).toBe(true);
  });

  test('une seule zone <main> par page (RGAA 12.6)', () => {
    // MainLayout porte le <main> ; une page rendue dedans n'en ouvre pas un second.
    const OWN_MAIN = [
      'lib/components/MainLayout.svelte',
      'lib/components/admin/AdminShell.svelte',
      'lib/components/onboarding/WizardShell.svelte',
      'pages/Activation.svelte',
      'pages/Login.svelte',
      'pages/MemberSpace.svelte',
      'pages/SanctionEvidenceFile.svelte',
    ];
    const offenders = sources
      .filter(({ file, text }) => !OWN_MAIN.includes(file) && openingTags(text, 'main').length > 0)
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test('les tuiles de MetricTabs sont des boutons radio, pas des onglets sans panneau (RGAA 7.1)', () => {
    const tabs = fileText('analytics/MetricTabs.svelte');
    expect(tabs).not.toContain('role="tab"');
    expect(tabs).toContain('role="radiogroup"');
    expect(tabs).toContain('role="radio"');
  });

  test('des tuiles sans effet ne sont pas cliquables (RGAA 7.1)', () => {
    // onchange vide : le bouton ne fait rien, il doit etre affiche en simples chiffres.
    const offenders = sources.flatMap(({ file, text }) =>
      openingTags(text, 'MetricTabs')
        .filter((tag) => /onchange=\{\(\) => \{\}\}/.test(tag) && !/interactive=\{false\}/.test(tag))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  test('texte d\'etat sur fond teinte : jeton on-*-container (RGAA 3.2)', () => {
    // text-warning sur bg-warning/15 : 4,08:1 en theme clair. Les jetons
    // on-*-container passent 4,5:1 sur ces fonds dans les deux themes.
    const offenders = sources.flatMap(({ file, text }) =>
      // Toute chaine sur une ligne : class="...", ternaires, tables de statut.
      [...text.matchAll(/(['`"])((?:(?!\1)[^\n])*)\1/g)]
        .map((m) => m[2])
        .filter((cls) =>
          ['warning', 'success', 'error'].some(
            (c) => new RegExp(`(^|\\s)bg-${c}/\\d+`).test(cls) && new RegExp(`(^|\\s)text-${c}(?![\\w/-])`).test(cls),
          ),
        )
        .map((cls) => `${file}: ${cls.slice(0, 60)}`),
    );
    expect(offenders).toEqual([]);
  });

  test('le nom accessible contient le texte visible (RGAA 7.1, 11.9)', () => {
    // Recherche du menu : texte visible « Rechercher », nom « Rechercher une page ».
    const sidebar = fileText('components/Sidebar.svelte');
    const search = openingTags(sidebar, 'button').find((tag) => tag.includes('nav-search')) ?? '';
    expect(search).toContain('aria-label={isCollapsed ? m.nav_search_pages() : undefined}');
    // Profil : le nom commence par le pseudo affiche.
    const navbar = fileText('components/Navbar.svelte');
    const profile = openingTags(navbar, 'button').find((tag) => tag.includes('app-navbar__profile')) ?? '';
    expect(profile).toContain('m.nbx_open_profile_named(');
  });

  test('les tableaux de donnees ont un titre (RGAA 5.4) : cliquet', () => {
    // Plafond : il ne remonte jamais, le baisser quand un tableau recoit son titre.
    const CEILING = 64;
    const untitled = sources.flatMap(({ file, text }) => {
      let from = 0;
      return openingTags(text, 'table').flatMap((tag) => {
        const index = text.indexOf(tag, from);
        from = index + tag.length;
        const after = text.slice(from, from + 300);
        const titled = /aria-label(ledby)?=/.test(tag) || /^\s*(<!--[\s\S]*?-->\s*)*<caption/.test(after);
        return titled ? [] : [`${file}:${text.slice(0, index).split('\n').length}`];
      });
    });
    expect(untitled.length).toBeLessThanOrEqual(CEILING);
    expect(untitled.some((at) => at.startsWith('pages/Sanctions.svelte'))).toBe(false);
  });

  test('pas d\'aria-labelledby vers un id "modal-title" partage', () => {
    const offenders = sources.filter(({ text }) => /aria-labelledby="modal-title"/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

// Le routeur est le vrai tinro : il écoute les clics sur window sans regarder
// `defaultPrevented`, ce qu'une doublure de `router.goto` ne verrait pas. Seuls
// les stores `.svelte.ts`, en runes que bun ne compile pas, sont doublés.

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'https://dashboard.test/settings',
  // Un Ctrl+clic non intercepté déclenche la navigation par défaut, que jsdom
  // ne sait pas faire : on tait son avertissement.
  virtualConsole: new VirtualConsole(),
});
const win = dom.window;
const g = globalThis as Record<string, unknown>;
const globauxAvant = new Map(
  ['window', 'document', 'history', 'location', 'addEventListener', 'removeEventListener'].map((cle) => [cle, g[cle]]),
);
g.window = win;
g.document = win.document;
g.history = win.history;
g.location = win.location;
// tinro s'abonne aux clics par un `addEventListener` nu : celui de la fenêtre.
g.addEventListener = win.addEventListener.bind(win);
g.removeEventListener = win.removeEventListener.bind(win);

const { router } = await import('tinro/dist/tinro_lib.js');
mock.module('tinro', () => ({ router }));

const unsavedChanges = {
  isDirty: false,
  pageLabel: 'Réglages',
  canNavigate() {
    return !this.isDirty;
  },
  clear() {
    this.isDirty = false;
  },
};
let repondre: (confirme: boolean) => void = () => {};
const confirmDialog = {
  ask: mock(() => new Promise<boolean>((resolve) => { repondre = resolve; })),
};
mock.module(path.resolve(import.meta.dir, 'stores/unsavedChanges.svelte.ts'), () => ({ unsavedChanges }));
mock.module(path.resolve(import.meta.dir, 'stores/confirmDialog.svelte.ts'), () => ({ confirmDialog }));

const { guardedLinkClick, guardedNavigate } = await import('./navigationGuard');

// Comme dans l'application, tinro n'écoute les clics que tant que son store est observé.
const arreterRouteur = router.subscribe(() => {});

// Svelte 5 délègue `onclick` au conteneur de l'application : c'est là que tourne
// le gestionnaire du lien, avant que le clic ne remonte jusqu'à window.
const app = win.document.getElementById('app')!;
app.addEventListener('click', (event) => {
  const lien = (event.target as Element).closest('a[href]');
  if (lien) guardedLinkClick(event as unknown as MouseEvent, lien.getAttribute('href')!);
});

afterAll(() => {
  arreterRouteur();
  for (const [cle, valeur] of globauxAvant) {
    if (valeur === undefined) delete g[cle];
    else g[cle] = valeur;
  }
});

/** Un lien interne du bureau, tel que la barre latérale le rend. */
function lien(href: string): Element {
  app.innerHTML = `<nav><a href="${href}">Aller</a></nav>`;
  return app.querySelector('a')!;
}

function cliquer(element: Element, options: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options });
  element.dispatchEvent(event);
  return event;
}

const laisserRepondre = () => new Promise((resolve) => setTimeout(resolve, 0));
const page = () => win.location.pathname;

beforeEach(() => {
  win.history.replaceState({}, '', '/settings');
  unsavedChanges.isDirty = false;
  confirmDialog.ask.mockClear();
  repondre = () => {};
});

describe('lien du bureau sur une page aux modifications non enregistrées', () => {
  test('le clic demande confirmation et la page ne change pas avant la réponse', () => {
    unsavedChanges.isDirty = true;

    cliquer(lien('/members'));

    expect(confirmDialog.ask).toHaveBeenCalledTimes(1);
    expect(page()).toBe('/settings');
  });

  test('refuser garde la page et ses modifications', async () => {
    unsavedChanges.isDirty = true;

    cliquer(lien('/members'));
    repondre(false);
    await laisserRepondre();

    expect(page()).toBe('/settings');
    expect(unsavedChanges.isDirty).toBe(true);
  });

  test('confirmer abandonne les modifications puis change de page, une seule fois', async () => {
    unsavedChanges.isDirty = true;
    const historique = win.history.length;

    cliquer(lien('/members'));
    repondre(true);
    await laisserRepondre();

    expect(page()).toBe('/members');
    expect(unsavedChanges.isDirty).toBe(false);
    expect(win.history.length).toBe(historique + 1);
  });
});

describe('lien du bureau sans modification en attente', () => {
  test('la page change sans confirmation, avec une seule entrée d\'historique', () => {
    const historique = win.history.length;

    cliquer(lien('/members'));

    expect(confirmDialog.ask).not.toHaveBeenCalled();
    expect(page()).toBe('/members');
    // Deux entrées pour une même page : « Précédent » semblerait ne rien faire.
    expect(win.history.length).toBe(historique + 1);
  });
});

describe('ouverture dans un nouvel onglet', () => {
  test('Ctrl+clic et Cmd+clic restent au navigateur, sans confirmation', () => {
    unsavedChanges.isDirty = true;

    const ctrl = cliquer(lien('/members'), { ctrlKey: true });
    const cmd = cliquer(lien('/members'), { metaKey: true });

    expect(ctrl.defaultPrevented).toBe(false);
    expect(cmd.defaultPrevented).toBe(false);
    expect(confirmDialog.ask).not.toHaveBeenCalled();
    expect(page()).toBe('/settings');
  });
});

describe('navigation de la palette de commandes', () => {
  test('page aux modifications non enregistrées : on ne part qu\'après confirmation', async () => {
    unsavedChanges.isDirty = true;

    const navigation = guardedNavigate('/logs');
    expect(confirmDialog.ask).toHaveBeenCalledTimes(1);
    expect(page()).toBe('/settings');

    repondre(true);
    await navigation;
    expect(page()).toBe('/logs');
  });

  test('refuser laisse la page en place', async () => {
    unsavedChanges.isDirty = true;

    const navigation = guardedNavigate('/logs');
    repondre(false);
    await navigation;

    expect(page()).toBe('/settings');
    expect(unsavedChanges.isDirty).toBe(true);
  });

  test('sans modification en attente, la navigation est immédiate', async () => {
    await guardedNavigate('/logs');

    expect(confirmDialog.ask).not.toHaveBeenCalled();
    expect(page()).toBe('/logs');
  });
});

/**
 * Le câblage dans les composants, faute de harnais de rendu Svelte, se lit dans
 * la source comme les autres gardes du dépôt (channelsManagementGuard…).
 */
describe('câblage du bureau', () => {
  const SRC = path.join(import.meta.dir, 'components');
  const lire = (fichier: string) => readFileSync(path.join(SRC, fichier), 'utf-8');

  /** Balises ouvrantes `<a …>` ; le `=>` d'un gestionnaire ne ferme pas la balise. */
  function balisesLien(source: string): string[] {
    const balises: string[] = [];
    for (const ouverture of source.matchAll(/<a\s/g)) {
      let profondeur = 0;
      let guillemet: string | null = null;
      for (let i = ouverture.index + 2; i < source.length; i++) {
        const c = source[i];
        if (guillemet) {
          if (c === guillemet) guillemet = null;
        } else if (profondeur === 0 && (c === '"' || c === "'")) {
          guillemet = c;
        } else if (c === '{') {
          profondeur++;
        } else if (c === '}') {
          profondeur--;
        } else if (c === '>' && profondeur === 0) {
          balises.push(source.slice(ouverture.index, i + 1));
          break;
        }
      }
    }
    return balises;
  }

  /** Lien vers une page du dashboard, que tinro intercepterait. */
  function estInterne(balise: string): boolean {
    const litteral = balise.match(/\shref="([^"]*)"/);
    if (litteral) return litteral[1].startsWith('/') && !litteral[1].startsWith('//');
    return /\shref=\{|\s\{href\}/.test(balise);
  }

  test.each(['Sidebar.svelte', 'Breadcrumbs.svelte'])('%s : chaque lien interne passe par la garde', (fichier) => {
    const liens = balisesLien(lire(fichier)).filter(estInterne);

    expect(liens.length).toBeGreaterThan(0);
    expect(liens.filter((balise) => !/onclick=\{\(e\) => guardedLinkClick\(e, /.test(balise))).toEqual([]);
  });

  test('la palette de commandes ne navigue que par la garde', () => {
    const source = lire('CommandPalette.svelte');

    expect(source).not.toMatch(/router\.goto\(/);
    expect(source).toContain('guardedNavigate(');
  });
});

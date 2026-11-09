import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

let pageTitle: typeof import('./pageFocus').pageTitle;
let focusMainAfterNavigation: typeof import('./pageFocus').focusMainAfterNavigation;
let doc: Document;

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element']) {
    g[key] ??= (dom.window as unknown as Record<string, unknown>)[key];
  }
  doc = g.document as Document;
  ({ pageTitle, focusMainAfterNavigation } = await import('./pageFocus'));
});

describe('pageTitle', () => {
  test('nomme la page avant la marque (RGAA 8.6)', () => {
    expect(pageTitle('Membres', 'Kotbo')).toBe('Membres - Kotbo');
  });

  test('sans page connue, la marque seule', () => {
    expect(pageTitle('', 'Kotbo')).toBe('Kotbo');
  });
});

describe('focusMainAfterNavigation', () => {
  let main: HTMLElement;

  beforeEach(() => {
    doc.body.innerHTML = `
      <nav><a id="link" href="/members">Membres</a></nav>
      <main id="main-content"><button id="tab">Onglet</button></main>
      <div role="dialog"><input id="search" /></div>`;
    main = doc.getElementById('main-content') as HTMLElement;
  });

  test('un lien du menu : le focus part sur le contenu', () => {
    (doc.getElementById('link') as HTMLElement).focus();
    focusMainAfterNavigation(main);
    expect(doc.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  test('focus perdu (element retire) : le focus part sur le contenu', () => {
    focusMainAfterNavigation(main);
    expect(doc.activeElement).toBe(main);
  });

  test('un onglet de la page : le focus reste dessus', () => {
    const tab = doc.getElementById('tab') as HTMLElement;
    tab.focus();
    focusMainAfterNavigation(main);
    expect(doc.activeElement).toBe(tab);
  });

  test("une fenetre encore ouverte garde le focus", () => {
    const search = doc.getElementById('search') as HTMLElement;
    search.focus();
    focusMainAfterNavigation(main);
    expect(doc.activeElement).toBe(search);
  });
});

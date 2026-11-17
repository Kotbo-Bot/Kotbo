import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

let withBase: typeof import('./demoLinks').withBase;
let installDemoLinks: typeof import('./demoLinks').installDemoLinks;
let win: Window & typeof globalThis;
let doc: Document;
let uninstall: () => void = () => {};

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://kotbo.fr/demo/' });
  win = dom.window as unknown as Window & typeof globalThis;
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'MouseEvent']) {
    g[key] ??= (dom.window as unknown as Record<string, unknown>)[key];
  }
  doc = win.document;
  ({ withBase, installDemoLinks } = await import('./demoLinks'));
});

afterEach(() => {
  uninstall();
  doc.body.innerHTML = '';
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('withBase', () => {
  test('prefixe un chemin interne', () => {
    expect(withBase('/members', '/demo')).toBe('/demo/members');
    expect(withBase('/', '/demo')).toBe('/demo/');
  });

  test('laisse les liens deja prefixes, externes ou relatifs', () => {
    expect(withBase('/demo/members', '/demo')).toBeNull();
    expect(withBase('/demo', '/demo')).toBeNull();
    expect(withBase('https://discord.com', '/demo')).toBeNull();
    expect(withBase('//cdn.discordapp.com/x.png', '/demo')).toBeNull();
    expect(withBase('#main-content', '/demo')).toBeNull();
  });

  test('ne confond pas /demographie avec la base', () => {
    expect(withBase('/demographie', '/demo')).toBe('/demo/demographie');
  });
});

describe('installDemoLinks', () => {
  test('les liens presents et ajoutes ensuite pointent sous /demo (nouvel onglet, copie)', async () => {
    doc.body.innerHTML = '<a id="a" href="/members">Membres</a>';
    uninstall = installDemoLinks('/demo', doc);
    expect(doc.getElementById('a')!.getAttribute('href')).toBe('/demo/members');

    doc.body.insertAdjacentHTML('beforeend', '<a id="b" href="/logs">Logs</a>');
    await tick();
    expect(doc.getElementById('b')!.getAttribute('href')).toBe('/demo/logs');
  });

  test('au clic, le routeur lit le chemin sans prefixe, puis le prefixe revient', async () => {
    doc.body.innerHTML = '<a id="a" href="/members">Membres</a>';
    uninstall = installDemoLinks('/demo', doc);
    let seenByRouter = '';
    // Le routeur ecoute le clic sur window, en phase de remontee.
    const router = (event: Event) => {
      seenByRouter = (event.target as Element).closest('a')!.getAttribute('href')!;
      event.preventDefault();
    };
    win.addEventListener('click', router);
    doc.getElementById('a')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    win.removeEventListener('click', router);

    expect(seenByRouter).toBe('/members');
    await tick();
    expect(doc.getElementById('a')!.getAttribute('href')).toBe('/demo/members');
  });

  test('Ctrl+clic : le navigateur ouvre le lien prefixe', () => {
    doc.body.innerHTML = '<a id="a" href="/members">Membres</a>';
    uninstall = installDemoLinks('/demo', doc);
    let seen = '';
    const listener = (event: Event) => {
      seen = (event.target as Element).closest('a')!.getAttribute('href')!;
      event.preventDefault();
    };
    win.addEventListener('click', listener);
    doc.getElementById('a')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    win.removeEventListener('click', listener);
    expect(seen).toBe('/demo/members');
  });

  test('une fois desinstalle, plus rien ne change', async () => {
    uninstall = installDemoLinks('/demo', doc);
    uninstall();
    doc.body.innerHTML = '<a id="a" href="/members">Membres</a>';
    await tick();
    expect(doc.getElementById('a')!.getAttribute('href')).toBe('/members');
  });
});

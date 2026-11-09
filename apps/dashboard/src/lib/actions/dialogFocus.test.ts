import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';

let dialogFocus: typeof import('./dialogFocus').dialogFocus;
let doc: Document;

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'KeyboardEvent']) {
    g[key] ??= (dom.window as unknown as Record<string, unknown>)[key];
  }
  g.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
  doc = g.document as Document;
  ({ dialogFocus } = await import('./dialogFocus'));
});

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 5));

function press(target: HTMLElement, key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function setup(inner = '<button id="a">A</button><input id="b" /><button id="c">C</button>') {
  doc.body.innerHTML = `<button id="trigger">Ouvrir</button><div id="panel" tabindex="-1">${inner}</div>`;
  const trigger = doc.getElementById('trigger') as HTMLElement;
  const panel = doc.getElementById('panel') as HTMLElement;
  trigger.focus();
  return { trigger, panel };
}

describe('dialogFocus', () => {
  beforeEach(() => {
    doc.body.innerHTML = '';
  });

  test("le focus entre dans la fenetre a l'ouverture", async () => {
    const { panel } = setup();
    dialogFocus(panel, {});
    await nextFrame();
    expect(doc.activeElement).toBe(panel);
  });

  test('un champ deja focalise (autofocus) garde le focus', async () => {
    const { panel } = setup();
    dialogFocus(panel, {});
    (doc.getElementById('b') as HTMLElement).focus();
    await nextFrame();
    expect(doc.activeElement?.id).toBe('b');
  });

  test('le focus revient au declencheur a la fermeture', async () => {
    const { trigger, panel } = setup();
    const action = dialogFocus(panel, {});
    await nextFrame();
    action.destroy();
    expect(doc.activeElement).toBe(trigger);
  });

  test("Tab sur le dernier element revient au premier", async () => {
    const { panel } = setup();
    dialogFocus(panel, {});
    const last = doc.getElementById('c') as HTMLElement;
    last.focus();
    const event = press(last, 'Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(doc.activeElement?.id).toBe('a');
  });

  test('Maj+Tab sur le premier element (ou le panneau) va au dernier', async () => {
    const { panel } = setup();
    dialogFocus(panel, {});
    await nextFrame();
    press(panel, 'Tab', true);
    expect(doc.activeElement?.id).toBe('c');
    const first = doc.getElementById('a') as HTMLElement;
    first.focus();
    press(first, 'Tab', true);
    expect(doc.activeElement?.id).toBe('c');
  });

  test('les elements desactives ou caches sont ignores', async () => {
    const { panel } = setup('<button id="a">A</button><button id="c">C</button><button id="d" disabled>D</button><button id="e" hidden>E</button>');
    dialogFocus(panel, {});
    const last = doc.getElementById('c') as HTMLElement;
    last.focus();
    press(last, 'Tab');
    expect(doc.activeElement?.id).toBe('a');
  });

  test('Echap appelle onEscape', () => {
    const { panel } = setup();
    const onEscape = mock(() => {});
    dialogFocus(panel, { onEscape });
    press(doc.getElementById('a') as HTMLElement, 'Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("Echap deja traite par un controle interne (liste deroulante) ne ferme pas", () => {
    const { panel } = setup();
    const onEscape = mock(() => {});
    dialogFocus(panel, { onEscape });
    const input = doc.getElementById('b') as HTMLElement;
    input.addEventListener('keydown', (e) => e.preventDefault());
    press(input, 'Escape');
    expect(onEscape).not.toHaveBeenCalled();
  });

  test('sans onEscape, Echap ne fait rien', () => {
    const { panel } = setup();
    dialogFocus(panel, {});
    const event = press(panel, 'Escape');
    expect(event.defaultPrevented).toBe(false);
  });

  test('update remplace le gestionnaire Echap', () => {
    const { panel } = setup();
    const first = mock(() => {});
    const second = mock(() => {});
    const action = dialogFocus(panel, { onEscape: first });
    action.update({ onEscape: second });
    press(panel, 'Escape');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

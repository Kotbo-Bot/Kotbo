/**
 * Opérations sur les sections et les blocs : le document doit toujours
 * rester doc > section+ > column+ > bloc+, et rien ne doit se perdre.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { Editor as EditorType, JSONContent } from '@tiptap/core';

let Editor: typeof import('@tiptap/core').Editor;
let commands: typeof import('./sectionCommands');
let nodes: typeof import('./siteNodes');
let StarterKit: typeof import('@tiptap/starter-kit').default;

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'getComputedStyle', 'DOMParser', 'DragEvent']) {
    g[key] ??= (dom.window as unknown as Record<string, unknown>)[key];
  }
  g.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  ({ Editor } = await import('@tiptap/core'));
  StarterKit = (await import('@tiptap/starter-kit')).default;
  commands = await import('./sectionCommands');
  nodes = await import('./siteNodes');
});

const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const col = (...content: JSONContent[]): JSONContent => ({ type: 'column', content });
const sec = (layout: string, ...columns: JSONContent[]): JSONContent => ({ type: 'section', attrs: { layout }, content: columns });

function make(content: JSONContent[]): EditorType {
  return new Editor({
    extensions: [StarterKit.configure({ document: false }), nodes.SiteDocumentNode, nodes.Section, nodes.Column, nodes.SiteNodesBridge],
    content: { type: 'doc', content },
  });
}

/** Textes de chaque colonne de chaque section : [[["a"], ["b"]], …]. */
function shape(editor: EditorType): string[][][] {
  const json = editor.getJSON();
  return (json.content ?? []).map((s) => (s.content ?? []).map((c) => (c.content ?? []).map((b) => (b.content ?? []).map((t) => t.text).join(''))));
}

const posOfText = (editor: EditorType, text: string) => {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos;
    return found < 0;
  });
  return found;
};

describe('disposition', () => {
  test('moins de colonnes : le contenu des colonnes en trop passe dans la dernière gardée', () => {
    const editor = make([sec('1-1-1', col(p('a')), col(p('b')), col(p('c')))]);
    commands.setSectionLayout(editor, 0, '1-1');
    expect(shape(editor)).toEqual([[['a'], ['b', 'c']]]);
    expect(editor.state.doc.child(0).attrs.layout).toBe('1-1');
  });

  test('plus de colonnes : des colonnes vides s\'ajoutent', () => {
    const editor = make([sec('1', col(p('a')))]);
    commands.setSectionLayout(editor, 0, '1-1-1');
    expect(shape(editor)).toEqual([[['a'], [''], ['']]]);
  });
});

describe('blocs', () => {
  test('vers la colonne voisine : la colonne vidée garde un paragraphe vide', () => {
    const editor = make([sec('1-1', col(p('a')), col(p('b')))]);
    commands.moveBlock(editor, posOfText(editor, 'a'), 'right');
    expect(shape(editor)).toEqual([[[''], ['b', 'a']]]);
  });

  test('en haut de sa colonne, un bloc monte dans la section précédente', () => {
    const editor = make([sec('1', col(p('a'))), sec('1', col(p('b'), p('c')))]);
    commands.moveBlock(editor, posOfText(editor, 'b'), 'up');
    expect(shape(editor)).toEqual([[['a', 'b']], [['c']]]);
  });

  test('descendre dans sa colonne', () => {
    const editor = make([sec('1', col(p('a'), p('b')))]);
    commands.moveBlock(editor, posOfText(editor, 'a'), 'down');
    expect(shape(editor)).toEqual([[['b', 'a']]]);
  });
});

describe('sections', () => {
  test('monter, dupliquer, supprimer', () => {
    const editor = make([sec('1', col(p('a'))), sec('1', col(p('b')))]);
    const second = editor.state.doc.child(0).nodeSize;
    commands.moveSection(editor, second, -1);
    expect(shape(editor)).toEqual([[['b']], [['a']]]);
    commands.duplicateSection(editor, 0);
    expect(shape(editor)).toEqual([[['b']], [['b']], [['a']]]);
    commands.deleteSection(editor, 0);
    expect(shape(editor)).toEqual([[['b']], [['a']]]);
  });

  test('la dernière section n\'est jamais retirée, elle est vidée', () => {
    const editor = make([sec('1-1', col(p('a')), col(p('b')))]);
    commands.deleteSection(editor, 0);
    expect(shape(editor)).toEqual([[['']]]);
  });

  test('insertion après la section courante', () => {
    const editor = make([sec('1', col(p('a'))), sec('1', col(p('c')))]);
    commands.insertSection(editor, sec('1', col(p('b'))), posOfText(editor, 'a'));
    expect(shape(editor)).toEqual([[['a']], [['b']], [['c']]]);
  });
});

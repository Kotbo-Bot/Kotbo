/**
 * Opérations de l'éditeur sur les sections et les blocs : repérer, déplacer,
 * dupliquer, supprimer, régler. Le document est toujours
 * doc > section+ > column+ > bloc+ : chaque opération garde cette forme (une
 * colonne vidée reçoit un paragraphe vide, la dernière section n'est jamais
 * retirée). Tout passe par des transactions : l'édition à plusieurs suit.
 */
import type { Editor, JSONContent } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { SITE_SECTION_DEFAULTS, type SiteSectionLayout } from '@kotbo/shared';

export interface SectionRef {
  pos: number;
  index: number;
  node: PMNode;
}

export interface BlockRef {
  pos: number;
  node: PMNode;
  section: SectionRef;
  columnIndex: number;
  columnPos: number;
  /** Rang du bloc dans sa colonne. */
  index: number;
}

/** Section qui contient `pos` (ou qui commence à `pos`). */
export function sectionAt(doc: PMNode, pos: number): SectionRef | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.depth === 0) {
    const node = $pos.nodeAfter;
    return node?.type.name === 'section' ? { pos, index: $pos.index(0), node } : null;
  }
  const node = $pos.node(1);
  return node.type.name === 'section' ? { pos: $pos.before(1), index: $pos.index(0), node } : null;
}

/** Bloc de premier niveau d'une colonne qui contient `pos` (ou qui commence à `pos`). */
export function blockAt(doc: PMNode, pos: number): BlockRef | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  let blockPos: number;
  let node: PMNode | null;
  if ($pos.depth >= 3) {
    blockPos = $pos.before(3);
    node = $pos.node(3);
  } else if ($pos.depth === 2) {
    blockPos = pos;
    node = $pos.nodeAfter;
  } else {
    return null;
  }
  if (!node) return null;
  const $block = doc.resolve(blockPos);
  if ($block.parent.type.name !== 'column') return null;
  const section = sectionAt(doc, blockPos);
  if (!section) return null;
  return { pos: blockPos, node, section, columnIndex: $block.index(1), columnPos: $block.before(2), index: $block.index(2) };
}

/** Position de début de la colonne n°`columnIndex` d'une section. */
function columnStart(section: SectionRef, columnIndex: number): number {
  let pos = section.pos + 1;
  for (let i = 0; i < columnIndex; i += 1) pos += section.node.child(i).nodeSize;
  return pos;
}

/**
 * Retire le nœud à `from`. Seul dans son parent, il est remplacé par ce qui
 * garde le schéma valide (paragraphe vide dans une colonne, section vide).
 */
function removeAt(state: EditorState, tr: Transaction, from: number): void {
  const node = tr.doc.nodeAt(from);
  if (!node) return;
  const $from = tr.doc.resolve(from);
  if ($from.parent.childCount > 1) {
    tr.delete(from, from + node.nodeSize);
  } else if (node.type.name === 'section') {
    tr.replaceWith(from, from + node.nodeSize, emptySection(state));
  } else {
    tr.replaceWith(from, from + node.nodeSize, state.schema.nodes.paragraph.create());
  }
}

function emptySection(state: EditorState, attrs: Record<string, unknown> = {}): PMNode {
  return state.schema.nodes.section.create({ ...SITE_SECTION_DEFAULTS, ...attrs }, state.schema.nodes.column.createAndFill()!);
}

/** Déplace le nœud à `from` vers `to` (position dans le document avant le déplacement). */
function moveNode(editor: Editor, from: number, to: number): boolean {
  return editor
    .chain()
    .command(({ tr, state }) => {
      const node = tr.doc.nodeAt(from);
      if (!node) return false;
      removeAt(state, tr, from);
      const target = tr.mapping.map(to);
      tr.insert(target, node);
      tr.setSelection(NodeSelection.create(tr.doc, target));
      return true;
    })
    .run();
}

// ─── Sections ───────────────────────────────────────────────────────────────

export function moveSection(editor: Editor, pos: number, direction: -1 | 1): boolean {
  const doc = editor.state.doc;
  const section = sectionAt(doc, pos);
  if (!section) return false;
  const targetIndex = section.index + direction;
  if (targetIndex < 0 || targetIndex >= doc.childCount) return false;
  const neighbour = doc.child(targetIndex);
  // Vers le haut : avant la voisine ; vers le bas : après elle.
  const to = direction < 0 ? section.pos - neighbour.nodeSize : section.pos + section.node.nodeSize + neighbour.nodeSize;
  return moveNode(editor, section.pos, to);
}

export function duplicateSection(editor: Editor, pos: number): boolean {
  const section = sectionAt(editor.state.doc, pos);
  if (!section) return false;
  const at = section.pos + section.node.nodeSize;
  // L'ancre doit rester unique : la copie n'en a pas.
  const copy = section.node.type.create({ ...section.node.attrs, anchor: '' }, section.node.content);
  return editor.chain().command(({ tr }) => {
    tr.insert(at, copy);
    tr.setSelection(NodeSelection.create(tr.doc, at));
    return true;
  }).run();
}

export function deleteSection(editor: Editor, pos: number): boolean {
  const section = sectionAt(editor.state.doc, pos);
  if (!section) return false;
  return editor.chain().command(({ tr, state }) => {
    removeAt(state, tr, section.pos);
    return true;
  }).run();
}

export function setSectionAttrs(editor: Editor, pos: number, attrs: Record<string, unknown>): boolean {
  const section = sectionAt(editor.state.doc, pos);
  if (!section) return false;
  return editor.chain().command(({ tr }) => {
    tr.setNodeMarkup(section.pos, undefined, { ...section.node.attrs, ...attrs });
    return true;
  }).run();
}

/**
 * Change la disposition. Moins de colonnes : celles en trop sont versées dans
 * la dernière gardée, rien ne se perd. Plus : des colonnes vides s'ajoutent.
 */
export function setSectionLayout(editor: Editor, pos: number, layout: SiteSectionLayout): boolean {
  const section = sectionAt(editor.state.doc, pos);
  if (!section) return false;
  const wanted = layout.split('-').length;
  return editor.chain().command(({ tr, state }) => {
    const { column } = state.schema.nodes;
    const columns: PMNode[] = [];
    section.node.forEach((child) => columns.push(child));
    let next: PMNode[];
    if (wanted < columns.length) {
      const merged: PMNode[] = [];
      for (const col of columns.slice(wanted - 1)) col.forEach((block) => merged.push(block));
      next = [...columns.slice(0, wanted - 1), column.create(null, Fragment.fromArray(merged))];
    } else {
      next = [...columns];
      while (next.length < wanted) next.push(column.createAndFill()!);
    }
    tr.replaceWith(section.pos, section.pos + section.node.nodeSize, section.node.type.create({ ...section.node.attrs, layout }, Fragment.fromArray(next)));
    return true;
  }).run();
}

/** Insère une section (JSON du site) après la section qui contient `afterPos`, ou à la fin. */
export function insertSection(editor: Editor, json: JSONContent, afterPos: number | null): boolean {
  const doc = editor.state.doc;
  const section = afterPos === null ? null : sectionAt(doc, afterPos);
  const at = section ? section.pos + section.node.nodeSize : doc.content.size;
  return editor.chain().command(({ tr, state }) => {
    const node = state.schema.nodeFromJSON(json);
    tr.insert(at, node);
    tr.setSelection(NodeSelection.create(tr.doc, at));
    tr.scrollIntoView();
    return true;
  }).run();
}

// ─── Blocs ──────────────────────────────────────────────────────────────────

export type BlockMove = 'up' | 'down' | 'left' | 'right';

/**
 * Déplace un bloc. Haut et bas : dans sa colonne, puis dans la section
 * voisine (même colonne si elle existe) une fois au bord. Gauche et droite :
 * à la fin de la colonne voisine.
 */
export function moveBlock(editor: Editor, pos: number, move: BlockMove): boolean {
  const doc = editor.state.doc;
  const block = blockAt(doc, pos);
  if (!block) return false;
  const column = doc.nodeAt(block.columnPos)!;
  if (move === 'up' || move === 'down') {
    const delta = move === 'up' ? -1 : 1;
    const siblingIndex = block.index + delta;
    if (siblingIndex >= 0 && siblingIndex < column.childCount) {
      const sibling = column.child(siblingIndex);
      const to = delta < 0 ? block.pos - sibling.nodeSize : block.pos + block.node.nodeSize + sibling.nodeSize;
      return moveNode(editor, block.pos, to);
    }
    const neighbourIndex = block.section.index + delta;
    if (neighbourIndex < 0 || neighbourIndex >= doc.childCount) return false;
    let neighbourPos = 0;
    for (let i = 0; i < neighbourIndex; i += 1) neighbourPos += doc.child(i).nodeSize;
    const neighbour: SectionRef = { pos: neighbourPos, index: neighbourIndex, node: doc.child(neighbourIndex) };
    const colIndex = Math.min(block.columnIndex, neighbour.node.childCount - 1);
    const start = columnStart(neighbour, colIndex);
    const target = neighbour.node.child(colIndex);
    return moveNode(editor, block.pos, delta < 0 ? start + target.nodeSize - 1 : start + 1);
  }
  const colIndex = block.columnIndex + (move === 'left' ? -1 : 1);
  if (colIndex < 0 || colIndex >= block.section.node.childCount) return false;
  const start = columnStart(block.section, colIndex);
  return moveNode(editor, block.pos, start + block.section.node.child(colIndex).nodeSize - 1);
}

export function duplicateBlock(editor: Editor, pos: number): boolean {
  const block = blockAt(editor.state.doc, pos);
  if (!block) return false;
  const at = block.pos + block.node.nodeSize;
  return editor.chain().command(({ tr }) => {
    tr.insert(at, block.node.copy(block.node.content));
    tr.setSelection(NodeSelection.create(tr.doc, at));
    return true;
  }).run();
}

export function deleteBlock(editor: Editor, pos: number): boolean {
  const block = blockAt(editor.state.doc, pos);
  if (!block) return false;
  return editor.chain().command(({ tr, state }) => {
    removeAt(state, tr, block.pos);
    return true;
  }).run();
}

/**
 * Commence le glisser d'un nœud (section ou bloc) depuis une poignée :
 * ProseMirror s'occupe ensuite du dépôt, au bon niveau du schéma.
 */
export function startNodeDrag(editor: Editor, pos: number, event: DragEvent): void {
  const view = editor.view;
  const selection = NodeSelection.create(view.state.doc, pos);
  view.dispatch(view.state.tr.setSelection(selection));
  const slice = selection.content();
  const { dom, text } = view.serializeForClipboard(slice);
  if (event.dataTransfer) {
    event.dataTransfer.clearData();
    event.dataTransfer.setData('text/html', dom.innerHTML);
    event.dataTransfer.setData('text/plain', text);
    event.dataTransfer.effectAllowed = 'copyMove';
    const image = view.nodeDOM(pos);
    if (image instanceof HTMLElement) event.dataTransfer.setDragImage(image, 0, 0);
  }
  view.dragging = { slice, move: true };
}

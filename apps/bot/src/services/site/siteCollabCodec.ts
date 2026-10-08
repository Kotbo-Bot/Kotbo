/**
 * Conversion entre un document du site (ProseMirror JSON) et un document Yjs,
 * dans la représentation de `@tiptap/y-tiptap` (celle de l'éditeur) :
 *  - chaque nœud est un `Y.XmlElement` nommé comme lui, ses attributs non nuls
 *    copiés tels quels ;
 *  - les textes voisins d'un même parent forment un seul `Y.XmlText`, chaque
 *    marque devenant un attribut de formatage `{ <marque>: <attrs> }` ;
 *  - le tout vit dans le fragment `default` (nom par défaut de l'extension
 *    Collaboration de Tiptap).
 *
 * Écrit à la main plutôt qu'importé : y-tiptap tire ProseMirror, et le bot n'a
 * besoin que de ces deux parcours.
 */

import * as Y from 'yjs';
import { normalizeSiteDocument, type SiteDocument, type SiteMark, type SiteNode } from '@kotbo/shared';

export const COLLAB_FRAGMENT = 'default';

/** Marques que y-tiptap suffixe d'un hash quand elles peuvent se chevaucher. */
const HASHED_MARK = /(.*)(--[a-zA-Z0-9+/=]{8})$/;

function marksToAttributes(marks: SiteMark[] | undefined): Record<string, unknown> | undefined {
  if (!marks || marks.length === 0) return undefined;
  const attrs: Record<string, unknown> = {};
  for (const mark of marks) attrs[mark.type] = mark.attrs ?? {};
  return attrs;
}

function toYElement(node: SiteNode): Y.XmlElement {
  const element = new Y.XmlElement(node.type);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value !== null && value !== undefined) element.setAttribute(key, value as never);
  }
  const children: Array<Y.XmlElement | Y.XmlText> = [];
  let run: SiteNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const text = new Y.XmlText();
    text.applyDelta(run.map((t) => ({ insert: t.text ?? '', attributes: marksToAttributes(t.marks) })));
    children.push(text);
    run = [];
  };
  for (const child of node.content ?? []) {
    if (child.type === 'text') run.push(child);
    else {
      flush();
      children.push(toYElement(child));
    }
  }
  flush();
  if (children.length > 0) element.insert(0, children);
  return element;
}

/** Remplit un fragment vide à partir d'un document. */
export function seedFragment(fragment: Y.XmlFragment, doc: SiteDocument): void {
  if (doc.content.length === 0) return;
  fragment.insert(0, doc.content.map(toYElement));
}

function fromYElement(element: Y.XmlElement): SiteNode {
  const content: SiteNode[] = [];
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
        if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
        const marks = Object.entries(op.attributes ?? {}).map(([name, attrs]) => ({
          type: (HASHED_MARK.exec(name)?.[1] ?? name) as SiteMark['type'],
          attrs: typeof attrs === 'object' && attrs !== null ? (attrs as Record<string, unknown>) : undefined,
        }));
        content.push(marks.length > 0 ? { type: 'text', text: op.insert, marks } : { type: 'text', text: op.insert });
      }
    } else if (child instanceof Y.XmlElement) {
      content.push(fromYElement(child));
    }
  }
  const node: SiteNode = { type: element.nodeName, attrs: element.getAttributes() as Record<string, unknown> };
  if (content.length > 0) node.content = content;
  return node;
}

/** Document normalisé lu dans un fragment : ce qui devient le brouillon. */
export function fragmentToDocument(fragment: Y.XmlFragment): SiteDocument {
  const content = fragment
    .toArray()
    .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
    .map(fromYElement);
  return normalizeSiteDocument({ type: 'doc', content });
}

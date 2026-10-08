/**
 * Aller-retour document ↔ Yjs : ce que le serveur amorce doit se relire à
 * l'identique, sans quoi l'enregistrement d'une session d'édition à plusieurs
 * déformerait le brouillon.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { normalizeSiteDocument } from '@kotbo/shared';
import { COLLAB_FRAGMENT, fragmentToDocument, seedFragment } from '../../services/site/siteCollabCodec.js';

const sample = normalizeSiteDocument({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titre' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Bonjour ' },
        { type: 'text', text: 'le monde', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://kotbo.fr' } }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'suite' },
      ],
    },
    { type: 'grid', attrs: { columns: 2 }, content: [{ type: 'gridCell', attrs: { span: 1 }, content: [{ type: 'module', attrs: { module: 'staff', config: { layout: 'org' } } }] }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'un' }] }] }] },
  ],
});

describe('codec Yjs', () => {
  test('aller-retour fidèle', () => {
    const doc = new Y.Doc();
    seedFragment(doc.getXmlFragment(COLLAB_FRAGMENT), sample);
    expect(fragmentToDocument(doc.getXmlFragment(COLLAB_FRAGMENT))).toEqual(sample);
  });

  test('survit à un échange d’état entre deux documents', () => {
    const source = new Y.Doc();
    seedFragment(source.getXmlFragment(COLLAB_FRAGMENT), sample);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
    expect(fragmentToDocument(copy.getXmlFragment(COLLAB_FRAGMENT))).toEqual(sample);
  });

  test('une modification concurrente se retrouve dans le brouillon', () => {
    const a = new Y.Doc();
    seedFragment(a.getXmlFragment(COLLAB_FRAGMENT), sample);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'ajout');
    para.insert(0, [text]);
    b.getXmlFragment(COLLAB_FRAGMENT).push([para]);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const result = fragmentToDocument(a.getXmlFragment(COLLAB_FRAGMENT));
    expect(result.content.at(-1)).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'ajout' }] });
  });

  test('ce qui sort repasse par la liste blanche', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    const evil = new Y.XmlElement('iframe');
    evil.setAttribute('src', 'https://evil');
    fragment.push([evil]);
    expect(fragmentToDocument(fragment).content).toEqual([]);
  });
});

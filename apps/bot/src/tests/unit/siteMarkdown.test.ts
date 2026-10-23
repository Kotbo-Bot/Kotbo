/**
 * Markdown des agents (MCP) : converti puis normalisé, il ne doit rien
 * produire que la liste blanche refuserait, ni perdre le texte.
 */
import { describe, expect, test } from 'bun:test';
import { markdownToSiteDocument, siteDocumentToMarkdown } from '@kotbo/shared';

describe('Markdown → document', () => {
  test('titres, paragraphes et marques', () => {
    const doc = markdownToSiteDocument('# Règlement\n\nSois **poli** et *patient*, lis [le wiki](/~/wiki).');
    expect(doc.content[0]).toEqual({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Règlement' }] });
    expect(doc.content[1].content).toEqual([
      { type: 'text', text: 'Sois ' },
      { type: 'text', text: 'poli', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' et ' },
      { type: 'text', text: 'patient', marks: [{ type: 'italic' }] },
      { type: 'text', text: ', lis ' },
      { type: 'text', text: 'le wiki', marks: [{ type: 'link', attrs: { href: '/~/wiki' } }] },
      { type: 'text', text: '.' },
    ]);
  });

  test('listes, tâches, citation, code, séparateur', () => {
    const doc = markdownToSiteDocument('- un\n- deux\n\n1. a\n2. b\n\n- [x] fait\n- [ ] à faire\n\n> citation\n\n```ts\nconst a = 1;\n```\n\n---');
    expect(doc.content.map((n) => n.type)).toEqual(['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'horizontalRule']);
    expect(doc.content[2].content?.[0].attrs).toEqual({ checked: true });
    expect(doc.content[4]).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] });
  });

  test('un lien dangereux perd sa marque', () => {
    const doc = markdownToSiteDocument('[clic](javascript:alert(1))');
    expect(JSON.stringify(doc)).not.toContain('javascript');
  });

  test('une image hors https disparaît', () => {
    expect(markdownToSiteDocument('![x](http://evil/a.png)').content).toEqual([]);
  });

  test('aller-retour lisible', () => {
    const md = '## Titre\n\nTexte **gras**.\n\n- un\n- deux';
    expect(siteDocumentToMarkdown(markdownToSiteDocument(md))).toBe(md);
  });
});

import { describe, expect, it } from 'bun:test';
import { sanitizeOrgCanvas } from '../../services/staff/staffOrgCanvasService.js';

describe('sanitizeOrgCanvas', () => {
  it('rejette les entrées invalides et borne les valeurs', () => {
    const out = sanitizeOrgCanvas({
      nodes: { a: { x: 1e9, y: 'x' }, b: 'nope' },
      frames: [{ id: 'f', label: 'Direction', x: 0, y: 0, w: 5, h: 100, color: 'red' }, { label: 'sans id' }],
      links: [
        { id: 'l1', from: 'a', to: 'b', style: 'dashed', linked: true },
        { id: 'l2', from: 'a', to: 'a' },
        { id: 'l3', from: 'a', to: 'b', style: 'solid', linked: true },
      ],
    });
    expect(out.nodes).toEqual({ a: { x: 20000, y: 0 } });
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0]).toMatchObject({ w: 40, color: null });
    expect(out.links.map((l) => [l.id, l.linked])).toEqual([['l1', false], ['l3', true]]);
  });

  it('accepte une valeur vide', () => {
    expect(sanitizeOrgCanvas(null)).toEqual({ nodes: {}, frames: [], links: [] });
  });
});

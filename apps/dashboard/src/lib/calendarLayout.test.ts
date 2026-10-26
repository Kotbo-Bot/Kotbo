import { describe, expect, test } from 'bun:test';
import { layoutDay } from './calendarLayout';

const ev = (key: string, start: number, end: number) => ({ key, start, end });

describe('colonnes des événements qui se chevauchent', () => {
  test('deux événements séparés gardent toute la largeur', () => {
    const layout = layoutDay([ev('a', 60, 120), ev('b', 120, 180)]);
    expect(layout.get('a')).toEqual({ col: 0, cols: 1 });
    expect(layout.get('b')).toEqual({ col: 0, cols: 1 });
  });

  test('trois chevauchements se répartissent, la colonne libérée est reprise', () => {
    // a 9h-11h, b 9h30-10h, c 10h-10h30 : c reprend la colonne de b.
    const layout = layoutDay([ev('a', 540, 660), ev('b', 570, 600), ev('c', 600, 630)]);
    expect(layout.get('a')).toEqual({ col: 0, cols: 2 });
    expect(layout.get('b')).toEqual({ col: 1, cols: 2 });
    expect(layout.get('c')).toEqual({ col: 1, cols: 2 });
  });

  test('un groupe de chevauchements ne rétrécit pas le groupe suivant', () => {
    const layout = layoutDay([ev('a', 0, 60), ev('b', 30, 90), ev('c', 120, 180)]);
    expect(layout.get('c')).toEqual({ col: 0, cols: 1 });
    expect(layout.get('a')?.cols).toBe(2);
  });
});

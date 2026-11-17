import { describe, test, expect } from 'bun:test';
import { chartTable } from './chartTable';

const fmt = (n: number) => String(n);

describe('chartTable : alternative textuelle des graphiques (RGAA 1.1)', () => {
  test('une ligne par libelle, une colonne par serie', () => {
    const table = chartTable(
      { labels: ['Lun', 'Mar'], datasets: [{ label: 'Messages', data: [3, 5] }, { label: 'Membres', data: [1, 2] }] },
      fmt,
    );
    expect(table.series).toEqual(['Messages', 'Membres']);
    expect(table.rows).toEqual([
      { label: 'Lun', values: ['3', '1'] },
      { label: 'Mar', values: ['5', '2'] },
    ]);
  });

  test('points {x, y} sans libelles : x sert de libelle de ligne', () => {
    const table = chartTable({ datasets: [{ label: 'Score', data: [{ x: '2026-11-01', y: 4 }, { x: '2026-11-02', y: 7 }] }] }, fmt);
    expect(table.rows).toEqual([
      { label: '2026-11-01', values: ['4'] },
      { label: '2026-11-02', values: ['7'] },
    ]);
  });

  test('valeur absente : cellule vide, pas « null »', () => {
    const table = chartTable({ labels: ['A'], datasets: [{ label: 'S', data: [null] }] }, fmt);
    expect(table.rows).toEqual([{ label: 'A', values: [''] }]);
  });

  test('serie sans nom : numerotee', () => {
    const table = chartTable({ labels: ['A'], datasets: [{ data: [1] }] }, fmt);
    expect(table.series).toEqual(['1']);
  });

  test('donnees vides ou absentes : tableau vide', () => {
    expect(chartTable(undefined, fmt)).toEqual({ series: [], rows: [] });
    expect(chartTable({ labels: [], datasets: [] }, fmt)).toEqual({ series: [], rows: [] });
  });
});

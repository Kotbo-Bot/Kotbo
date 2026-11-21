import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';

const mockDb = {};
const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { bucketize, detectAnomalies, validateAnnotation } = await import('../../services/analytics/activityInsightsService');

/** Historique de `days` jours finissant le 2026-09-30, une valeur par jour de semaine. */
function history(days: number, valueOf: (dateKey: string) => number): Map<string, number> {
  const map = new Map<string, number>();
  const end = Date.parse('2026-09-30T00:00:00Z');
  for (let i = 0; i < days; i += 1) {
    const key = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    map.set(key, valueOf(key));
  }
  return map;
}

describe('detectAnomalies', () => {
  test('un pic net sur un jour habituellement calme est signalé', () => {
    const h = history(40, () => 50);
    h.set('2026-09-30', 200);
    const found = detectAnomalies(['2026-09-30'], h, 'messages');
    expect(found).toEqual([{ dateKey: '2026-09-30', metric: 'messages', value: 200, expected: 50, direction: 'up' }]);
  });

  test('le creux habituel du week-end n’est pas une anomalie', () => {
    // Samedi et dimanche toujours à 10, semaine à 100.
    const h = history(40, (key) => ([0, 6].includes(new Date(`${key}T00:00:00Z`).getUTCDay()) ? 10 : 100));
    const weekend = ['2026-09-26', '2026-09-27'];
    expect(detectAnomalies(weekend, h, 'messages')).toEqual([]);
  });

  test('une chute franche est signalée comme creux', () => {
    const h = history(40, () => 120);
    h.set('2026-09-30', 20);
    const [found] = detectAnomalies(['2026-09-30'], h, 'messages');
    expect(found?.direction).toBe('down');
  });

  test('des petits volumes ne déclenchent rien, même en proportion', () => {
    const h = history(40, () => 2);
    h.set('2026-09-30', 12);
    expect(detectAnomalies(['2026-09-30'], h, 'messages')).toEqual([]);
  });

  test('sans trois semaines de référence, on ne conclut pas', () => {
    const h = history(15, () => 50);
    h.set('2026-09-30', 300);
    expect(detectAnomalies(['2026-09-30'], h, 'messages')).toEqual([]);
  });
});

describe('bucketize', () => {
  test('une série courte reste telle quelle', () => {
    expect(bucketize([1, 2, 3], 30)).toEqual([1, 2, 3]);
  });

  test('une série longue est sommée par paquets sans rien perdre', () => {
    const values = Array.from({ length: 90 }, () => 1);
    const out = bucketize(values, 30);
    expect(out.length).toBe(30);
    expect(out.reduce((s, v) => s + v, 0)).toBe(90);
  });
});

describe('validateAnnotation', () => {
  test('accepte une date et un texte, espaces resserrés', () => {
    expect(validateAnnotation({ dateKey: '2026-10-01', label: '  Tournoi   inter-serveurs ' }))
      .toEqual({ dateKey: '2026-10-01', label: 'Tournoi inter-serveurs' });
  });

  test('refuse une date mal formée', () => {
    expect(validateAnnotation({ dateKey: '01/10/2026', label: 'x' })).toBe('invalid_date');
  });

  test('refuse un texte vide ou trop long', () => {
    expect(validateAnnotation({ dateKey: '2026-10-01', label: '   ' })).toBe('invalid_label');
    expect(validateAnnotation({ dateKey: '2026-10-01', label: 'x'.repeat(81) })).toBe('invalid_label');
  });
});

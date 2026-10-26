import { describe, expect, test } from 'bun:test';
import { MAX_REPEAT, repeatDates } from './planningRepeat';

const start = new Date(2026, 9, 26, 21, 0);
const end = new Date(2026, 9, 26, 22, 0);

describe('répétition des réunions', () => {
  test('sans répétition : une seule occurrence', () => {
    expect(repeatDates(start, end, 'none', 8)).toEqual([[start, end]]);
  });

  test('chaque semaine garde l’heure murale, même au changement d’heure', () => {
    const dates = repeatDates(start, end, 'weekly', 3);
    expect(dates.map(([s]) => [s.getDate(), s.getHours()])).toEqual([[26, 21], [2, 21], [9, 21]]);
    expect(dates.every(([s, e]) => e.getTime() - s.getTime() === 3600000)).toBeTrue();
  });

  test('toutes les deux semaines et chaque mois', () => {
    expect(repeatDates(start, end, 'biweekly', 2)[1][0].getDate()).toBe(9);
    expect(repeatDates(start, end, 'monthly', 2)[1][0].getMonth()).toBe(10);
  });

  test('le nombre est borné', () => {
    expect(repeatDates(start, end, 'weekly', 100)).toHaveLength(MAX_REPEAT);
    expect(repeatDates(start, end, 'weekly', 0)).toHaveLength(1);
  });
});

import { describe, expect, it } from 'bun:test';
import { DURATION_UNITS, splitDuration, toSeconds } from './durationUnits';

describe('durationUnits', () => {
  it('choisit la plus grande unité qui tombe juste', () => {
    expect(splitDuration(3600)).toEqual({ amount: 1, unit: 'hours' });
    expect(splitDuration(172_800)).toEqual({ amount: 2, unit: 'days' });
    expect(splitDuration(5400)).toEqual({ amount: 90, unit: 'minutes' });
  });

  it('garde les secondes quand aucune autre unité ne tombe juste', () => {
    expect(splitDuration(45)).toEqual({ amount: 45, unit: 'seconds' });
  });

  it('reconvertit en secondes, sans descendre sous une seconde', () => {
    expect(toSeconds(3, 'hours')).toBe(10_800);
    expect(toSeconds(0, 'minutes')).toBe(1);
    expect(toSeconds(-5, 'days')).toBe(1);
  });

  it('les unités sont rangées de la plus petite à la plus grande', () => {
    const sizes = DURATION_UNITS.map((unit) => unit.seconds);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });
});

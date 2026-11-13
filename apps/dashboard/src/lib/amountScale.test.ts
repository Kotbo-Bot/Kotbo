import { describe, test, expect } from 'bun:test';
import { DROP_AMOUNT_RANGE, DROP_ITEM_QUANTITY_RANGE } from '@kotbo/shared';
import { amountSteps, nearestStepIndex, orderedAmounts, shiftedRange } from './amountScale';

/**
 * Le curseur des montants avance par paliers ronds : de 1 à un million, un curseur
 * linéaire ne saurait pas viser 50. Les champs de saisie restent à côté pour toute
 * autre valeur, et le curseur se place alors sur le palier le plus proche.
 */
describe('paliers du curseur de montants', () => {
  test('petite plage : chaque valeur est un palier', () => {
    expect(amountSteps(DROP_ITEM_QUANTITY_RANGE)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('grande plage : des valeurs rondes, croissantes, des bornes incluses', () => {
    const steps = amountSteps(DROP_AMOUNT_RANGE);
    expect(steps[0]).toBe(DROP_AMOUNT_RANGE.min);
    expect(steps.at(-1)).toBe(DROP_AMOUNT_RANGE.max);
    expect(steps).toContain(50);
    expect(steps).toContain(250);
    expect(steps).toContain(10_000);
    expect(steps.every((step, index) => index === 0 || step > steps[index - 1])).toBe(true);
    // Assez de crans pour viser, pas au point d'en faire un curseur au pixel.
    expect(steps.length).toBeLessThan(80);
  });

  test('une valeur saisie hors palier place le curseur sur le plus proche', () => {
    const steps = amountSteps(DROP_AMOUNT_RANGE);
    expect(steps[nearestStepIndex(steps, 50)]).toBe(50);
    expect(steps[nearestStepIndex(steps, 52)]).toBe(50);
    expect(steps[nearestStepIndex(steps, 0)]).toBe(1);
    expect(steps[nearestStepIndex(steps, 5_000_000)]).toBe(DROP_AMOUNT_RANGE.max);
  });

  test('une poignée qui dépasse l\'autre la pousse : le minimum ne passe jamais le maximum', () => {
    expect(orderedAmounts(300, 200, 'min')).toEqual({ min: 300, max: 300 });
    expect(orderedAmounts(300, 200, 'max')).toEqual({ min: 200, max: 200 });
    expect(orderedAmounts(50, 250, 'min')).toEqual({ min: 50, max: 250 });
  });

  test('la plage glisse d\'un bloc, avec le même écart entre ses bornes', () => {
    expect(shiftedRange(2, 5, 3, 20)).toEqual({ min: 5, max: 8 });
    expect(shiftedRange(2, 5, -1, 20)).toEqual({ min: 1, max: 4 });
  });

  test('arrivée à un bout, la plage s\'arrête sans se tasser', () => {
    expect(shiftedRange(2, 5, -10, 20)).toEqual({ min: 0, max: 3 });
    expect(shiftedRange(15, 18, 10, 20)).toEqual({ min: 17, max: 20 });
  });
});

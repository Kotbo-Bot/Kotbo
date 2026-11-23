import { describe, expect, test } from 'bun:test';
import { REMINDER_WEIGHT, normalizeWarnWeight } from '../../services/moderation/warnWeight';

describe('normalizeWarnWeight', () => {
  test('garde un poids de 0 : le warn devient un rappel', () => {
    expect(normalizeWarnWeight(REMINDER_WEIGHT)).toBe(0);
  });

  test('garde les gravités 1 à 3', () => {
    expect(normalizeWarnWeight(1)).toBe(1);
    expect(normalizeWarnWeight(3)).toBe(3);
  });

  test('vaut 1 sans gravité précisée', () => {
    expect(normalizeWarnWeight(undefined)).toBe(1);
  });

  test('borne les valeurs hors plage', () => {
    expect(normalizeWarnWeight(-2)).toBe(0);
    expect(normalizeWarnWeight(9)).toBe(3);
  });
});

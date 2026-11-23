import { describe, expect, test } from 'bun:test';
import { REMINDER_WEIGHT, normalizeWarnWeight, tierWarnWeight } from '../../services/moderation/warnWeight';

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

describe('tierWarnWeight', () => {
  test('un palier WARN garde la gravité choisie, rappel compris', () => {
    expect(tierWarnWeight('WARN', 0)).toBe(0);
    expect(tierWarnWeight('WARN', 3)).toBe(3);
  });

  test('un palier WARN sans gravité vaut 1', () => {
    expect(tierWarnWeight('WARN', undefined)).toBe(1);
    expect(tierWarnWeight('WARN', 'grave')).toBe(1);
  });

  test('un palier qui n’est pas un warn reste à 1', () => {
    expect(tierWarnWeight('TIMEOUT', 0)).toBe(1);
  });
});

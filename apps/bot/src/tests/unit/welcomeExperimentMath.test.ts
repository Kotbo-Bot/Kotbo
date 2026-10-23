import { describe, expect, test } from 'bun:test';
import {
  ExperimentValidationError,
  compareRates,
  normalCdf,
  parseVariants,
  pickVariant,
  requiredSampleSize,
} from '../../services/features/welcomeExperimentMath.js';

describe('versions', () => {
  test('de 2 à 4, clés imposées, poids et textes bornés', () => {
    const variants = parseVariants([{ name: ' Contrôle ', weight: 50 }, { message: '  Salut {user}  ', weight: 0, threadEnabled: false, imageEnabled: true }]);
    expect(variants).toEqual([
      { key: 'A', name: 'Contrôle', weight: 50, message: null, imageEnabled: null, threadEnabled: null },
      { key: 'B', name: 'Version B', weight: 50, message: 'Salut {user}', imageEnabled: true, threadEnabled: false },
    ]);
    expect(() => parseVariants([{}])).toThrow(ExperimentValidationError);
    expect(() => parseVariants([{}, {}, {}, {}, {}])).toThrow(ExperimentValidationError);
  });

  test('un membre retombe toujours sur la même version', () => {
    const variants = parseVariants([{}, {}]);
    expect(pickVariant('exp1', 'u1', variants).key).toBe(pickVariant('exp1', 'u1', variants).key);
  });

  test('la répartition suit les poids', () => {
    const variants = parseVariants([{ weight: 80 }, { weight: 20 }]);
    let a = 0;
    for (let i = 0; i < 5000; i += 1) if (pickVariant('exp', `user${i}`, variants).key === 'A') a += 1;
    expect(a / 5000).toBeGreaterThan(0.76);
    expect(a / 5000).toBeLessThan(0.84);
  });
});

describe('statistiques', () => {
  test('loi normale', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
  });

  test('un écart net donne une forte chance et une petite valeur p', () => {
    const result = compareRates({ n: 1000, k: 300 }, { n: 1000, k: 380 });
    expect(result.uplift).toBeCloseTo(0.2667, 3);
    expect(result.chanceToBeat!).toBeGreaterThan(0.99);
    expect(result.pValue!).toBeLessThan(0.001);
  });

  test('deux versions identiques : une chance sur deux', () => {
    const result = compareRates({ n: 200, k: 60 }, { n: 200, k: 60 });
    expect(result.chanceToBeat).toBeCloseTo(0.5, 6);
    expect(result.pValue).toBeCloseTo(1, 6);
  });

  test('sans arrivant, rien à conclure', () => {
    expect(compareRates({ n: 0, k: 0 }, { n: 10, k: 3 })).toEqual({ uplift: null, chanceToBeat: null, pValue: null });
  });

  test('taille d’échantillon : plus la base est basse, plus il en faut', () => {
    const at30 = requiredSampleSize(0.3)!;
    expect(at30).toBeGreaterThan(800);
    expect(at30).toBeLessThan(1000);
    expect(requiredSampleSize(0.05)!).toBeGreaterThan(at30);
    expect(requiredSampleSize(0)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { fitWithin } from './imageImport';

describe("redimensionnement d'une image importée", () => {
  test('ramène le plus grand côté à la limite en gardant les proportions', () => {
    expect(fitWithin(4000, 2000, 1024)).toEqual({ width: 1024, height: 512 });
    expect(fitWithin(1000, 3000, 600)).toEqual({ width: 200, height: 600 });
  });

  test("n'agrandit jamais une petite image", () => {
    expect(fitWithin(300, 200, 1024)).toEqual({ width: 300, height: 200 });
  });
});

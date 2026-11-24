import { describe, expect, test } from 'bun:test';
import { bodyText } from '../../utils/bodyText';

describe('bodyText', () => {
  test('nettoie et coupe une chaîne', () => {
    expect(bodyText('  bonjour  ', 3)).toBe('bon');
  });

  test('tout ce qui n\'est pas une chaîne donne une chaîne vide, sans planter', () => {
    expect(bodyText(123, 10)).toBe('');
    expect(bodyText({ a: 1 }, 10)).toBe('');
    expect(bodyText(['x'], 10)).toBe('');
    expect(bodyText(null, 10)).toBe('');
    expect(bodyText(undefined, 10)).toBe('');
  });
});

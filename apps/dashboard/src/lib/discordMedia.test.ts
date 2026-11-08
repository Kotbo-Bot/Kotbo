import { describe, test, expect } from 'bun:test';
import { localInitialAvatar } from './discordMedia';

describe('localInitialAvatar', () => {
  test('un pseudo qui commence par un emoji ne fait pas planter la page', () => {
    const src = localInitialAvatar('🔥 Pseudo', '123');
    expect(decodeURIComponent(src)).toContain('>🔥</text>');
  });

  test('initiale en majuscule, ? si le nom est vide', () => {
    expect(decodeURIComponent(localInitialAvatar('alice'))).toContain('>A</text>');
    expect(decodeURIComponent(localInitialAvatar('  '))).toContain('>?</text>');
  });
});

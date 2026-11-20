import { describe, expect, test } from 'bun:test';
import {
  extractCustomEmojis,
  extractUnicodeEmojis,
  normalizeUnicodeEmoji,
  sanitizeEmojiBan,
} from '../../services/moderation/emojiBanService.js';

describe('emojis interdits : extraction', () => {
  test('emojis personnalisés, animés compris, sans doublon', () => {
    const found = extractCustomEmojis('salut <:kek:123456789012345678> <a:dance:223456789012345678> <:kek:123456789012345678>');
    expect(found).toEqual([
      { id: '123456789012345678', name: 'kek', animated: false },
      { id: '223456789012345678', name: 'dance', animated: true },
    ]);
  });

  test('emojis natifs : teinte de peau et sélecteur ignorés, séquences ZWJ et drapeaux entiers', () => {
    const found = extractUnicodeEmojis('ok 👍🏽 ❤️ 👨‍👩‍👧 🇫🇷 1️⃣ texte 123 <:kek:123456789012345678>');
    expect(found).toEqual(['👍', '❤', '👨‍👩‍👧', '🇫🇷', '1⃣']);
  });

  test('la clé d\'une règle correspond à celle du message', () => {
    expect(normalizeUnicodeEmoji('👍🏿')).toBe(normalizeUnicodeEmoji('👍'));
  });
});

describe('emojis interdits : validation', () => {
  test('refuse un id invalide ou un texte qui n\'est pas un emoji', () => {
    expect(sanitizeEmojiBan({ kind: 'EMOJI', key: 'abc' })).toBeNull();
    expect(sanitizeEmojiBan({ kind: 'UNICODE', key: 'hello' })).toBeNull();
  });

  test('sanction inconnue → suppression, durée ignorée hors timeout/ban/quarantaine', () => {
    expect(sanitizeEmojiBan({ kind: 'UNICODE', key: '🍆', action: 'NUKE', durationMin: 30 })).toMatchObject({ key: '🍆', action: 'DELETE', durationMin: null });
    expect(sanitizeEmojiBan({ kind: 'STICKER', key: '123456789012345678', action: 'TIMEOUT', durationMin: 60 })).toMatchObject({ action: 'TIMEOUT', durationMin: 60 });
  });
});

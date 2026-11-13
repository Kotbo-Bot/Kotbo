import { describe, expect, test } from 'bun:test';
import { isThanksReaction, type ThanksReaction } from '../../services/community/reputationReactionFilter.js';

const BASE: ThanksReaction = {
  enabled: true,
  configuredEmoji: '🙏',
  emojiKey: '🙏',
  reactorId: 'giver',
  reactorIsBot: false,
  authorId: 'author',
  authorIsBot: false,
};

describe('isThanksReaction', () => {
  test('la bonne réaction d\'un membre sur le message d\'un autre compte', () => {
    expect(isThanksReaction(BASE)).toBe(true);
  });

  test('option éteinte', () => {
    expect(isThanksReaction({ ...BASE, enabled: false })).toBe(false);
  });

  test('aucun emoji réglé', () => {
    expect(isThanksReaction({ ...BASE, configuredEmoji: null })).toBe(false);
  });

  test('autre emoji', () => {
    expect(isThanksReaction({ ...BASE, emojiKey: '👍' })).toBe(false);
  });

  test('emoji custom comparé par son id', () => {
    expect(isThanksReaction({ ...BASE, configuredEmoji: '123456789012345678', emojiKey: '123456789012345678' })).toBe(true);
  });

  test('réaction posée par un bot', () => {
    expect(isThanksReaction({ ...BASE, reactorIsBot: true })).toBe(false);
  });

  test('réaction sur son propre message', () => {
    expect(isThanksReaction({ ...BASE, authorId: 'giver' })).toBe(false);
  });

  test('message d\'un bot ou d\'un webhook sans auteur', () => {
    expect(isThanksReaction({ ...BASE, authorIsBot: true })).toBe(false);
    expect(isThanksReaction({ ...BASE, authorId: null })).toBe(false);
  });
});

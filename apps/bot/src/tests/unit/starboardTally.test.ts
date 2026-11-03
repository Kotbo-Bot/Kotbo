/**
 * Décompte des votes Starlight : la réaction d'amorçage du bot ne compte pas,
 * celle de l'auteur du message non plus quand l'option est active (on ne vote
 * pas pour soi).
 */

import { describe, it, expect } from 'bun:test';
import { normalizeEmojiKey, tallyVotes, type ReactionVote } from '../../services/features/starboardTally.js';

const CONFIG = { upvoteEmojis: ['👍', '<:etoile:123456789012345678>'], downvoteEmojis: ['👎'] };

function vote(key: string, count: number, extra: Partial<ReactionVote> = {}): ReactionVote {
  return { key, count, me: false, byAuthor: false, ...extra };
}

describe('tallyVotes', () => {
  it('additionne les emojis positifs et négatifs configurés', () => {
    expect(tallyVotes([vote('👍', 4), vote('123456789012345678', 2), vote('👎', 1)], CONFIG)).toEqual({ up: 6, down: 1 });
  });

  it('ignore les emojis qui ne sont pas des votes', () => {
    expect(tallyVotes([vote('😂', 10), vote('👍', 1)], CONFIG)).toEqual({ up: 1, down: 0 });
  });

  it("retire la réaction d'amorçage du bot", () => {
    expect(tallyVotes([vote('👍', 3, { me: true }), vote('👎', 1, { me: true })], CONFIG)).toEqual({ up: 2, down: 0 });
  });

  it("retire le vote de l'auteur du message", () => {
    expect(tallyVotes([vote('👍', 5, { byAuthor: true })], CONFIG)).toEqual({ up: 4, down: 0 });
  });

  it("retire à la fois le bot et l'auteur sur la même réaction", () => {
    expect(tallyVotes([vote('👍', 2, { me: true, byAuthor: true })], CONFIG)).toEqual({ up: 0, down: 0 });
  });

  it('ne descend jamais sous zéro', () => {
    expect(tallyVotes([vote('👍', 1, { me: true, byAuthor: true })], CONFIG)).toEqual({ up: 0, down: 0 });
  });

  it("retire aussi le vote négatif de l'auteur", () => {
    expect(tallyVotes([vote('👎', 3, { byAuthor: true })], CONFIG)).toEqual({ up: 0, down: 2 });
  });
});

describe('normalizeEmojiKey', () => {
  it("réduit un emoji custom à son id", () => {
    expect(normalizeEmojiKey('<:etoile:123456789012345678>')).toBe('123456789012345678');
    expect(normalizeEmojiKey('<a:etoile:123456789012345678>')).toBe('123456789012345678');
  });

  it('garde un emoji unicode tel quel', () => {
    expect(normalizeEmojiKey(' 👍 ')).toBe('👍');
  });
});

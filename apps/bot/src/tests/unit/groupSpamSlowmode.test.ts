import { beforeEach, describe, expect, test } from 'bun:test';
import {
  GROUP_SPAM_MIN_USERS,
  GROUP_SPAM_WINDOW_MS,
  noteSpammer,
  resetGroupSpam,
} from '../../services/moderation/groupSpamSlowmode.js';

describe('noteSpammer', () => {
  beforeEach(() => resetGroupSpam());

  test('compte les membres distincts, pas les messages', () => {
    expect(noteSpammer('c1', 'a', 0)).toBe(1);
    expect(noteSpammer('c1', 'a', 100)).toBe(1);
    expect(noteSpammer('c1', 'b', 200)).toBe(2);
    expect(noteSpammer('c1', 'c', 300)).toBe(GROUP_SPAM_MIN_USERS);
  });

  test('oublie les déclenchements hors fenêtre', () => {
    noteSpammer('c1', 'a', 0);
    noteSpammer('c1', 'b', 0);
    expect(noteSpammer('c1', 'c', GROUP_SPAM_WINDOW_MS)).toBe(1);
  });

  test('sépare les salons', () => {
    noteSpammer('c1', 'a', 0);
    noteSpammer('c1', 'b', 0);
    expect(noteSpammer('c2', 'c', 0)).toBe(1);
  });
});

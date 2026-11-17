import { describe, expect, it } from 'bun:test';
import {
  registerVerificationAttempt,
  VERIFICATION_SPAM_MAX,
  VERIFICATION_SPAM_WINDOW_MS,
} from '../../services/moderation/verificationSpamGuard.js';

describe('registerVerificationAttempt', () => {
  it('compte les tentatives par modérateur et par serveur', () => {
    for (let i = 1; i <= VERIFICATION_SPAM_MAX + 1; i++) {
      expect(registerVerificationAttempt('g1', 'mod-a', 1000 + i)).toBe(i);
    }
    expect(registerVerificationAttempt('g1', 'mod-b', 2000)).toBe(1);
    expect(registerVerificationAttempt('g2', 'mod-a', 2000)).toBe(1);
  });

  it('oublie les tentatives sorties de la fenêtre', () => {
    registerVerificationAttempt('g3', 'mod-c', 0);
    expect(registerVerificationAttempt('g3', 'mod-c', VERIFICATION_SPAM_WINDOW_MS + 1)).toBe(1);
  });
});

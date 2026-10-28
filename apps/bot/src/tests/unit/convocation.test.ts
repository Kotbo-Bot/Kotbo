import { describe, expect, test } from 'bun:test';
import { ackLine, expiryNotice } from '../../services/moderation/convocationRules.js';

describe('expiryNotice', () => {
  test('annonce la conséquence choisie avec le délai', () => {
    expect(expiryNotice('WARN', 48)).toBe('Sans réponse sous 48 h, un avertissement sera appliqué.');
    expect(expiryNotice('ALERT', 24)).toContain('la modération en sera avertie');
  });

  test('rien à annoncer quand rien ne se passe', () => {
    expect(expiryNotice('NONE', 48)).toBeNull();
  });
});

describe('ackLine', () => {
  test('en attente, reçu, expiré, clos', () => {
    expect(ackLine({ status: 'PENDING', acknowledgedAt: null })).toBe('⏳ En attente');
    expect(ackLine({ status: 'ANSWERED', acknowledgedAt: new Date(1_700_000_000_000) })).toBe('✅ Reçu <t:1700000000:R>');
    expect(ackLine({ status: 'EXPIRED', acknowledgedAt: null })).toBe('⌛ Délai dépassé sans réponse');
    expect(ackLine({ status: 'CLOSED', acknowledgedAt: new Date() })).toBe('🔒 Convocation close');
  });
});

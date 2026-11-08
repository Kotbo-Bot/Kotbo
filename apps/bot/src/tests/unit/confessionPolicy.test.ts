/**
 * Règles d'acceptation d'une confession : format, délai entre deux envois
 * (lu en base, il survit aux redémarrages) et mots interdits du serveur.
 */

import { describe, it, expect } from 'bun:test';
import {
  CONFESSION_MAX_LENGTH,
  checkConfession,
  normalizeConfessionCooldown,
} from '../../services/features/confessionPolicy.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');

function check(overrides: Partial<Parameters<typeof checkConfession>[0]> = {}) {
  return checkConfession({
    content: 'Je mange les croissants du staff.',
    bannedWords: [],
    lastSentAt: null,
    cooldownSeconds: 60,
    now: NOW,
    ...overrides,
  });
}

describe('checkConfession', () => {
  it('accepte une confession valide et la renvoie nettoyée', () => {
    expect(check({ content: '  Bonjour  ' })).toEqual({ ok: true, content: 'Bonjour' });
  });

  it('refuse un message vide', () => {
    expect(check({ content: '   ' })).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuse un message trop long', () => {
    expect(check({ content: 'a'.repeat(CONFESSION_MAX_LENGTH + 1) })).toEqual({ ok: false, reason: 'too_long' });
  });

  it('refuse pendant le délai et indique le temps restant', () => {
    const lastSentAt = new Date(NOW - 20_000);
    expect(check({ lastSentAt })).toEqual({ ok: false, reason: 'cooldown', retryInSeconds: 40 });
  });

  it('accepte une fois le délai écoulé', () => {
    const lastSentAt = new Date(NOW - 60_000);
    expect(check({ lastSentAt }).ok).toBe(true);
  });

  it('sans délai configuré, accepte immédiatement', () => {
    expect(check({ lastSentAt: new Date(NOW - 1000), cooldownSeconds: 0 }).ok).toBe(true);
  });

  it('refuse un message contenant un mot interdit du serveur', () => {
    expect(check({ content: 'Quel gros caca ce serveur', bannedWords: ['caca'] })).toEqual({ ok: false, reason: 'blocked' });
  });

  it("n'est pas piégé par un mot interdit contenu dans un autre mot", () => {
    expect(check({ content: 'Un bon cacao chaud', bannedWords: ['caca'] }).ok).toBe(true);
  });
});

describe('normalizeConfessionCooldown', () => {
  it('garde une valeur entière dans les bornes', () => {
    expect(normalizeConfessionCooldown(300)).toBe(300);
  });

  it('arrondit et borne entre 0 et 24 h', () => {
    expect(normalizeConfessionCooldown(12.6)).toBe(13);
    expect(normalizeConfessionCooldown(-5)).toBe(0);
    expect(normalizeConfessionCooldown(999_999)).toBe(86_400);
  });

  it('rejette ce qui n\'est pas un nombre', () => {
    expect(normalizeConfessionCooldown('60')).toBeNull();
    expect(normalizeConfessionCooldown(Number.NaN)).toBeNull();
    expect(normalizeConfessionCooldown(null)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { sourceModeConflict } from '../../services/system/broadcastService.js';

const ok = { target: 'ALL' as const, pollOptions: [], feedbackLabel: null };

describe('sourceModeConflict', () => {
  test('accepte une annonce simple pour tous les serveurs', () => {
    expect(sourceModeConflict(ok)).toBeNull();
  });

  test('refuse un ciblage restreint', () => {
    expect(sourceModeConflict({ ...ok, target: 'CUSTOM' })).toContain('ciblage');
    expect(sourceModeConflict({ ...ok, target: 'ACTIVATED' })).toContain('ciblage');
  });

  test('refuse un sondage ou une demande d’avis', () => {
    expect(sourceModeConflict({ ...ok, pollOptions: ['a', 'b'] })).toContain('sondage');
    expect(sourceModeConflict({ ...ok, feedbackLabel: 'Ton avis' })).toContain('sondage');
  });
});

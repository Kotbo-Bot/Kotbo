import { describe, expect, test } from 'bun:test';
import { sourceModeConflict } from '../../services/system/broadcastService.js';

describe('sourceModeConflict', () => {
  test('autorise ALL avec ou sans sondage / avis (portes par le dashboard)', () => {
    expect(sourceModeConflict({ target: 'ALL', pollOptions: [], feedbackLabel: null })).toBeNull();
    expect(sourceModeConflict({ target: 'ALL', pollOptions: ['Oui', 'Non'], feedbackLabel: null })).toBeNull();
    expect(sourceModeConflict({ target: 'ALL', pollOptions: [], feedbackLabel: 'Donner mon avis' })).toBeNull();
  });

  test('refuse le ciblage restreint en mode salon source', () => {
    expect(sourceModeConflict({ target: 'ACTIVATED', pollOptions: [], feedbackLabel: null })).not.toBeNull();
    expect(sourceModeConflict({ target: 'CUSTOM', pollOptions: [], feedbackLabel: null })).not.toBeNull();
  });
});

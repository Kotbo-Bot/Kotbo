import { describe, expect, it } from 'bun:test';
import { testReplayStatus } from './workflowTest';

describe('testReplayStatus', () => {
  it('garde un essai terminé ou échoué tel quel', () => {
    expect(testReplayStatus('COMPLETED')).toBe('COMPLETED');
    expect(testReplayStatus('FAILED')).toBe('FAILED');
  });

  it('montre en attente un essai arrêté sur une attente', () => {
    // Le plafond de reprises atteint, l'essai n'a pas parcouru la suite :
    // le dire terminé ferait croire que tout a été vérifié.
    expect(testReplayStatus('SUSPENDED')).toBe('WAITING');
  });
});

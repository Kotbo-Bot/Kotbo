import { describe, expect, it } from 'bun:test';
import { failedNodeId, testReplayStatus } from './workflowTest';

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

describe('failedNodeId', () => {
  it('donne le nœud de l étape en erreur', () => {
    expect(failedNodeId([
      { nodeId: 't', status: 'OK' },
      { nodeId: 'a1__fmt_text', status: 'OK' },
      { nodeId: 'a1', status: 'ERROR' },
    ])).toBe('a1');
  });

  it('ne donne rien quand tout s est bien passé', () => {
    expect(failedNodeId([{ nodeId: 't', status: 'OK' }, { nodeId: 'a1', status: 'SKIPPED' }])).toBeNull();
  });
});

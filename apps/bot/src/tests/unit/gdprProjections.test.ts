import { describe, expect, test } from 'bun:test';
import { projectGiveaway, projectMcpApiKey, projectMemberReport } from '../../services/system/gdprProjections.js';

const ME = 'membre-1';

describe('projections de l\'export RGPD', () => {
  test('concours : les autres participants disparaissent, la participation de la personne reste', () => {
    const projected = projectGiveaway({
      id: 'g1',
      prize: 'Nitro',
      participants: [ME, 'autre-1', 'autre-2'],
      winners: ['autre-1'],
      pendingWinners: [ME],
    }, ME);

    expect(projected).toEqual({ id: 'g1', prize: 'Nitro', participated: true, won: false, pendingWinner: true });
    expect(JSON.stringify(projected)).not.toContain('autre-');
  });

  test('signalement visant la personne : son auteur est masqué', () => {
    expect(projectMemberReport({ id: 'r1', reporterId: 'autre-1', targetId: ME, reason: 'spam' }, ME))
      .toEqual({ id: 'r1', reporterId: null, targetId: ME, reason: 'spam' });
  });

  test('signalement écrit par la personne : rien n\'est masqué', () => {
    const report = { id: 'r2', reporterId: ME, targetId: 'autre-1', reason: 'spam' };
    expect(projectMemberReport(report, ME)).toEqual(report);
  });

  test('clé MCP : l\'empreinte du secret n\'est pas exportée', () => {
    expect(projectMcpApiKey({ id: 'k1', name: 'CI', keyHash: 'abc', displayKey: 'kb_...12' }, ME))
      .toEqual({ id: 'k1', name: 'CI', displayKey: 'kb_...12' });
  });
});

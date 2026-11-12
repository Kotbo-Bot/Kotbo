import { describe, expect, test } from 'bun:test';
import {
  actionTrace,
  buildActionSources,
  projectListMembership,
  projectMcpApiKey,
  projectMemberReport,
  projectProgressionBlacklist,
} from '../../services/system/gdprProjections.js';

const ME = 'membre-1';
const ids = { discordId: ME, staffIds: [ME, 'fiche-staff-1'] };

describe('projections de l\'export RGPD', () => {
  test('listes de membres : remplacées par leur taille et la présence de la personne', () => {
    const projectGiveaway = projectListMembership({ participants: 'participated', winners: 'won', pendingWinners: 'pendingWinner' });
    const projected = projectGiveaway({
      id: 'g1',
      prize: 'Nitro',
      participants: [ME, 'autre-1', 'autre-2'],
      winners: ['autre-1'],
      pendingWinners: [ME],
    }, ids);

    expect(projected).toEqual({
      id: 'g1',
      prize: 'Nitro',
      participantsCount: 3,
      participated: true,
      winnersCount: 1,
      won: false,
      pendingWinnersCount: 1,
      pendingWinner: true,
    });
    expect(JSON.stringify(projected)).not.toContain('autre-');
  });

  test('liste absente ou illisible : comptée vide, la personne n\'y figure pas', () => {
    expect(projectListMembership({ upvoters: 'votedUp' })({ id: 's1', upvoters: null }, ids))
      .toEqual({ id: 's1', upvotersCount: 0, votedUp: false });
  });

  test('signalement visant la personne : son auteur est masqué', () => {
    expect(projectMemberReport({ id: 'r1', reporterId: 'autre-1', targetId: ME, reason: 'spam' }, ids))
      .toEqual({ id: 'r1', reporterId: null, targetId: ME, reason: 'spam' });
  });

  test('signalement écrit par la personne : rien n\'est masqué', () => {
    const report = { id: 'r2', reporterId: ME, targetId: 'autre-1', reason: 'spam' };
    expect(projectMemberReport(report, ids)).toEqual(report);
  });

  test('exclusion de la progression : le serveur, pas sa configuration', () => {
    expect(projectProgressionBlacklist({ id: 'serveur-1', name: 'Kotbo', progressionBlacklistUserIds: [ME, 'autre-1'] }, ids))
      .toEqual({ guildId: 'serveur-1', progressionBlacklisted: true });
  });

  test('clé MCP : l\'empreinte du secret n\'est pas exportée', () => {
    expect(projectMcpApiKey({ id: 'k1', name: 'CI', keyHash: 'abc', displayKey: 'kb_...12' }, ids))
      .toEqual({ id: 'k1', name: 'CI', displayKey: 'kb_...12' });
  });
});

describe('traces d\'action', () => {
  const createdAt = new Date('2026-11-01T10:00:00Z');

  test('ni contenu ni cible : quoi, où, quand, à quel titre', () => {
    const trace = actionTrace(['moderatorUserId', 'revokedByUserId'])({
      id: 'sanction-1',
      guildId: 'serveur-1',
      targetUserId: 'autre-1',
      reason: 'insultes',
      moderatorUserId: ME,
      revokedByUserId: 'autre-2',
      createdAt,
    }, ids);

    expect(trace).toEqual({ id: 'sanction-1', guildId: 'serveur-1', createdAt, updatedAt: null, as: ['moderatorUserId'] });
  });

  test('un champ qui range la fiche staff de la personne compte aussi', () => {
    expect(actionTrace(['createdByUserId'])({ id: 'cle-1', createdByUserId: 'fiche-staff-1' }, ids))
      .toEqual({ id: 'cle-1', guildId: null, createdAt: null, updatedAt: null, as: ['createdByUserId'] });
  });

  const models = [
    {
      name: 'Sanction',
      fields: [
        { name: 'targetUserId', type: 'String', isList: false },
        { name: 'moderatorUserId', type: 'String', isList: false },
        { name: 'revokedByUserId', type: 'String', isList: false },
      ],
    },
    { name: 'MemberLevel', fields: [{ name: 'userId', type: 'String', isList: false }] },
    { name: 'Workflow', fields: [{ name: 'createdById', type: 'Int', isList: false }] },
  ];

  test('une source par modèle qui garde l\'auteur d\'une action, et seulement eux', () => {
    const sources = buildActionSources(models, ['moderatorUserId', 'revokedByUserId', 'createdById']);

    expect(sources.map((source) => source.model)).toEqual(['sanction']);
    expect(sources[0]?.category).toBe('actions');
    expect(sources[0]?.where(ids)).toEqual({
      OR: [{ moderatorUserId: { in: ids.staffIds } }, { revokedByUserId: { in: ids.staffIds } }],
    });
  });
});

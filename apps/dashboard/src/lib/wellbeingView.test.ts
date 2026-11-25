import { describe, expect, test } from 'bun:test';
import { WB_SEVERITIES, WB_STATUSES } from './wellbeingLabels';
import { wbCaseStats, wbCaseTimeline, wbFilterCases, wbIsReviewDue, wbSeverityTone, wbStatusTone, type WbCaseView } from './wellbeingView';

const NOW = new Date('2026-11-25T12:00:00Z');

function dossier(over: Partial<WbCaseView> = {}): WbCaseView {
  return { id: 'c1', status: 'OPEN', severity: 'NORMAL', reviewAt: null, notes: [], events: [], ...over };
}

describe('teintes des pastilles', () => {
  test('chaque statut et chaque gravité ont une teinte propre', () => {
    const statuts = WB_STATUSES.map(wbStatusTone);
    const gravites = WB_SEVERITIES.map(wbSeverityTone);
    expect(new Set(statuts).size).toBe(WB_STATUSES.length);
    expect(new Set(gravites).size).toBe(WB_SEVERITIES.length);
  });

  test('une gravité critique ne ressemble pas à une gravité basse', () => {
    expect(wbSeverityTone('CRITICAL')).toContain('error');
    expect(wbSeverityTone('LOW')).not.toContain('error');
  });

  test('un code inconnu reçoit la teinte neutre plutôt que rien', () => {
    expect(wbStatusTone('ARCHIVED')).toBe(wbStatusTone('CLOSED'));
    expect(wbSeverityTone('ARCHIVED').length).toBeGreaterThan(0);
  });
});

describe('date de revue', () => {
  test('échue le jour même ou avant', () => {
    expect(wbIsReviewDue(dossier({ reviewAt: '2026-11-25T00:00:00Z' }), NOW)).toBe(true);
    expect(wbIsReviewDue(dossier({ reviewAt: '2026-11-20T00:00:00Z' }), NOW)).toBe(true);
  });

  test('pas échue dans le futur ni sans date', () => {
    expect(wbIsReviewDue(dossier({ reviewAt: '2026-11-26T00:00:00Z' }), NOW)).toBe(false);
    expect(wbIsReviewDue(dossier(), NOW)).toBe(false);
  });

  test('un dossier clos n est jamais à revoir', () => {
    expect(wbIsReviewDue(dossier({ status: 'CLOSED', reviewAt: '2026-11-01T00:00:00Z' }), NOW)).toBe(false);
  });
});

describe('filtre de la liste', () => {
  const liste = [
    dossier({ id: 'a', status: 'OPEN' }),
    dossier({ id: 'b', status: 'MONITORING' }),
    dossier({ id: 'c', status: 'CLOSED' }),
  ];

  test('« actifs » garde les dossiers ouverts et en suivi', () => {
    expect(wbFilterCases(liste, 'active').map((c) => c.id)).toEqual(['a', 'b']);
  });

  test('« clos » ne garde que les dossiers fermés', () => {
    expect(wbFilterCases(liste, 'closed').map((c) => c.id)).toEqual(['c']);
  });

  test('« tous » rend la liste dans son ordre', () => {
    expect(wbFilterCases(liste, 'all').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('chiffres clés', () => {
  test('compte actifs, urgents, à revoir et clos', () => {
    const stats = wbCaseStats([
      dossier({ id: 'a', status: 'OPEN', severity: 'CRITICAL' }),
      dossier({ id: 'b', status: 'MONITORING', severity: 'HIGH', reviewAt: '2026-11-24T00:00:00Z' }),
      dossier({ id: 'c', status: 'OPEN', severity: 'LOW' }),
      dossier({ id: 'd', status: 'CLOSED', severity: 'CRITICAL', reviewAt: '2026-11-01T00:00:00Z' }),
    ], NOW);
    expect(stats).toEqual({ active: 3, urgent: 2, reviewDue: 1, closed: 1 });
  });

  test('un dossier clos critique ne compte pas comme urgent', () => {
    expect(wbCaseStats([dossier({ status: 'CLOSED', severity: 'CRITICAL' })], NOW).urgent).toBe(0);
  });
});

describe('chronologie d un dossier', () => {
  const note = { id: 'n1', authorName: 'Alex', content: 'Appel fait', createdAt: '2026-11-24T10:00:00Z' };
  const cree = { id: 'e1', type: 'CREATED', actorName: 'Alex', fromValue: null, toValue: null, createdAt: '2026-11-23T09:00:00Z' };
  const noteAjoutee = { id: 'e2', type: 'NOTE', actorName: 'Alex', fromValue: null, toValue: null, createdAt: '2026-11-24T10:00:00Z' };
  const statut = { id: 'e3', type: 'STATUS', actorName: 'Sam', fromValue: 'OPEN', toValue: 'MONITORING', createdAt: '2026-11-25T08:00:00Z' };

  test('mêle notes et événements, du plus récent au plus ancien', () => {
    const lignes = wbCaseTimeline(dossier({ notes: [note], events: [cree, noteAjoutee, statut] }));
    expect(lignes.map((l) => l.id)).toEqual(['e3', 'n1', 'e1']);
    expect(lignes.map((l) => l.kind)).toEqual(['event', 'note', 'event']);
  });

  test('l événement « note ajoutée » est retiré : la note elle-même est affichée', () => {
    const lignes = wbCaseTimeline(dossier({ notes: [note], events: [noteAjoutee] }));
    expect(lignes.map((l) => l.id)).toEqual(['n1']);
  });

  test('un dossier sans notes ni historique donne une chronologie vide', () => {
    expect(wbCaseTimeline(dossier({ notes: undefined, events: undefined }))).toEqual([]);
  });
});

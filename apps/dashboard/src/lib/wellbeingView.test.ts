import { describe, expect, test } from 'bun:test';
import { WB_SEVERITIES, WB_STATUSES } from './wellbeingLabels';
import { WB_IDLE_LOCK_MS, wbBoardColumns, wbNeighbourCaseId, wbShortcut, wbCaseExportHtml, wbPurgeInfo, wbTaskProgress, wbCaseStats, wbCaseTimeline, wbFilterCases, wbIsReviewDue, wbLinkedCases, wbMergeHeader, wbReviewShortcut, wbSearchCases, wbSeverityTone, wbSortCases, wbStatusTone, type WbCaseView } from './wellbeingView';

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
    expect(stats).toEqual({ active: 3, urgent: 2, reviewDue: 1, closed: 1, triage: 0 });
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

describe('signalements à trier et dossiers suivis', () => {
  const liste = [
    dossier({ id: 'a', source: 'DISCORD', assigneeId: null }),
    dossier({ id: 'b', source: 'DISCORD', assigneeId: 'moi' }),
    dossier({ id: 'c', source: 'DASHBOARD', assigneeId: 'moi' }),
    dossier({ id: 'd', source: 'DISCORD', assigneeId: null, status: 'CLOSED' }),
  ];

  test('« à trier » : signalement Discord actif sans référent', () => {
    expect(wbFilterCases(liste, 'triage').map((c) => c.id)).toEqual(['a']);
    expect(wbCaseStats(liste, NOW).triage).toBe(1);
  });

  test('« mes dossiers » : dossiers actifs dont on est référent', () => {
    expect(wbFilterCases(liste, 'mine', 'moi').map((c) => c.id)).toEqual(['b', 'c']);
    expect(wbFilterCases(liste, 'mine').map((c) => c.id)).toEqual([]);
  });
});

describe('recherche et tri', () => {
  const liste = [
    dossier({ id: 'a', title: 'Conflit en vocal', subjectName: 'Élodie', severity: 'LOW', reviewAt: null, updatedAt: '2026-11-20T00:00:00Z' }),
    dossier({ id: 'b', title: 'Soutien', subjectName: 'Marc', severity: 'CRITICAL', reviewAt: '2026-12-01T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' }),
    dossier({ id: 'c', title: 'Médiation', subjectName: 'Jo', severity: 'HIGH', reviewAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z' }),
  ];

  test('la recherche porte sur le titre et la personne, sans casse ni accents', () => {
    expect(wbSearchCases(liste, 'elodie').map((c) => c.id)).toEqual(['a']);
    expect(wbSearchCases(liste, 'MEDIA').map((c) => c.id)).toEqual(['c']);
    expect(wbSearchCases(liste, '  ').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  test('tri par activité récente, gravité ou échéance', () => {
    expect(wbSortCases(liste, 'recent').map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(wbSortCases(liste, 'severity').map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(wbSortCases(liste, 'review').map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });

  test('le tri ne modifie pas la liste reçue', () => {
    wbSortCases(liste, 'severity');
    expect(liste.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('dossiers liés', () => {
  test('les autres dossiers sur le même membre, pas le dossier ouvert', () => {
    const liste = [
      dossier({ id: 'a', subjectUserId: 'u1' }),
      dossier({ id: 'b', subjectUserId: 'u1' }),
      dossier({ id: 'c', subjectUserId: 'u2' }),
      dossier({ id: 'd', subjectUserId: null }),
    ];
    expect(wbLinkedCases(liste, liste[0]).map((c) => c.id)).toEqual(['b']);
    expect(wbLinkedCases(liste, liste[3])).toEqual([]);
  });
});

describe('en-tête mis à jour après une modification', () => {
  test('reprend les champs du dossier et garde ce que seule la liste connaît', () => {
    const entete = { ...dossier({ id: 'a', status: 'OPEN' }), subjectIsTeamMember: true };
    const complet = { ...dossier({ id: 'a', status: 'CLOSED', severity: 'HIGH' }), summary: 'secret', notes: [] };
    const fusion = wbMergeHeader(entete, complet);
    expect(fusion).toMatchObject({ id: 'a', status: 'CLOSED', severity: 'HIGH', subjectIsTeamMember: true });
    expect('summary' in fusion).toBe(false);
  });
});

describe("raccourcis d'échéance", () => {
  test('ajoutent des jours à la date du jour, au format du champ date', () => {
    const now = new Date(2026, 10, 25, 12);
    expect(wbReviewShortcut(now, 3)).toBe('2026-11-28');
    expect(wbReviewShortcut(now, 7)).toBe('2026-12-02');
  });
});

describe('verrouillage', () => {
  test("la page se verrouille après cinq minutes d'inactivité", () => {
    expect(WB_IDLE_LOCK_MS).toBe(5 * 60 * 1000);
  });
});

describe('effacement prévu', () => {
  test('un dossier fermé est effacé un an après sa dernière modification', () => {
    const info = wbPurgeInfo(dossier({ status: 'CLOSED', updatedAt: '2026-01-10T00:00:00Z' }), NOW);
    expect(info?.date.toISOString()).toBe('2027-01-10T00:00:00.000Z');
    expect(info?.soon).toBe(false);
  });

  test('« bientôt » dans les sept derniers jours', () => {
    expect(wbPurgeInfo(dossier({ status: 'CLOSED', updatedAt: '2025-11-28T00:00:00Z' }), NOW)?.soon).toBe(true);
  });

  test("un dossier actif n'a pas de date d'effacement", () => {
    expect(wbPurgeInfo(dossier({ status: 'OPEN', updatedAt: '2025-01-01T00:00:00Z' }), NOW)).toBeNull();
  });
});

describe("avancement du plan d'action", () => {
  test('compte les tâches faites sur le total', () => {
    expect(wbTaskProgress([{ doneAt: null }, { doneAt: '2026-11-20T00:00:00Z' }, { doneAt: null }])).toEqual({ done: 1, total: 3, percent: 33 });
    expect(wbTaskProgress(undefined)).toEqual({ done: 0, total: 0, percent: 0 });
  });
});

describe('export imprimable', () => {
  const labels = { summary: 'Résumé', notes: 'Notes', tasks: 'Plan', attachments: 'Documents', exported: 'Exporté par Sam le 25/11' };
  const html = wbCaseExportHtml({
    title: 'Conflit <b>vocal</b>',
    meta: ['Alex', 'Médiation'],
    summary: '<script>alert(1)</script>',
    notes: [{ author: 'Sam', date: '24/11', content: 'Appel fait & noté' }],
    tasks: [{ label: 'Rappeler', done: true }],
    attachments: [{ label: 'CR', url: 'https://drive.google.com/x' }],
  }, labels, 'Sam · 25/11');

  test('échappe tout le contenu du dossier', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Conflit &lt;b&gt;vocal&lt;/b&gt;');
    expect(html).toContain('Appel fait &amp; noté');
  });

  test('porte le filigrane et la mention de qui a exporté', () => {
    expect(html).toContain('Sam · 25/11');
    expect(html).toContain('Exporté par Sam le 25/11');
  });

  test('reprend notes, tâches et documents', () => {
    for (const part of ['Notes', 'Rappeler', 'https://drive.google.com/x']) expect(html).toContain(part);
  });
});

describe('vue en colonnes', () => {
  test('une colonne par statut, dans l ordre du suivi, les dossiers à leur place', () => {
    const columns = wbBoardColumns([
      dossier({ id: 'a', status: 'CLOSED' }),
      dossier({ id: 'b', status: 'OPEN' }),
      dossier({ id: 'c', status: 'MONITORING' }),
      dossier({ id: 'd', status: 'OPEN' }),
    ]);
    expect(columns.map((column) => column.status)).toEqual(['OPEN', 'MONITORING', 'CLOSED']);
    expect(columns.map((column) => column.cases.map((c) => c.id))).toEqual([['b', 'd'], ['c'], ['a']]);
  });
});

describe('navigation au clavier', () => {
  const liste = [dossier({ id: 'a' }), dossier({ id: 'b' }), dossier({ id: 'c' })];

  test('suivant et précédent, sans sortir de la liste', () => {
    expect(wbNeighbourCaseId(liste, 'a', 1)).toBe('b');
    expect(wbNeighbourCaseId(liste, 'c', 1)).toBe('c');
    expect(wbNeighbourCaseId(liste, 'a', -1)).toBe('a');
  });

  test('sans dossier ouvert, on part du premier', () => {
    expect(wbNeighbourCaseId(liste, null, 1)).toBe('a');
    expect(wbNeighbourCaseId([], null, 1)).toBeNull();
  });
});

describe('raccourcis clavier', () => {
  const key = (over: Partial<Parameters<typeof wbShortcut>[0]> = {}) =>
    ({ key: 'j', ctrlKey: false, metaKey: false, altKey: false, typing: false, ...over });

  test('j, k, n et d', () => {
    expect(wbShortcut(key({ key: 'j' }))).toBe('next');
    expect(wbShortcut(key({ key: 'k' }))).toBe('previous');
    expect(wbShortcut(key({ key: 'n' }))).toBe('note');
    expect(wbShortcut(key({ key: 'd' }))).toBe('discreet');
  });

  test('rien pendant la saisie ni avec une touche de modification', () => {
    expect(wbShortcut(key({ typing: true }))).toBeNull();
    expect(wbShortcut(key({ ctrlKey: true }))).toBeNull();
    expect(wbShortcut(key({ metaKey: true }))).toBeNull();
    expect(wbShortcut(key({ key: 'x' }))).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ALERT_EVENTS,
  UNUSUAL_ACCESS_THRESHOLD,
  WELLBEING_ALERT_EVENTS,
  alertText,
  cleanMentionIds,
  isUnusualAccess,
  mentionText,
} from '../../services/staff/wellbeingAlertPolicy';
import { WELLBEING_SESSION_MAX_HOURS, wellbeingSessionExpired } from '../../services/staff/wellbeingAccessPolicy';
import { caseEventHash, verifyCaseEventChain } from '../../services/staff/wellbeingCasePolicy';
import {
  generateTrackingCode,
  normalizeTrackingCode,
  trackingCodeHash,
  trackingStatus,
} from '../../services/staff/wellbeingReportPolicy';
import { agendaItems } from '../../services/staff/wellbeingWorkloadPolicy';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-25T12:00:00Z');

describe('consultation inhabituelle', () => {
  test('alerte à partir de dix dossiers ouverts dans la fenêtre', () => {
    expect(UNUSUAL_ACCESS_THRESHOLD).toBe(10);
    expect(isUnusualAccess(9)).toBe(false);
    expect(isUnusualAccess(10)).toBe(true);
  });

  test("l'alerte est cochée par défaut et nomme l'auteur", () => {
    expect(WELLBEING_ALERT_EVENTS).toContain('UNUSUAL_ACCESS');
    expect(DEFAULT_ALERT_EVENTS).toContain('UNUSUAL_ACCESS');
    const text = alertText('UNUSUAL_ACCESS', { actorId: '200000000000000001', caseCount: 12 });
    expect(text).toContain('<@200000000000000001>');
    expect(text).toContain('12');
  });
});

describe('session récente pour lire les dossiers', () => {
  test('une session ouverte depuis moins de douze heures suffit', () => {
    expect(WELLBEING_SESSION_MAX_HOURS).toBe(12);
    expect(wellbeingSessionExpired(NOW.getTime() - 11 * HOUR, NOW.getTime())).toBe(false);
  });

  test('au-delà, ou sans date de connexion connue, il faut se reconnecter', () => {
    expect(wellbeingSessionExpired(NOW.getTime() - 12 * HOUR, NOW.getTime())).toBe(true);
    expect(wellbeingSessionExpired(undefined, NOW.getTime())).toBe(true);
  });
});

describe('historique chaîné', () => {
  const base = { caseId: 'c1', actorId: 'u1', actorName: 'alice', fromValue: null, toValue: null };
  const chain = () => {
    const first = { ...base, type: 'CREATED', createdAt: new Date('2026-11-20T10:00:00Z') };
    const h1 = caseEventHash(null, first);
    const second = { ...base, type: 'NOTE', createdAt: new Date('2026-11-21T10:00:00Z') };
    const h2 = caseEventHash(h1, second);
    return [{ ...first, hash: h1 }, { ...second, hash: h2 }];
  };

  test("l'empreinte dépend de l'entrée et de la précédente", () => {
    const event = { ...base, type: 'CREATED', createdAt: NOW };
    expect(caseEventHash(null, event)).toMatch(/^[0-9a-f]{64}$/);
    expect(caseEventHash('x', event)).not.toBe(caseEventHash(null, event));
    expect(caseEventHash(null, { ...event, type: 'NOTE' })).not.toBe(caseEventHash(null, event));
  });

  test('une chaîne intacte est vérifiée', () => {
    expect(verifyCaseEventChain(chain())).toBe('ok');
    expect(verifyCaseEventChain([])).toBe('ok');
  });

  test('une entrée modifiée ou retirée casse la chaîne', () => {
    const [first, second] = chain();
    expect(verifyCaseEventChain([{ ...first!, type: 'STATUS' }, second!])).toBe('broken');
    expect(verifyCaseEventChain([second!])).toBe('broken');
  });

  test('les entrées antérieures au chaînage sont acceptées en tête seulement', () => {
    const legacy = { ...base, type: 'CREATED', createdAt: new Date('2026-11-01T00:00:00Z'), hash: null };
    const next = { ...base, type: 'NOTE', createdAt: new Date('2026-11-02T00:00:00Z') };
    expect(verifyCaseEventChain([legacy, { ...next, hash: caseEventHash(null, next) }])).toBe('partial');
    const [first] = chain();
    expect(verifyCaseEventChain([first!, { ...legacy, createdAt: new Date('2026-11-22T00:00:00Z') }])).toBe('broken');
  });
});

describe('code de suivi du signalement', () => {
  test('un code lisible, sans caractère ambigu', () => {
    const code = generateTrackingCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(generateTrackingCode()).not.toBe(code);
  });

  test('la saisie est normalisée : casse, espaces et tirets', () => {
    expect(normalizeTrackingCode(' abcde-fgh23 ')).toBe('ABCDEFGH23');
  });

  test("seule l'empreinte est gardée, liée au serveur", () => {
    const hash = trackingCodeHash('g1', 'ABCDE-FGH23');
    expect(hash).not.toContain('ABCDE');
    expect(trackingCodeHash('g1', 'abcde fgh23')).toBe(hash);
    expect(trackingCodeHash('g2', 'ABCDE-FGH23')).not.toBe(hash);
  });

  test('le statut ne dit rien du contenu', () => {
    expect(trackingStatus(null)).toBe('unknown');
    expect(trackingStatus({ status: 'OPEN', assigneeId: null, deletedAt: null })).toBe('received');
    expect(trackingStatus({ status: 'OPEN', assigneeId: 'u1', deletedAt: null })).toBe('in_progress');
    expect(trackingStatus({ status: 'MONITORING', assigneeId: null, deletedAt: null })).toBe('in_progress');
    expect(trackingStatus({ status: 'CLOSED', assigneeId: 'u1', deletedAt: null })).toBe('closed');
    expect(trackingStatus({ status: 'OPEN', assigneeId: null, deletedAt: NOW })).toBe('closed');
  });
});

describe('mentions dans une note', () => {
  test('identifiants Discord seulement, sans doublon, cinq au plus', () => {
    const ids = ['100000000000000001', '100000000000000001', 'x', 3, '100000000000000002',
      '100000000000000003', '100000000000000004', '100000000000000005', '100000000000000006'];
    expect(cleanMentionIds(ids)).toEqual(['100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004', '100000000000000005']);
    expect(cleanMentionIds('100000000000000001')).toEqual([]);
  });

  test('le message ne dit rien du dossier', () => {
    expect(mentionText('200000000000000001')).toContain('<@200000000000000001>');
  });
});

describe('mes échéances', () => {
  const day = (days: number) => new Date(NOW.getTime() + days * 24 * HOUR);
  const cases = [
    { id: 'a', status: 'OPEN', assigneeId: 'me', reviewAt: day(2) },
    { id: 'b', status: 'OPEN', assigneeId: 'me', reviewAt: day(20) },
    { id: 'c', status: 'CLOSED', assigneeId: 'me', reviewAt: day(1) },
    { id: 'd', status: 'MONITORING', assigneeId: 'other', reviewAt: day(1) },
  ];
  const tasks = [
    { id: 't1', caseId: 'd', assigneeId: 'me', dueAt: day(-1), doneAt: null },
    { id: 't2', caseId: 'a', assigneeId: null, dueAt: day(3), doneAt: null },
    { id: 't3', caseId: 'd', assigneeId: null, dueAt: day(3), doneAt: null },
    { id: 't4', caseId: 'a', assigneeId: 'me', dueAt: day(1), doneAt: day(-2) },
  ];

  test('échéances de mes dossiers et mes tâches sur sept jours, retards compris, par date', () => {
    const items = agendaItems(cases, tasks, 'me', NOW);
    expect(items.map((item) => `${item.kind}:${item.caseId}`)).toEqual(['task:d', 'review:a', 'task:a']);
    expect(items[0]?.overdue).toBe(true);
    expect(items[1]?.overdue).toBe(false);
  });
});

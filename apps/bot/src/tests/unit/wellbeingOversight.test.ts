import { describe, expect, test } from 'bun:test';
import { DEFAULT_ALERT_EVENTS, WELLBEING_ALERT_EVENTS, alertText } from '../../services/staff/wellbeingAlertPolicy';
import {
  ACCESS_REVIEW_DAYS,
  accessReviewDue,
  accessReviewMessage,
  shouldSendAccessReview,
} from '../../services/staff/wellbeingAccessPolicy';
import {
  CLOSED_CASE_RETENTION_DAYS,
  PURGE_NOTICE_DAYS,
  PURGE_REQUEST_HOURS,
  casePurgeDate,
  purgeApprovalError,
  purgeNoticeCutoff,
  purgeRequestPending,
  purgeWarnedCutoff,
} from '../../services/staff/wellbeingRetentionPolicy';
import { wellbeingCellStats } from '../../services/staff/wellbeingWorkloadPolicy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-25T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('effacement annoncé des dossiers fermés', () => {
  test('un dossier fermé est effacé un an après sa dernière modification', () => {
    const updatedAt = new Date('2026-01-10T00:00:00Z');
    expect(casePurgeDate(updatedAt).getTime() - updatedAt.getTime()).toBe(CLOSED_CASE_RETENTION_DAYS * DAY);
  });

  test("l'annonce part une semaine avant l'effacement", () => {
    expect(PURGE_NOTICE_DAYS).toBe(7);
    // Un dossier modifié avant cette date sera effacé dans 7 jours ou moins.
    expect(casePurgeDate(purgeNoticeCutoff(NOW)).getTime()).toBe(NOW.getTime() + 7 * DAY);
  });

  test("aucun dossier n'est effacé moins d'une semaine après son annonce", () => {
    // La purge n'efface qu'un dossier annoncé avant cette date : même un dossier
    // fermé depuis plus d'un an au déploiement garde sa semaine de préavis.
    expect(NOW.getTime() - purgeWarnedCutoff(NOW).getTime()).toBe(PURGE_NOTICE_DAYS * DAY);
  });

  test("l'alerte donne le nombre de dossiers, sans rien d'autre", () => {
    expect(WELLBEING_ALERT_EVENTS).toContain('PURGE_SOON');
    expect(DEFAULT_ALERT_EVENTS).toContain('PURGE_SOON');
    const text = alertText('PURGE_SOON', { actorId: '', caseCount: 3 });
    expect(text).toContain('3');
    expect(text).toContain('7');
  });
});

describe('effacement anticipé à deux clés', () => {
  const trashed = { deletedAt: daysAgo(2), purgeRequestedById: 'a', purgeRequestedAt: new Date(NOW.getTime() - 3_600_000) };

  test('une autre personne de la cellule valide la demande', () => {
    expect(purgeApprovalError(trashed, 'b', NOW)).toBeNull();
  });

  test("l'auteur de la demande ne la valide pas lui-même", () => {
    expect(purgeApprovalError(trashed, 'a', NOW)).toBe('self');
  });

  test("une demande en cours ne peut pas être remplacée, une demande échue si", () => {
    expect(purgeRequestPending(trashed, NOW)).toBe(true);
    const old = new Date(NOW.getTime() - PURGE_REQUEST_HOURS * 3_600_000);
    expect(purgeRequestPending({ ...trashed, purgeRequestedAt: old }, NOW)).toBe(false);
    expect(purgeRequestPending({ ...trashed, purgeRequestedById: null, purgeRequestedAt: null }, NOW)).toBe(false);
  });

  test('rien à valider sans demande, hors corbeille ou après le délai', () => {
    expect(purgeApprovalError({ ...trashed, purgeRequestedById: null, purgeRequestedAt: null }, 'b', NOW)).toBe('not_requested');
    expect(purgeApprovalError({ ...trashed, deletedAt: null }, 'b', NOW)).toBe('not_trashed');
    const old = new Date(NOW.getTime() - PURGE_REQUEST_HOURS * 3_600_000);
    expect(purgeApprovalError({ ...trashed, purgeRequestedAt: old }, 'b', NOW)).toBe('expired');
  });
});

describe('revue périodique des accès', () => {
  const fresh = { createdAt: daysAgo(400), accessReviewedAt: daysAgo(3), accessReviewSentAt: null };

  test('due trente jours après la dernière confirmation, ou après la création', () => {
    expect(ACCESS_REVIEW_DAYS).toBe(30);
    expect(accessReviewDue(fresh, NOW)).toBe(false);
    expect(accessReviewDue({ ...fresh, accessReviewedAt: daysAgo(31) }, NOW)).toBe(true);
    expect(accessReviewDue({ ...fresh, accessReviewedAt: null, createdAt: daysAgo(10) }, NOW)).toBe(false);
  });

  test('le rappel part une fois, puis au plus tous les trente jours', () => {
    const due = { ...fresh, accessReviewedAt: daysAgo(40) };
    expect(shouldSendAccessReview(due, NOW)).toBe(true);
    expect(shouldSendAccessReview({ ...due, accessReviewSentAt: daysAgo(5) }, NOW)).toBe(false);
    expect(shouldSendAccessReview({ ...due, accessReviewSentAt: daysAgo(31) }, NOW)).toBe(true);
    expect(shouldSendAccessReview(fresh, NOW)).toBe(false);
  });

  test('le message liste la cellule et la direction, membres et rôles', () => {
    const names: Record<string, string> = { u1: 'alice', u2: 'bob', r1: '@Écoute', r2: '@Direction' };
    const text = accessReviewMessage('Mon serveur', {
      teamUserIds: ['u1'], teamRoleIds: ['r1'], directorUserIds: ['u2'], directorRoleIds: ['r2'],
    }, (id) => names[id] ?? id);
    for (const part of ['Mon serveur', 'alice', 'bob', '@Écoute', '@Direction']) expect(text).toContain(part);
  });

  test('une liste vide est dite vide plutôt que tue', () => {
    const text = accessReviewMessage('S', { teamUserIds: [], teamRoleIds: [], directorUserIds: [], directorRoleIds: [] }, (id) => id);
    expect(text).toContain('aucun');
  });
});

describe('bilan de la cellule', () => {
  const at = (days: number) => daysAgo(days);
  const cases = [
    { status: 'OPEN', severity: 'CRITICAL', category: 'SIGNALEMENT', source: 'DISCORD', assigneeId: null, createdAt: at(2), events: [] },
    {
      status: 'MONITORING', severity: 'NORMAL', category: 'SOUTIEN', source: 'DISCORD', assigneeId: 'u1', createdAt: at(10),
      events: [{ type: 'ASSIGNEE', toValue: 'u1', createdAt: new Date(at(10).getTime() + 4 * 3_600_000) }],
    },
    {
      status: 'CLOSED', severity: 'HIGH', category: 'MEDIATION', source: 'DASHBOARD', assigneeId: 'u1', createdAt: at(50),
      events: [{ type: 'STATUS', toValue: 'CLOSED', createdAt: at(5) }],
    },
  ];

  test('compte ouverts et fermés sur trente jours, actifs et critiques sans référent', () => {
    const stats = wellbeingCellStats(cases, NOW);
    expect(stats.openedLast30).toBe(2);
    expect(stats.closedLast30).toBe(1);
    expect(stats.active).toBe(2);
    expect(stats.criticalUnassigned).toBe(1);
  });

  test('répartit les dossiers actifs par catégorie', () => {
    expect(wellbeingCellStats(cases, NOW).activeByCategory).toEqual({ SIGNALEMENT: 1, SOUTIEN: 1 });
  });

  test('délai médian de prise en charge des signalements, en heures', () => {
    expect(wellbeingCellStats(cases, NOW).medianTriageHours).toBe(4);
    expect(wellbeingCellStats([], NOW).medianTriageHours).toBeNull();
  });

  test('six mois glissants, du plus ancien au plus récent', () => {
    const months = wellbeingCellStats(cases, NOW).months;
    expect(months).toHaveLength(6);
    expect(months[5]).toEqual({ month: '2026-11', opened: 2, closed: 1 });
    expect(months[4]).toEqual({ month: '2026-10', opened: 1, closed: 0 });
  });
});

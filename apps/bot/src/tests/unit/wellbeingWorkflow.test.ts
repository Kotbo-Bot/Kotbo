import { describe, expect, test } from 'bun:test';
import {
  BREAK_GLASS_REQUEST_HOURS,
  REPORT_COOLDOWN_MS,
  alertText,
  breakGlassScope,
  caseChangeEvents,
  cleanResources,
  decideBreakGlassError,
  isBreakGlassActive,
  resourcesMessage,
  shouldAcceptReport,
  staleCutoff,
} from '../../services/staff/wellbeingPolicy';

describe('historique du dossier', () => {
  const before = { status: 'OPEN', severity: 'NORMAL', assigneeId: null, reviewAt: null };

  test('chaque champ modifié donne une entrée, avec avant et après', () => {
    const review = new Date('2026-12-01T00:00:00Z');
    expect(caseChangeEvents(before, { status: 'CLOSED', severity: 'NORMAL', assigneeId: '200000000000000001', reviewAt: review })).toEqual([
      { type: 'STATUS', fromValue: 'OPEN', toValue: 'CLOSED' },
      { type: 'ASSIGNEE', fromValue: null, toValue: '200000000000000001' },
      { type: 'REVIEW', fromValue: null, toValue: review.toISOString() },
    ]);
  });

  test('un champ absent du changement ne compte pas', () => {
    expect(caseChangeEvents(before, { severity: 'HIGH' })).toEqual([{ type: 'SEVERITY', fromValue: 'NORMAL', toValue: 'HIGH' }]);
    expect(caseChangeEvents(before, {})).toEqual([]);
  });
});

describe("accès d'urgence à deux clés", () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const later = new Date('2026-11-24T14:00:00Z');
  const log = { status: 'PENDING', actorId: 'u1', expiresAt: later };

  test("seul un accès validé et non échu ouvre les dossiers", () => {
    expect(isBreakGlassActive({ status: 'APPROVED', expiresAt: later }, now)).toBe(true);
    expect(isBreakGlassActive({ status: 'PENDING', expiresAt: later }, now)).toBe(false);
    expect(isBreakGlassActive({ status: 'APPROVED', expiresAt: now }, now)).toBe(false);
  });

  test("la personne qui demande ne peut pas valider sa propre demande", () => {
    expect(decideBreakGlassError(log, { userId: 'u1', canDecide: true }, now)).toBe('self');
    expect(decideBreakGlassError(log, { userId: 'u2', canDecide: false }, now)).toBe('forbidden');
    expect(decideBreakGlassError(log, { userId: 'u2', canDecide: true }, now)).toBeNull();
  });

  test('une demande déjà tranchée ou échue ne se valide plus', () => {
    expect(decideBreakGlassError({ ...log, status: 'APPROVED' }, { userId: 'u2', canDecide: true }, now)).toBe('closed');
    expect(decideBreakGlassError({ ...log, expiresAt: now }, { userId: 'u2', canDecide: true }, now)).toBe('closed');
    expect(BREAK_GLASS_REQUEST_HOURS).toBeGreaterThan(0);
  });

  test("l'accès se limite au dossier ou au membre visé", () => {
    expect(breakGlassScope({ caseId: 'dossier-1', subjectUserId: null })).toEqual({ id: 'dossier-1' });
    expect(breakGlassScope({ caseId: null, subjectUserId: '200000000000000001' })).toEqual({ subjectUserId: '200000000000000001' });
    expect(breakGlassScope({ caseId: null, subjectUserId: null })).toEqual({});
  });

  test("une demande en attente le dit dans l'alerte", () => {
    expect(alertText('BREAK_GLASS', { actorId: '1', stage: 'requested', reason: 'Enquête' })).toContain('à valider');
  });
});

describe("ressources d'aide", () => {
  test('seuls les liens web sûrs sont gardés, et les champs sont bornés', () => {
    const cleaned = cleanResources([
      { label: 'Écoute', phone: '3114', url: 'https://example.org' },
      { label: 'Piège', url: 'javascript:alert(1)' },
      { label: '', url: 'https://vide.org' },
      'pas un objet',
    ]);
    expect(cleaned).toEqual([
      { label: 'Écoute', phone: '3114', url: 'https://example.org', description: null },
      { label: 'Piège', phone: null, url: null, description: null },
    ]);
  });

  test('au plus dix ressources', () => {
    expect(cleanResources(Array.from({ length: 15 }, (_, i) => ({ label: `R${i}` })))).toHaveLength(10);
  });

  test('le message liste les ressources sans rien dire du dossier', () => {
    const text = resourcesMessage('Mon serveur', [{ label: 'Écoute', phone: '3114', url: null, description: 'Jour et nuit' }]);
    expect(text).toContain('Mon serveur');
    expect(text).toContain('Écoute');
    expect(text).toContain('3114');
  });
});

describe('relances et signalements', () => {
  test("un dossier critique est relancé passé le délai d'inactivité", () => {
    const now = new Date('2026-11-24T00:00:00Z');
    expect(staleCutoff(now, 7).toISOString()).toBe('2026-11-17T00:00:00.000Z');
  });

  test('un membre ne peut envoyer qu un signalement par période', () => {
    const now = 1_000_000_000;
    expect(shouldAcceptReport(undefined, now)).toBe(true);
    expect(shouldAcceptReport(now - 1_000, now)).toBe(false);
    expect(shouldAcceptReport(now - REPORT_COOLDOWN_MS, now)).toBe(true);
  });

  test("un signalement anonyme ne nomme personne dans l'alerte", () => {
    const text = alertText('REPORT', { actorId: '200000000000000001', anonymous: true });
    expect(text).not.toContain('200000000000000001');
  });

  test("la relance d'un dossier ne dit rien de son contenu", () => {
    expect(alertText('REMINDER', { actorId: '', reminder: 'review' })).toContain('suivi');
    expect(alertText('REMINDER', { actorId: '', reminder: 'stale', days: 7 })).toContain('7');
  });
});

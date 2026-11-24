import { describe, expect, test } from 'bun:test';
import { WB_ALERT_EVENTS, WB_CASE_EVENTS, wbCaseEventLabel, WB_CATEGORIES, WB_SEVERITIES, WB_STATUSES, wbAlertEventLabel, wbCategoryLabel, wbSeverityLabel, wbStatusLabel } from './wellbeingLabels';

describe('libellés de la cellule bien-être', () => {
  test('chaque code connu a un libellé lisible, jamais le code brut', () => {
    for (const code of WB_STATUSES) expect(wbStatusLabel(code)).not.toBe(code);
    for (const code of WB_SEVERITIES) expect(wbSeverityLabel(code)).not.toBe(code);
    for (const code of WB_CATEGORIES) expect(wbCategoryLabel(code)).not.toBe(code);
    for (const code of WB_ALERT_EVENTS) expect(wbAlertEventLabel(code)).not.toBe(code);
  });

  test('un code inconnu est rendu tel quel plutôt que vide', () => {
    expect(wbStatusLabel('ARCHIVED')).toBe('ARCHIVED');
  });

  test('les codes suivent ceux acceptés par le bot', () => {
    expect([...WB_STATUSES]).toEqual(['OPEN', 'MONITORING', 'CLOSED']);
    expect([...WB_SEVERITIES]).toEqual(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']);
    expect([...WB_CATEGORIES]).toEqual(['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI']);
    expect([...WB_ALERT_EVENTS]).toEqual(['BREAK_GLASS', 'EMERGENCY_READ', 'TEAM_READ', 'CASE_CHANGE', 'CONFIG_CHANGE', 'REPORT', 'REMINDER']);
  });
});

describe("historique d'un dossier", () => {
  const date = (iso: string) => iso.slice(0, 10);

  test('chaque type d entrée a une phrase, jamais le code brut', () => {
    for (const type of WB_CASE_EVENTS) {
      const label = wbCaseEventLabel({ type, fromValue: null, toValue: null }, date);
      expect(label).not.toBe(type);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test('un changement de statut nomme les deux statuts', () => {
    const label = wbCaseEventLabel({ type: 'STATUS', fromValue: 'OPEN', toValue: 'CLOSED' }, date);
    expect(label).toContain(wbStatusLabel('OPEN'));
    expect(label).toContain(wbStatusLabel('CLOSED'));
  });

  test("une échéance affiche sa date", () => {
    expect(wbCaseEventLabel({ type: 'REVIEW', fromValue: null, toValue: '2026-12-01T00:00:00.000Z' }, date)).toContain('2026-12-01');
  });
});

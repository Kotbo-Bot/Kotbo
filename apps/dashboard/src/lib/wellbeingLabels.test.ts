import { describe, expect, test } from 'bun:test';
import { WB_CLOSE_REASONS, wbCloseReasonLabel, WB_ALERT_EVENTS, WB_CASE_EVENTS, wbCaseEventLabel, wbSummaryTemplate, wbIsSummaryTemplate, WB_CATEGORIES, WB_SEVERITIES, WB_STATUSES, wbAlertEventLabel, wbCategoryLabel, wbSeverityLabel, wbStatusLabel } from './wellbeingLabels';

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
    expect([...WB_ALERT_EVENTS]).toEqual(['BREAK_GLASS', 'EMERGENCY_READ', 'TEAM_READ', 'CASE_CHANGE', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS', 'DISSOLUTION', 'DISTRESS', 'SANCTION_SIGNAL']);
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

  test("une ouverture sous accès d'urgence se distingue d'une ouverture par la cellule", () => {
    const cellule = wbCaseEventLabel({ type: 'VIEWED', fromValue: null, toValue: null }, date);
    const urgence = wbCaseEventLabel({ type: 'VIEWED', fromValue: null, toValue: 'EMERGENCY' }, date);
    expect(urgence).not.toBe(cellule);
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

describe('modèles de résumé par catégorie', () => {
  test('chaque catégorie propose un modèle, différent des autres', () => {
    const templates = WB_CATEGORIES.map(wbSummaryTemplate);
    for (const template of templates) expect(template.length).toBeGreaterThan(0);
    expect(new Set(templates).size).toBe(WB_CATEGORIES.length);
  });

  test("un résumé vide ou resté sur un modèle peut être remplacé, pas un résumé écrit", () => {
    expect(wbIsSummaryTemplate('')).toBe(true);
    expect(wbIsSummaryTemplate('   ')).toBe(true);
    expect(wbIsSummaryTemplate(wbSummaryTemplate('MEDIATION'))).toBe(true);
    expect(wbIsSummaryTemplate(`${wbSummaryTemplate('MEDIATION')} et des précisions`)).toBe(false);
  });
});

describe('motifs de clôture', () => {
  test('chaque motif, et « sans motif », a un libellé', () => {
    for (const code of [...WB_CLOSE_REASONS, 'UNSPECIFIED']) expect(wbCloseReasonLabel(code)).not.toBe(code);
    expect([...WB_CLOSE_REASONS]).toEqual(['RESOLVED', 'REFERRED', 'NO_FOLLOWUP', 'DUPLICATE']);
  });
});

describe('origines et gestes ajoutés', () => {
  const date = (iso: string) => iso.slice(0, 10);

  test("un dossier venu d'un ticket ou d'un signal se distingue d'un dossier créé à la main", () => {
    const manual = wbCaseEventLabel({ type: 'CREATED', fromValue: null, toValue: null }, date);
    const ticket = wbCaseEventLabel({ type: 'CREATED', fromValue: null, toValue: 'TICKET' }, date);
    const signal = wbCaseEventLabel({ type: 'CREATED', fromValue: null, toValue: 'DISTRESS' }, date);
    expect(new Set([manual, ticket, signal]).size).toBe(3);
  });

  test('le protocole de crise dit combien d étapes il a ajoutées', () => {
    expect(wbCaseEventLabel({ type: 'CRISIS_PROTOCOL', fromValue: null, toValue: '5' }, date)).toContain('5');
  });

  test('un rappel de prise de nouvelles se distingue d une échéance', () => {
    const review = wbCaseEventLabel({ type: 'REMINDER', fromValue: null, toValue: 'review' }, date);
    const followUp = wbCaseEventLabel({ type: 'REMINDER', fromValue: null, toValue: 'follow_up' }, date);
    expect(followUp).not.toBe(review);
  });
});

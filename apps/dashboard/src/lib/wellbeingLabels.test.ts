import { describe, expect, test } from 'bun:test';
import { WB_CATEGORIES, WB_SEVERITIES, WB_STATUSES, wbCategoryLabel, wbSeverityLabel, wbStatusLabel } from './wellbeingLabels';

describe('libellés de la cellule bien-être', () => {
  test('chaque code connu a un libellé lisible, jamais le code brut', () => {
    for (const code of WB_STATUSES) expect(wbStatusLabel(code)).not.toBe(code);
    for (const code of WB_SEVERITIES) expect(wbSeverityLabel(code)).not.toBe(code);
    for (const code of WB_CATEGORIES) expect(wbCategoryLabel(code)).not.toBe(code);
  });

  test('un code inconnu est rendu tel quel plutôt que vide', () => {
    expect(wbStatusLabel('ARCHIVED')).toBe('ARCHIVED');
  });

  test('les codes suivent ceux acceptés par le bot', () => {
    expect([...WB_STATUSES]).toEqual(['OPEN', 'MONITORING', 'CLOSED']);
    expect([...WB_SEVERITIES]).toEqual(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']);
    expect([...WB_CATEGORIES]).toEqual(['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI']);
  });
});

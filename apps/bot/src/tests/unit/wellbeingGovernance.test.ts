import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ALERT_EVENTS,
  DISSOLUTION_DELAY_HOURS,
  REPORTER_REPLY_MAX,
  WELLBEING_ALERT_EVENTS,
  alertPreviews,
  alertText,
  dissolutionDate,
  dissolutionDue,
  emptiesComposition,
  journalCsv,
} from '../../services/staff/wellbeingPolicy';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-25T12:00:00Z');

describe('dissolution différée de la cellule', () => {
  test('prend effet 24 heures après la demande', () => {
    expect(DISSOLUTION_DELAY_HOURS).toBe(24);
    expect(dissolutionDate(NOW).getTime() - NOW.getTime()).toBe(24 * HOUR);
  });

  test("n'est appliquée qu'une fois l'échéance passée", () => {
    expect(dissolutionDue(null, NOW)).toBe(false);
    expect(dissolutionDue(new Date(NOW.getTime() + HOUR), NOW)).toBe(false);
    expect(dissolutionDue(new Date(NOW.getTime() - 1), NOW)).toBe(true);
  });

  test('vider toute la cellule revient à la dissoudre', () => {
    expect(emptiesComposition({ teamUserIds: [], teamRoleIds: [] })).toBe(true);
    expect(emptiesComposition({ teamUserIds: ['u1'], teamRoleIds: [] })).toBe(false);
    expect(emptiesComposition({ teamUserIds: [], teamRoleIds: ['r1'] })).toBe(false);
  });

  test("chaque étape est annoncée, l'alerte est cochée par défaut", () => {
    expect(WELLBEING_ALERT_EVENTS).toContain('DISSOLUTION');
    expect(DEFAULT_ALERT_EVENTS).toContain('DISSOLUTION');
    const until = new Date(NOW.getTime() + 24 * HOUR);
    const requested = alertText('DISSOLUTION', { actorId: '200000000000000001', stage: 'dissolution_requested', expiresAt: until });
    expect(requested).toContain('<@200000000000000001>');
    expect(requested).toContain(`<t:${Math.floor(until.getTime() / 1000)}:R>`);
    expect(alertText('DISSOLUTION', { actorId: '1', stage: 'dissolution_cancelled' })).not.toBe(requested);
    expect(alertText('DISSOLUTION', { actorId: '', stage: 'dissolution_applied' })).not.toBe(requested);
  });
});

describe('réponse au signaleur', () => {
  test('un message court', () => {
    expect(REPORTER_REPLY_MAX).toBe(500);
  });
});

describe('journal exportable', () => {
  const rows = [
    { date: new Date('2026-11-20T10:00:00Z'), source: 'audit', actor: 'alice', action: 'Consultation', details: 'Accès d\'urgence : dossier c1 ouvert.' },
    { date: new Date('2026-11-21T10:00:00Z'), source: 'break-glass', actor: 'dir', action: 'APPROVED', details: '=HYPERLINK("x")' },
  ];

  test('une ligne d en-tête, puis une ligne par entrée', () => {
    const lines = journalCsv(rows).trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('date,source,auteur,action,details');
    expect(lines[1]).toContain('2026-11-20T10:00:00.000Z');
  });

  test('les guillemets sont doublés et une formule ne peut pas s exécuter dans un tableur', () => {
    const csv = journalCsv(rows);
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"Accès d\'urgence : dossier c1 ouvert."');
  });
});

describe('aperçu des alertes', () => {
  test('un texte lisible par événement, sans mention ni date Discord brute', () => {
    const previews = alertPreviews('alice', NOW);
    expect(Object.keys(previews).sort()).toEqual([...WELLBEING_ALERT_EVENTS].sort());
    for (const text of Object.values(previews)) {
      expect(text).not.toContain('<@');
      expect(text).not.toContain('<t:');
    }
    expect(previews.BREAK_GLASS).toContain('@alice');
  });
});

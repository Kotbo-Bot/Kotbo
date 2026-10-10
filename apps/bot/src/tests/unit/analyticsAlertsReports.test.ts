import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';

const mockDb = {};
const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));

const { periodKeyOf, evaluateCondition, inCooldown, validateAlertRule, supportsWindow } = await import('../../services/analytics/analyticsAlertsService');
const { computeNextRun, reportRange, validateReportSchedule } = await import('../../services/analytics/analyticsReportService');

const NOW = Date.parse('2026-10-03T10:20:00Z');

describe('alertes', () => {
  test('période évaluée : dernière heure complète, veille, semaine glissante', () => {
    expect(periodKeyOf('hour', 'messages', NOW)).toBe('2026-10-03T09');
    expect(periodKeyOf('day', 'messages', NOW)).toBe('2026-10-02');
    expect(periodKeyOf('week', 'messages', NOW)).toBe('2026-10-02:w');
  });

  test('conditions relatives et absolues', () => {
    expect(evaluateCondition('drop_pct', 30, 60, 100)).toBe(true);
    expect(evaluateCondition('drop_pct', 30, 80, 100)).toBe(false);
    expect(evaluateCondition('rise_pct', 50, 160, 100)).toBe(true);
    expect(evaluateCondition('drop_pct', 30, 0, 0)).toBe(false);
    expect(evaluateCondition('above', 200, 201, null)).toBe(true);
    expect(evaluateCondition('below', 10, 12, null)).toBe(false);
  });

  test('une règle déclenchée se tait pendant son délai', () => {
    expect(inCooldown(new Date(NOW - 3600_000), 24, NOW)).toBe(true);
    expect(inCooldown(new Date(NOW - 25 * 3600_000), 24, NOW)).toBe(false);
    expect(inCooldown(null, 24, NOW)).toBe(false);
  });

  test('le rythme d’un salon ne s’évalue qu’à l’heure, les sanctions jamais à l’heure', () => {
    expect(supportsWindow('channelRate', 'day')).toBe(false);
    expect(supportsWindow('sanctions', 'hour')).toBe(false);
  });

  test('validation : destinataire obligatoire, salon requis pour le rythme', () => {
    const base = { name: 'Baisse', metric: 'messages', condition: 'drop_pct', threshold: 30, window: 'day', notifyChannelId: '123456789012345678' };
    expect(validateAlertRule(base)).toMatchObject({ name: 'Baisse', cooldownHours: 24, notifyUserIds: [] });
    expect(validateAlertRule({ ...base, notifyChannelId: null })).toBe('recipients');
    expect(validateAlertRule({ ...base, metric: 'channelRate', window: 'hour' })).toBe('channelId');
  });
});

describe('rapports', () => {
  test('hebdomadaire : prochain lundi 9 h, heure de Paris', () => {
    // 2026-10-03 est un samedi ; lundi 5 octobre 9 h à Paris = 7 h UTC.
    const next = computeNextRun({ frequency: 'weekly', weekday: 1, monthDay: 1, hour: 9 }, 'Europe/Paris', new Date(NOW));
    expect(next.toISOString()).toBe('2026-10-05T07:00:00.000Z');
  });

  test('mensuel : le jour choisi du mois suivant si celui du mois est passé', () => {
    const next = computeNextRun({ frequency: 'monthly', weekday: 1, monthDay: 1, hour: 9 }, 'UTC', new Date(NOW));
    expect(next.toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });

  test('période couverte : 7 jours d’avant, ou le mois civil écoulé', () => {
    expect(reportRange('weekly', '2026-10-05')).toMatchObject({ start: '2026-09-28', end: '2026-10-04', days: 7 });
    expect(reportRange('monthly', '2026-10-01')).toMatchObject({ start: '2026-09-01', end: '2026-09-30', days: 30 });
  });

  test('validation : sections par défaut, bornes des réglages', () => {
    const r = validateReportSchedule({ frequency: 'weekly', hour: 40, channelId: '123456789012345678' });
    expect(r).toMatchObject({ hour: 23, sections: ['overview', 'top_members', 'top_channels', 'anomalies'] });
    expect(validateReportSchedule({ frequency: 'daily', channelId: '123456789012345678' })).toBe('frequency');
  });
});

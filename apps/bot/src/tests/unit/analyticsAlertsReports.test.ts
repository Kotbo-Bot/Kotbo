import { beforeEach, describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';

type AlertEventArgs = { data: { ruleId: string; value: number } };
type AlertRuleUpdateArgs = { where: { id: string }; data: Record<string, unknown> };

const alertRules: Array<Record<string, unknown>> = [];
const ruleUpdate = mock(async (_args: AlertRuleUpdateArgs) => ({}));
const eventCreate = mock(async (_args: AlertEventArgs) => ({}));
const mockDb = {
  analyticsAlertRule: { findMany: mock(async () => alertRules), update: ruleUpdate },
  analyticsAlertEvent: { create: eventCreate },
  $transaction: mock(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  guild: { findUnique: mock(async ({ where }: { where: { id: string } }) => ({ id: where.id, analyticsEnabled: true, language: 'fr' })) },
};
const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));

const { periodKeyOf, evaluateCondition, inCooldown, validateAlertRule, supportsWindow, runAnalyticsAlerts } = await import('../../services/analytics/analyticsAlertsService');
const { liveMessage } = await import('../../services/analytics/analyticsLiveService');
const { activatedGuilds } = await import('../../utils/activation');
// La fenêtre temps réel compte son âge depuis le chargement de son module.
const DEMARRAGE = Date.now();
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

describe('alertes sur le rythme d’un salon', () => {
  const GUILD = '400000000000000001';
  const NOTIFY = '400000000000000002';
  const send = mock(async (_payload: unknown) => ({ id: 'alerte' }));
  const client = {
    guilds: {
      cache: new Map([[GUILD, {
        id: GUILD,
        name: 'Serveur test',
        preferredLocale: 'fr',
        channels: { cache: new Map([[NOTIFY, { isTextBased: () => true, send }]]) },
      }]]),
    },
  } as unknown as Client;
  const rule = (id: string, channelId: string, condition: 'above' | 'below', threshold: number) => ({
    id, guildId: GUILD, name: id, metric: 'channelRate', condition, threshold, window: 'hour', channelId,
    notifyChannelId: NOTIFY, notifyUserIds: [], enabled: true, cooldownHours: 1, lastPeriodKey: null, lastTriggeredAt: null,
  });
  const declenchees = () => eventCreate.mock.calls.map(([args]) => args.data.ruleId);
  const periodesEvaluees = () => ruleUpdate.mock.calls.filter(([args]) => 'lastPeriodKey' in args.data).map(([args]) => args.where.id);

  beforeEach(() => {
    alertRules.length = 0;
    send.mockClear();
    ruleUpdate.mockClear();
    eventCreate.mockClear();
    activatedGuilds.add(GUILD);
  });

  test('un salon hors du top 6 est lu à son vrai débit', async () => {
    const now = DEMARRAGE + 45 * 60_000;
    // Six salons plus actifs que le salon suivi, qui reçoit 5 messages en 30 min (10 par heure).
    for (let s = 0; s < 6; s++) {
      for (let i = 0; i < 10; i++) liveMessage(GUILD, `400000000000000${100 + s}`, `membre-${i}`, now - 60_000);
    }
    for (let i = 0; i < 5; i++) liveMessage(GUILD, '400000000000000200', `membre-${i}`, now - 60_000);
    alertRules.push(
      rule('en-dessous-de-4', '400000000000000200', 'below', 4),
      rule('au-dessus-de-8', '400000000000000200', 'above', 8),
    );

    await runAnalyticsAlerts(client, now);

    expect(periodesEvaluees()).toEqual(['en-dessous-de-4', 'au-dessus-de-8']);
    expect(declenchees()).toEqual(['au-dessus-de-8']);
    expect(eventCreate.mock.calls[0]![0].data.value).toBe(10);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('juste après un démarrage, la fenêtre vide ne déclenche rien et la période reste à évaluer', async () => {
    alertRules.push(rule('salon-calme', '400000000000000300', 'below', 4));

    await runAnalyticsAlerts(client, DEMARRAGE + 5 * 60_000);

    expect(periodesEvaluees()).toEqual([]);
    expect(declenchees()).toEqual([]);
    expect(send).not.toHaveBeenCalled();

    // Une fois la fenêtre remplie depuis le démarrage, le même salon resté
    // muet est bien évalué, et la règle se déclenche à juste titre.
    await runAnalyticsAlerts(client, DEMARRAGE + 31 * 60_000);

    expect(periodesEvaluees()).toEqual(['salon-calme']);
    expect(declenchees()).toEqual(['salon-calme']);
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
    expect(r).toMatchObject({ hour: 23, sections: ['kotbo_work', 'overview', 'top_members', 'top_channels', 'anomalies'] });
    expect(validateReportSchedule({ frequency: 'daily', channelId: '123456789012345678' })).toBe('frequency');
  });
});

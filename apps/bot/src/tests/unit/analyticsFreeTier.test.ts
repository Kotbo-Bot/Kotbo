import { describe, expect, test } from 'bun:test';
import { FREE_ANALYTICS_DAYS } from '@kotbo/contracts';
import { applyFreeAnalyticsLimits } from '../../api/routes/dashboard/analyticsFreeTier.js';

const parts = (...rest: string[]) => ['api', 'dashboard', 'guilds', '123', 'analytics', ...rest];

describe('Analytics en gratuit', () => {
  test('ramène la période dans la fenêtre gratuite et retire les filtres', () => {
    const params = new URLSearchParams('period=365&startDate=2026-01-01&endDate=2026-10-01&channel=1&role=2&excludeStaff=1&tz=UTC');
    expect(applyFreeAnalyticsLimits(parts(), 'GET', params)).toBe(true);
    expect(params.get('period')).toBe(String(FREE_ANALYTICS_DAYS));
    expect(params.get('days')).toBe(String(FREE_ANALYTICS_DAYS));
    for (const key of ['startDate', 'endDate', 'channel', 'role', 'excludeStaff']) expect(params.has(key)).toBe(false);
    expect(params.get('tz')).toBe('UTC');
  });

  test('garde une période plus courte que la fenêtre', () => {
    const params = new URLSearchParams('period=1');
    applyFreeAnalyticsLimits(parts('activity'), 'GET', params);
    expect(params.get('period')).toBe('1');
  });

  test('ferme les analyses avancées', () => {
    for (const route of ['audience', 'conversation', 'insights', 'climate', 'reports', 'commands', 'interactions']) {
      expect(applyFreeAnalyticsLimits(parts(route, 'x'), 'GET', new URLSearchParams())).toBe(false);
    }
  });

  test('alertes, vues et notes : lecture seule', () => {
    expect(applyFreeAnalyticsLimits(parts('alerts'), 'GET', new URLSearchParams())).toBe(true);
    expect(applyFreeAnalyticsLimits(parts('alerts'), 'POST', new URLSearchParams())).toBe(false);
    expect(applyFreeAnalyticsLimits(parts('views'), 'POST', new URLSearchParams())).toBe(false);
  });

  test('laisse passer les vues de base', () => {
    for (const route of ['activity', 'heatmap', 'members', 'content', 'rescan-members']) {
      expect(applyFreeAnalyticsLimits(parts(route), route === 'rescan-members' ? 'POST' : 'GET', new URLSearchParams())).toBe(true);
    }
  });
});

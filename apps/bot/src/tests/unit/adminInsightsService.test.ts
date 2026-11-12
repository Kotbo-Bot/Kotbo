import { describe, expect, test } from 'bun:test';
import { clampDays, dateKeysBack, deltaPercent, foldHeat, scoreGuildHealth } from '../../services/analytics/adminInsightsService.js';

const NOW = Date.UTC(2026, 10, 12, 12);

describe('adminInsightsService', () => {
  test('clampDays borne la période entre 7 et 90 jours', () => {
    expect(clampDays(null)).toBe(30);
    expect(clampDays('abc')).toBe(30);
    expect(clampDays('1')).toBe(7);
    expect(clampDays('400')).toBe(90);
    expect(clampDays('14')).toBe(14);
  });

  test('dateKeysBack rend les jours du plus ancien au plus récent, aujourd’hui inclus', () => {
    expect(dateKeysBack(3, NOW)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });

  test('foldHeat range par jour de semaine, lundi en premier', () => {
    // Le 2026-11-09 est un lundi, le 2026-11-15 un dimanche.
    const grid = foldHeat([
      { dateKey: '2026-11-09', hour: 8, value: 5 },
      { dateKey: '2026-11-16', hour: 8, value: 2 },
      { dateKey: '2026-11-15', hour: 23, value: 4 },
      { dateKey: '2026-11-15', hour: 24, value: 99 },
    ]);
    expect(grid[0][8]).toBe(7);
    expect(grid[6][23]).toBe(4);
    expect(grid.flat().reduce((sum, value) => sum + value, 0)).toBe(11);
  });

  test('deltaPercent ne divise pas par une période vide', () => {
    expect(deltaPercent(10, 0)).toBeNull();
    expect(deltaPercent(150, 100)).toBe(50);
  });

  const healthy = {
    activated: true,
    onboardingDone: true,
    accessExpiresAt: null,
    enabledModules: 6,
    memberCount: 200,
    messages: Array<number>(14).fill(120),
    activeMembers: Array<number>(14).fill(30),
    joined: 12,
    left: 4,
  };

  test('un serveur actif et configuré a la note maximale', () => {
    const { score, signals } = scoreGuildHealth(healthy, NOW);
    expect(score).toBe(100);
    expect(signals).toHaveLength(1);
    expect(signals[0].tone).toBe('success');
  });

  test('un serveur muet, non activé et sans module est signalé pour chaque raison', () => {
    const { score, signals } = scoreGuildHealth(
      { ...healthy, activated: false, enabledModules: 0, messages: Array<number>(14).fill(0), activeMembers: Array<number>(14).fill(0) },
      NOW,
    );
    expect(score).toBeLessThanOrEqual(25);
    expect(signals.filter((signal) => signal.tone === 'danger')).toHaveLength(1);
    expect(signals.length).toBeGreaterThanOrEqual(3);
  });

  test('une chute d’activité et une expiration proche font baisser la note', () => {
    const { score, signals } = scoreGuildHealth(
      { ...healthy, messages: [...Array<number>(7).fill(200), ...Array<number>(7).fill(50)], accessExpiresAt: new Date(NOW + 86_400_000) },
      NOW,
    );
    expect(score).toBe(75);
    expect(signals.map((signal) => signal.label).join(' ')).toContain('baisse de 75 %');
  });
});

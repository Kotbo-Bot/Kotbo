import { describe, expect, test } from 'bun:test';
import { admitJob, isLate, nextConcurrency, QUEUE_LIMITS } from '../../services/moderation/aegis/aegisQueue';

const limits = { ...QUEUE_LIMITS, maxDepth: 100 };

describe('admitJob', () => {
  test('sous le plafond, tout entre', () => {
    expect(admitJob(0, limits)).toBe('queued');
    expect(admitJob(99, limits)).toBe('queued');
  });

  test('au plafond, plus rien n’entre', () => {
    expect(admitJob(100, limits)).toBe('dropped');
  });
});

describe('isLate', () => {
  test('au-delà du délai, la note arrive trop tard', () => {
    expect(isLate({ enqueuedAt: 0 }, QUEUE_LIMITS.staleMs)).toBe(false);
    expect(isLate({ enqueuedAt: 0 }, QUEUE_LIMITS.staleMs + 1)).toBe(true);
  });
});

describe('nextConcurrency', () => {
  const l = { ...QUEUE_LIMITS, maxConcurrency: 8, targetLatencyMs: 300 };
  const fast = { requests: 50, p50Ms: 120, overloaded: 0 };

  test('monte d’un cran tant qu’il y a du retard et que l’API répond vite', () => {
    expect(nextConcurrency(2, fast, 40, l)).toBe(3);
    expect(nextConcurrency(8, fast, 40, l)).toBe(8);
  });

  test('ne monte pas quand la file est vide', () => {
    expect(nextConcurrency(2, fast, 0, l)).toBe(2);
  });

  test('redescend quand la latence dépasse la cible', () => {
    expect(nextConcurrency(6, { requests: 50, p50Ms: 400, overloaded: 0 }, 40, l)).toBe(5);
  });

  test('divise par deux sur surcharge', () => {
    expect(nextConcurrency(6, { requests: 50, p50Ms: 700, overloaded: 0 }, 40, l)).toBe(3);
    expect(nextConcurrency(6, { requests: 50, p50Ms: 100, overloaded: 2 }, 40, l)).toBe(3);
    expect(nextConcurrency(1, { requests: 5, p50Ms: 100, overloaded: 5 }, 40, l)).toBe(1);
  });

  test('sans mesure, ne bouge pas', () => {
    expect(nextConcurrency(3, { requests: 0, p50Ms: null, overloaded: 0 }, 40, l)).toBe(3);
  });
});

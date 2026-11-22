import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const executed: Array<{ sql: string; cutoff: string }> = [];
// Premier appel d'une table : un lot plein (une 2e passe), puis un lot partiel.
let fullBatchesLeft = 1;
const mockDb = {
  $executeRawUnsafe: mock(async (sql: string, cutoff: string) => {
    executed.push({ sql, cutoff });
    if (fullBatchesLeft > 0) {
      fullBatchesLeft--;
      return 20_000;
    }
    return 3;
  }),
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { pruneOldStats } = await import('../../services/analytics/statsRetentionService.js');

describe('pruneOldStats', () => {
  test('purge chaque table par lots, avec une date limite UTC', async () => {
    const total = await pruneOldStats(800);

    // 9 tables, plus une 2e passe pour la première (lot plein).
    expect(executed).toHaveLength(10);
    expect(total).toBe(20_000 + 3 + 8 * 3);
    expect(executed.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.cutoff))).toBe(true);
    expect(executed.every((e) => e.sql.includes('"dateKey" < $1'))).toBe(true);
  });

  test('ne touche jamais aux tables de cumul historique', async () => {
    const sql = executed.map((e) => e.sql).join('\n');
    expect(sql).not.toContain('member_daily_stats"');
    expect(sql).not.toContain('guild_daily_stats');
    expect(sql).not.toContain('channel_daily_stats"');
  });
});

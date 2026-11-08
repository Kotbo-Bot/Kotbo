import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';

const mockDb = {};
for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${extension}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { summarizeReactionRoleStats } = await import('../../services/analytics/reactionRoleStatsService');

const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
const prevDays = ['2026-10-29', '2026-10-30', '2026-10-31'];

describe('summarizeReactionRoleStats', () => {
  test('additionne prises et retraits par jour et par rôle de menu', () => {
    const summary = summarizeReactionRoleStats(
      [
        { dateKey: '2026-11-01', menuId: 'couleurs', roleId: 'rouge', added: 3, removed: 1 },
        { dateKey: '2026-11-03', menuId: 'couleurs', roleId: 'rouge', added: 2, removed: 0 },
        { dateKey: '2026-11-02', menuId: 'couleurs', roleId: 'bleu', added: 1, removed: 4 },
      ],
      [],
      days,
      prevDays,
    );

    expect(summary.totals).toEqual({ added: 6, removed: 5, net: 1, previousAdded: 0, previousRemoved: 0 });
    expect(summary.daily).toEqual([
      { dateKey: '2026-11-01', added: 3, removed: 1, previousAdded: 0, previousRemoved: 0 },
      { dateKey: '2026-11-02', added: 1, removed: 4, previousAdded: 0, previousRemoved: 0 },
      { dateKey: '2026-11-03', added: 2, removed: 0, previousAdded: 0, previousRemoved: 0 },
    ]);
    expect(summary.roles).toEqual([
      { menuId: 'couleurs', roleId: 'rouge', added: 5, removed: 1, net: 4, previousAdded: 0, spark: [3, 0, 2] },
      { menuId: 'couleurs', roleId: 'bleu', added: 1, removed: 4, net: -3, previousAdded: 0, spark: [0, 1, 0] },
    ]);
  });

  test('un même rôle dans deux menus reste sur deux lignes', () => {
    const summary = summarizeReactionRoleStats(
      [
        { dateKey: '2026-11-01', menuId: 'a', roleId: 'annonces', added: 1, removed: 0 },
        { dateKey: '2026-11-01', menuId: 'b', roleId: 'annonces', added: 2, removed: 0 },
      ],
      [],
      days,
      prevDays,
    );

    expect(summary.roles.map((role) => [role.menuId, role.added])).toEqual([['b', 2], ['a', 1]]);
  });

  test('la période précédente sert aux écarts et à la courbe de comparaison', () => {
    const summary = summarizeReactionRoleStats(
      [{ dateKey: '2026-11-01', menuId: 'm', roleId: 'r', added: 1, removed: 0 }],
      [
        { dateKey: '2026-10-29', menuId: 'm', roleId: 'r', added: 4, removed: 2 },
        // Un rôle retiré du menu depuis : compté dans les totaux d'avant seulement.
        { dateKey: '2026-10-30', menuId: 'm', roleId: 'ancien', added: 1, removed: 0 },
      ],
      days,
      prevDays,
    );

    expect(summary.totals.previousAdded).toBe(5);
    expect(summary.totals.previousRemoved).toBe(2);
    // La courbe d'avant se superpose jour pour jour à celle de la période.
    expect(summary.daily.map((d) => [d.previousAdded, d.previousRemoved])).toEqual([[4, 2], [1, 0], [0, 0]]);
    expect(summary.roles).toEqual([
      { menuId: 'm', roleId: 'r', added: 1, removed: 0, net: 1, previousAdded: 4, spark: [1, 0, 0] },
    ]);
  });

  test('les rôles les plus pris passent en premier', () => {
    const summary = summarizeReactionRoleStats(
      [
        { dateKey: '2026-11-01', menuId: 'm', roleId: 'peu', added: 1, removed: 0 },
        { dateKey: '2026-11-01', menuId: 'm', roleId: 'beaucoup', added: 9, removed: 0 },
      ],
      [],
      days,
      prevDays,
    );

    expect(summary.roles.map((role) => role.roleId)).toEqual(['beaucoup', 'peu']);
  });
});

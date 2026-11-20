import { describe, expect, it } from 'bun:test';
import { groupLinks } from '../../services/moderation/adminLinkedAccountsService.js';

const link = (guildId: string, user1Id: string, user2Id: string) => ({
  guildId, user1Id, user2Id,
  type: 'MANUAL' as const,
  status: 'VALIDATED' as const,
  reason: null,
  createdAt: new Date(),
});

describe('groupLinks', () => {
  it('fusionne les liens de serveurs différents en un seul groupe', () => {
    const groups = groupLinks([link('g1', 'A', 'B'), link('g2', 'B', 'C'), link('g1', 'X', 'Y')]);
    expect(groups).toHaveLength(2);
    const sizes = groups.map((g) => new Set(g.flatMap((r) => [r.user1Id, r.user2Id])).size).sort();
    expect(sizes).toEqual([2, 3]);
  });

  it('relie deux groupes quand un lien les rejoint', () => {
    const groups = groupLinks([link('g1', 'A', 'B'), link('g1', 'C', 'D'), link('g2', 'B', 'C')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });
});

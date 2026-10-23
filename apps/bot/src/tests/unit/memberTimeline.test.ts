import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const calls: string[] = [];
const empty = (name: string) => ({ findMany: async () => { calls.push(name); return []; } });
const mockDb: Record<string, unknown> = {
  memberInvite: {
    findMany: async ({ where }: { where: { inviterId?: string } }) => {
      calls.push(where.inviterId ? 'invited' : 'joins');
      if (where.inviterId) return [];
      return [
        { id: 'j1', joinedAt: new Date('2026-09-01T10:00:00Z'), leftAt: new Date('2026-09-20T10:00:00Z'), inviteCode: 'abc', inviterId: '1', inviterTag: 'bob' },
      ];
    },
  },
  memberProfile: empty('profiles'),
  sanction: {
    findMany: async () => {
      calls.push('sanctions');
      return [{ id: 's1', type: 'TIMEOUT', status: 'RESOLVED', reason: 'Spam', durationSeconds: 600, moderatorUserId: '2', moderatorTag: 'modo', createdAt: new Date('2026-09-10T10:00:00Z'), resolvedAt: new Date('2026-09-10T10:10:00Z'), resolutionNote: null, archivedAt: null }];
    },
  },
  memberReport: empty('reports'),
  banAppeal: empty('appeals'),
  linkedAccount: empty('links'),
  securityVerification: empty('verifications'),
  ticket: empty('tickets'),
  ticketSatisfaction: empty('ratings'),
  suggestion: empty('suggestions'),
  customFormSubmission: empty('forms'),
  giveaway: empty('giveaways'),
  reputationVote: empty('rep'),
  auditEvent: empty('audit'),
};
for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { describeAuditEvent, getMemberTimeline, mergeTimeline } = await import('../../services/moderation/memberTimelineService.js');

describe('chronologie du membre', () => {
  test('fusionne les sources du plus récent au plus ancien', async () => {
    const { items, nextBefore } = await getMemberTimeline('g', 'u', { limit: 10 });
    expect(items.map((item) => item.type)).toEqual(['member.left', 'sanction.revoked', 'sanction.applied', 'member.joined']);
    expect(items[2].title).toBe('Mise en sourdine (10 min)');
    expect(nextBefore).toBeNull();
  });

  test('donne un curseur quand la page est pleine', async () => {
    const { items, nextBefore } = await getMemberTimeline('g', 'u', { limit: 5 });
    expect(items.length).toBe(4);
    expect(nextBefore).toBeNull();
    const merged = mergeTimeline([[{ id: 'a', at: '2026-01-02T00:00:00Z' } as never], [{ id: 'b', at: '2026-01-03T00:00:00Z' } as never]], 1);
    expect(merged.map((item) => item.id)).toEqual(['b']);
  });

  test("n'interroge que les catégories demandées", async () => {
    calls.length = 0;
    await getMemberTimeline('g', 'u', { categories: ['support'] });
    expect(calls.sort()).toEqual(['ratings', 'tickets']);
  });

  test('une source en panne ne vide pas la chronologie', async () => {
    const original = mockDb.ticket;
    mockDb.ticket = { findMany: async () => { throw new Error('panne'); } };
    const { items } = await getMemberTimeline('g', 'u', {});
    expect(items.length).toBe(4);
    mockDb.ticket = original;
  });

  test('libellés des changements Discord', () => {
    expect(describeAuditEvent('MEMBER_UPDATE', ['nick', 'roles'])).toBe('Modification : pseudo, rôles');
    expect(describeAuditEvent('MEMBER_UPDATE', ['inconnu'])).toBe('Événement Discord member update');
  });
});

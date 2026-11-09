import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';

const mockDb = {};
const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { creerIssueCopie, summarizeLinkStats } = await import('../../services/features/channelLinkStatsService');

describe('creerIssueCopie', () => {
  test('copie livrée puis correspondance en échec : comptée une seule fois, en reçue', () => {
    const comptes: string[] = [];
    const issue = creerIssueCopie((c) => comptes.push(c));
    issue.livree();
    issue.echouee();
    expect(comptes).toEqual(['received']);
  });

  test('copie jamais livrée : comptée en échec', () => {
    const comptes: string[] = [];
    creerIssueCopie((c) => comptes.push(c)).echouee();
    expect(comptes).toEqual(['failed']);
  });
});

describe('summarizeLinkStats', () => {
  test('totaux par pont, par salon et courbe des envois jour par jour', () => {
    const days = ['2026-11-06', '2026-11-07', '2026-11-08'];
    const stats = summarizeLinkStats([
      { groupId: 'g1', dateKey: '2026-11-06', guildId: 'a', channelId: '1', sent: 3, received: 1, failed: 0 },
      { groupId: 'g1', dateKey: '2026-11-08', guildId: 'a', channelId: '1', sent: 2, received: 0, failed: 1 },
      { groupId: 'g1', dateKey: '2026-11-08', guildId: 'b', channelId: '2', sent: 1, received: 5, failed: 0 },
      { groupId: 'g2', dateKey: '2026-11-07', guildId: 'a', channelId: '9', sent: 4, received: 0, failed: 0 },
    ], days);

    const g1 = stats.get('g1')!;
    expect({ sent: g1.sent, received: g1.received, failed: g1.failed }).toEqual({ sent: 6, received: 6, failed: 1 });
    expect(g1.daily).toEqual([3, 0, 3]);
    expect(g1.channels['a:1']).toEqual({ sent: 5, received: 1, failed: 1 });
    expect(g1.channels['b:2']).toEqual({ sent: 1, received: 5, failed: 0 });
    expect(stats.get('g2')!.daily).toEqual([0, 4, 0]);
    expect(stats.has('g3')).toBe(false);
  });
});

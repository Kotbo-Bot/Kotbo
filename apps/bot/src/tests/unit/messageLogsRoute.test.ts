import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN } from '../../api/shared.js';
import { dashboardCall, mockDashboardGate } from '../helpers/honoDashboard.js';

let storedRows: Array<{ id: string }> = [];
const mockFindMany = mock(async (args: { skip: number; take: number }) =>
  storedRows.slice(args.skip, args.skip + args.take),
);
const mockCount = mock(async (args: { take?: number }) =>
  args.take === undefined ? storedRows.length : Math.min(storedRows.length, args.take),
);
const mockDb = {
  messageLog: {
    findMany: mockFindMany,
    count: mockCount,
  },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

// Import après les mocks
mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: 'user-1', username: 'Admin' });
const { createMessageLogsRouter } = await import('../../api/routes/dashboard/messageLogs.js');

const mockClient = {} as Client;

async function search(query: string) {
  const { status, body } = await dashboardCall(createMessageLogsRouter(mockClient), 'GET', `/api/dashboard/guilds/guild-1/message-logs/search?${query}`);
  return { status, body };
}

function seed(count: number) {
  storedRows = Array.from({ length: count }, (_, i) => ({ id: `m${i}` }));
}

describe('handleMessageLogRoutes - recherche', () => {
  beforeEach(() => {
    mockFindMany.mockClear();
    mockCount.mockClear();
  });

  test('annonce une page suivante sans la renvoyer', async () => {
    seed(30);
    const { status, body } = await search('limit=10');

    expect(status).toBe(200);
    expect(body.messages).toHaveLength(10);
    expect(body.hasMore).toBeTrue();
    expect(body.total).toBe(30);
    expect(body.totalCapped).toBeFalse();
  });

  test('ne signale plus de page suivante sur la derniere', async () => {
    seed(30);
    const { body } = await search('limit=10&offset=20');

    expect(body.messages).toHaveLength(10);
    expect(body.hasMore).toBeFalse();
  });

  test('plafonne le comptage au lieu de parcourir tous les resultats', async () => {
    seed(1500);
    const { body } = await search('limit=50');

    expect(mockCount).toHaveBeenCalledTimes(1);
    expect(mockCount.mock.calls[0][0].take).toBe(1001);
    expect(body.total).toBe(1000);
    expect(body.totalCapped).toBeTrue();
    expect(body.hasMore).toBeTrue();
  });
});

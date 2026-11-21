import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const rows = [
  { id: 'w1', guildId: 'g1', name: 'Hors droits', graph: { nodes: [], edges: [] }, createdById: 'mod-1' },
  { id: 'w2', guildId: 'g1', name: 'Dans les droits', graph: { nodes: [], edges: [] }, createdById: 'mod-2' },
  { id: 'w3', guildId: 'g1', name: 'Créateur parti', graph: { nodes: [], edges: [] }, createdById: 'gone' },
  { id: 'w4', guildId: 'g1', name: 'Graphe illisible', graph: null, createdById: 'mod-1' },
];
const mockDb = { workflow: { findMany: mock(async () => rows), updateMany: mock(async () => ({ count: 1 })) } };

for (const suffix of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({ default: mockDb, prisma: mockDb }));
}
for (const suffix of ['../../utils/logger.ts', '../../utils/logger.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} },
  }));
}
// Les gardes et le service sont injectés : on ne charge pas leurs dépendances.
for (const suffix of ['../../api/shared/workflowActorGuard.ts', '../../api/shared/workflowActorGuard.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({ workflowActorRefusal: async () => null }));
}
for (const suffix of ['../../services/features/workflow/workflowService.ts', '../../services/features/workflow/workflowService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => ({ setWorkflowEnabled: async () => true }));
}

const { rescanWorkflowActorRights } = await import('../../services/features/workflow/workflowActorRescan');

describe('rescanWorkflowActorRights', () => {
  test('désactive seulement les workflows qui dépassent les droits d\'un créateur encore membre', async () => {
    const disabled: string[] = [];
    const count = await rescanWorkflowActorRights({ guilds: { cache: new Map([['g1', {}]]) } } as never, {
      refusalFor: async (_g, userId) => (userId === 'mod-1' ? 'rôle trop haut' : null),
      isMember: async (_g, userId) => userId !== 'gone',
      disable: async (_g, id) => { disabled.push(id); },
    });

    expect(count).toBe(1);
    // w1 : refusé ; w2 : conforme ; w3 : créateur parti ; w4 : graphe illisible.
    expect(disabled).toEqual(['w1']);
  });
});

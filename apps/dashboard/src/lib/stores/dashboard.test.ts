import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

// Bun ne compile pas les runes : un `$state` inerte suffit, le test ne lit pas la réactivité.
Object.assign(globalThis, { $state: <T>(valeur: T) => valeur });

mock.module(path.resolve(import.meta.dir, '../api/index.ts'), () => ({
  fetchGuildState: async () => ({ moduleStates: { fun: false } }),
  fetchApprenticeProgress: async () => ({ progress: null }),
  isDashboardApiError: () => false,
}));
mock.module(path.resolve(import.meta.dir, 'auth.svelte.ts'), () => ({ authStore: { token: 'jeton', selectedGuildId: 'g1' } }));

// Chemin opaque pour tsc, qui ne connaît pas les runes du store.
const { dashboardStore } = await import('./dashboard.svelte' as string);

describe('rafraîchissement du store', () => {
  test('reprend l’état des modules appliqué par le bot', async () => {
    await dashboardStore.refresh({ full: true });
    expect(dashboardStore.state.moduleStates).toEqual({ fun: false });
  });
});

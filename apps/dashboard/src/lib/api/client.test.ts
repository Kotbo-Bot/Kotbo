import { describe, expect, mock, spyOn, test } from 'bun:test';
import path from 'node:path';

const modules: Record<string, Record<string, unknown>> = {
  'stores/auth.svelte.ts': { authStore: { token: 'jeton', selectedGuildId: 'g', guilds: [] } },
  'stores/backendHealth.svelte.ts': { backendHealth: { canWrite: true, reportFailure() {}, reportSuccess() {} } },
  'stores/toast.svelte.ts': { toast: {} },
  'sentry.ts': { captureApiFailure() {} },
  'telemetry/telemetry.ts': { trackApiResult() {} },
};
for (const [file, exports] of Object.entries(modules)) mock.module(path.resolve(import.meta.dir, '..', file), () => exports);

const { dashboardFetch } = await import('./client');

describe('requête annulée par l\'appelant', () => {
  test('elle n\'est pas rejouée et remonte comme une annulation', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Annulée', 'AbortError'));
    const controller = new AbortController();
    controller.abort();

    await expect(dashboardFetch('/staff/discord-members', { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

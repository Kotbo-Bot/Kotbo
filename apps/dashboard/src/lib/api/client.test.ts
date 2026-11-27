import { describe, expect, mock, spyOn, test } from 'bun:test';
import path from 'node:path';

const modules: Record<string, Record<string, unknown>> = {
  'stores/auth.svelte.ts': { authStore: { token: 'jeton', selectedGuildId: 'g', guilds: [] } },
  'stores/backendHealth.svelte.ts': { backendHealth: { canWrite: true, reportFailure() {}, reportSuccess() {} } },
  'stores/toast.svelte.ts': { toast: {} },
  'stores/instanceBlock.svelte.ts': { instanceBlock: { report() {} } },
  'sentry.ts': { captureApiFailure() {} },
  'telemetry/telemetry.ts': { trackApiResult() {} },
};
for (const [file, exports] of Object.entries(modules)) mock.module(path.resolve(import.meta.dir, '..', file), () => exports);

const { authorizedFetch, dashboardFetch, isExpectedRefusal } = await import('./client');
const { DashboardApiError } = await import('./errors');

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

describe('instance bloquée', () => {
  test("le refus est attendu : le bandeau l'explique, sans notification ni remontée Sentry", () => {
    const error = new DashboardApiError({ kind: 'forbidden', status: 403, code: 'instance_blocked', path: '/state', method: 'GET' });
    expect(isExpectedRefusal(error)).toBe(true);
  });
});

describe('écriture sans corps', () => {
  test('annonce du JSON, sinon le bot répond 415 ; une lecture reste sans en-tête', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('{}')) as unknown as typeof fetch);
    const sent = () => new Headers(fetchSpy.mock.calls.at(-1)?.[1]?.headers).get('content-type');

    await authorizedFetch('https://api.test/onboarding/complete', { method: 'POST' });
    expect(sent()).toBe('application/json');
    await authorizedFetch('https://api.test/state');
    expect(sent()).toBeNull();
    await authorizedFetch('https://api.test/upload', { method: 'POST', body: new FormData() });
    expect(sent()).toBeNull();
    fetchSpy.mockRestore();
  });
});

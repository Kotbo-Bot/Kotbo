import { afterAll, expect, mock, test } from 'bun:test';
import path from 'node:path';

// Bun ne compile pas les runes : un `$state` inerte suffit, le test ne lit pas la réactivité.
Object.assign(globalThis, { $state: <T>(valeur: T) => valeur });

let lue!: () => void;
const apiRequest = mock(() => new Promise<void>((resolve) => { lue = resolve; }));
const assign = mock((_url: string) => undefined);

mock.module('tinro', () => ({ router: { goto: () => undefined } }));
mock.module(path.resolve(import.meta.dir, '../api/client.ts'), () => ({ apiRequest }));
mock.module(path.resolve(import.meta.dir, 'auth.svelte.ts'), () => ({
  authStore: { selectedGuildId: 'g1', guilds: [{ id: 'g1' }, { id: 'g2' }], setGuild: () => undefined },
}));
mock.module(path.resolve(import.meta.dir, '../notificationAlerts.ts'), () => ({
  announceNotifications: async () => undefined,
  onNotificationOpened: () => undefined,
}));

const g = globalThis as Record<string, unknown>;
const avant = g.window;
g.window = { location: { assign } };
afterAll(() => { g.window = avant; });

// Chemin opaque pour tsc, qui ne connaît pas les runes du store.
const { notificationsStore } = await import('./notifications.svelte' as string);

test('ouvrir la notification d’un autre serveur attend la lecture avant de recharger la page', async () => {
  const ouverture = notificationsStore.open({ id: 'n1', guildId: 'g2', link: '/tickets', isRead: false });
  await Bun.sleep(0);
  expect(apiRequest).toHaveBeenCalledTimes(1);
  expect(assign).not.toHaveBeenCalled();

  lue();
  await ouverture;
  expect(assign).toHaveBeenCalledWith('/tickets');
});

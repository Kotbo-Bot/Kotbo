import { afterAll, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

type Action = { label: string; onClick: () => Promise<void> };

const goto = mock((_path: string) => undefined);
const assign = mock((_url: string) => undefined);
const add = mock((_text: string, _type: string, _duration: number, _action: Action) => undefined);

mock.module('tinro', () => ({ router: { goto } }));
mock.module(path.resolve(import.meta.dir, 'stores/userPreferences.svelte.ts'), () => ({
  userPrefs: { prefs: { soundNotifications: false, desktopNotifications: true } },
}));
mock.module(path.resolve(import.meta.dir, 'stores/toast.svelte.ts'), () => ({ toast: { add } }));

// Onglet au premier plan : la notification s'annonce par une bulle dans la page.
const g = globalThis as Record<string, unknown>;
const avant = { window: g.window, document: g.document };
g.window = { focus: () => undefined, addEventListener: () => undefined, location: { assign } };
g.document = { visibilityState: 'visible', hasFocus: () => true, cookie: '' };
afterAll(() => Object.assign(g, avant));

const { announceNotifications, onNotificationOpened } = await import('./notificationAlerts');

const link = '/tickets?guild=222222222222222222';

describe('ouverture d\'une notification', () => {
  test('une notification d\'un autre serveur recharge la page pour basculer sur ce serveur', async () => {
    await announceNotifications([{ id: 'n1', title: 'Nouveau ticket', message: '', type: 'INFO', link }]);

    await add.mock.calls[0][3].onClick();

    expect(assign).toHaveBeenCalledWith(link);
    expect(goto).not.toHaveBeenCalled();
  });

  test('la lecture aboutit avant le rechargement, qui couperait sa requête', async () => {
    let lue!: () => void;
    onNotificationOpened(() => new Promise<void>((resolve) => { lue = resolve; }));
    assign.mockClear();
    await announceNotifications([{ id: 'n2', title: 'Nouveau ticket', message: '', type: 'INFO', link }]);

    const ouverture = add.mock.calls.at(-1)![3].onClick();
    await Bun.sleep(0);
    expect(assign).not.toHaveBeenCalled();

    lue();
    await ouverture;
    expect(assign).toHaveBeenCalledWith(link);
  });
});

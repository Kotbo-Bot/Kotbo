import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

/**
 * C1 — `/languages lang` et `/languages auto` font réécrire les panneaux vocaux
 * déjà postés quand la langue du serveur change, et seulement dans ce cas.
 */

let langueEnBase: 'fr' | 'en' | null = 'fr';
const rafraichir = mock((_client: unknown, _guildId: string) => 1);

const prismaMock = {
  guild: {
    upsert: mock(async (a: { update: { language: 'fr' | 'en' | null } }) => {
      langueEnBase = a.update.language;
      return {};
    }),
  },
};

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/cache.ts'), {
    getCachedGuild: mock(async () => ({ language: langueEnBase })),
    cache: { invalidateGuild: mock(async () => undefined) },
  })],
  ['../../services/core/panelRerenderService', () => completeModuleMock(path.resolve(import.meta.dir, '../../services/core/panelRerenderService.ts'), {
    rafraichirPanneauxVocaux: rafraichir,
    rerenderPersistentPanels: mock(async () => ({ outcomes: [], updated: 0, skipped: 0, failed: 0 })),
  })],
];
for (const [relatif, fabrique] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}

const { execute } = await import('../../commands/utility/language.js');

const GUILD = '100000000000000000';
const client = { id: 'client' };

function commande(sous: 'lang' | 'auto', langue?: 'fr' | 'en', guildLocale = 'en-US') {
  return {
    guildId: GUILD,
    guildLocale,
    locale: 'fr',
    client,
    options: { getSubcommand: () => sous, getString: () => langue ?? null },
    reply: mock(async () => undefined),
  } as never;
}

beforeEach(() => {
  rafraichir.mockClear();
  langueEnBase = 'fr';
});

describe('C1 — un changement de langue réécrit les panneaux vocaux', () => {
  test('/languages lang fr → en : réécriture demandée pour ce serveur', async () => {
    await execute(commande('lang', 'en'));
    expect(rafraichir).toHaveBeenCalledTimes(1);
    expect(rafraichir.mock.calls[0]).toEqual([client, GUILD]);
  });

  test('/languages lang dans la langue déjà en place : rien à réécrire', async () => {
    await execute(commande('lang', 'fr'));
    expect(rafraichir).not.toHaveBeenCalled();
  });

  test('/languages auto, serveur Discord en anglais alors que le choix était fr : réécriture', async () => {
    await execute(commande('auto', undefined, 'en-US'));
    expect(rafraichir).toHaveBeenCalledTimes(1);
  });

  test('/languages auto qui retombe sur la même langue : rien à réécrire', async () => {
    await execute(commande('auto', undefined, 'fr'));
    expect(rafraichir).not.toHaveBeenCalled();
  });
});

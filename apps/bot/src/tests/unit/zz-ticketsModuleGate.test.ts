/**
 * Les traitements des tickets qui ne naissent pas d'une interaction respectent
 * l'activation du module.
 *
 * Le relais des MP et la reprise de la file d'attente tournaient hors de toute
 * garde : un serveur qui avait coupé les tickets voyait encore les MP de ses
 * membres arriver dans les fils, et les tickets en attente s'ouvrir.
 *
 * Préfixe `zz-` : ce fichier pose un `mock.module` sur `utils/db`,
 * `utils/cache` et `moduleGate` (`mock.module` est global au process).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = 'guilde-tickets';

let ticketsActif = true;

const fauxPrisma = {
  ticket: {
    findFirst: mock(async () => ({ id: 'ticket-1', guildId: GUILD_ID, threadId: 'fil-1', isAnonymous: false })),
    findMany: mock(async () => []),
    update: mock(async () => ({})),
  },
  guild: { findUnique: mock(async () => null) },
};

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () =>
      completeModuleMock(source, overrides));
  }
}

mockerModule('../../utils/db', { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma });
mockerModule('../../utils/cache', { getCachedGuild: mock(async () => ({ language: 'fr' })) });
mockerModule('../../services/core/moduleGate', {
  isModuleEnabled: mock(async (_guildId: string, moduleKey: string) => moduleKey !== 'tickets' || ticketsActif),
});

const { relayDmToThread } = await import('../../services/features/ticketService.js');
const { drainTicketQueue } = await import('../../services/features/ticketQueueService.js');

const fetchSalon = mock(async () => null);
const client = {
  channels: { fetch: fetchSalon },
  guilds: { cache: new Map([[GUILD_ID, { id: GUILD_ID, preferredLocale: 'fr' }]]) },
} as never;

function messagePrive() {
  return {
    author: { id: 'membre-1', bot: false, username: 'membre' },
    guild: null,
    content: 'bonjour',
    attachments: new Map(),
    createdAt: new Date(),
    react: mock(async () => undefined),
  } as never;
}

beforeEach(() => {
  ticketsActif = true;
  fetchSalon.mockClear();
  fauxPrisma.ticket.findMany.mockClear();
});

describe('relais des MP vers le fil du ticket', () => {
  test('tickets éteints : le MP n\'est pas relayé', async () => {
    ticketsActif = false;
    await relayDmToThread(client, messagePrive());
    expect(fetchSalon).not.toHaveBeenCalled();
  });

  test('tickets allumés : le fil du ticket est recherché', async () => {
    await relayDmToThread(client, messagePrive());
    expect(fetchSalon).toHaveBeenCalledWith('fil-1');
  });
});

describe('reprise de la file d\'attente', () => {
  test('tickets éteints : la file n\'est pas lue', async () => {
    ticketsActif = false;
    await drainTicketQueue(client, GUILD_ID);
    expect(fauxPrisma.ticket.findMany).not.toHaveBeenCalled();
  });

  test('tickets allumés : la file est lue', async () => {
    await drainTicketQueue(client, GUILD_ID);
    expect(fauxPrisma.ticket.findMany).toHaveBeenCalled();
  });
});

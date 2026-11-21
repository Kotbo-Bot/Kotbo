import { expect, mock, test } from 'bun:test';
import path from 'node:path';
import { PermissionFlagsBits, TextChannel } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

// Clos sans avoir jamais été pris en charge.
const TICKET = { id: 'ticket-1', channelId: 'salon-ticket', threadId: null, mode: 'CHANNEL', userId: 'auteur', staffRoleId: null, status: 'CLOSED', lockUntilClaim: true };

const prismaMock = {
  guild: { findUnique: async () => ({ id: 'g1' }) },
  ticket: { findFirst: async () => TICKET, update: async () => TICKET },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock }));
  mock.module(path.resolve(import.meta.dir, `../../utils/cache.${ext}`), () =>
    completeModuleMock(path.resolve(import.meta.dir, '../../utils/cache.ts'), { getCachedGuild: async () => ({ language: 'fr' }) }));
}

// Le registre d'abord, comme en production : chargé depuis `ticket.ts`, il
// lirait `ticketCommand` avant son initialisation.
await import('../../commands.js');
const { ticketCommand } = await import('../../commands/utility/ticket.js');

test('/ticket reopen répond sans attendre le renommage et garde l’écriture fermée jusqu’à la prise en charge', async () => {
  const edit = mock(async (_id: string, _droits: { SendMessages?: boolean }) => undefined);
  const salon = Object.assign(Object.create(TextChannel.prototype), {
    id: TICKET.channelId,
    name: 'fermer-0001',
    // Renommage plafonné par Discord : il peut attendre plusieurs minutes.
    setName: () => new Promise(() => {}),
    permissionOverwrites: { edit },
    send: async () => undefined,
  });
  const interaction = {
    guildId: 'g1',
    channel: salon,
    client: { channels: { cache: new Map([[salon.id, salon]]), fetch: async () => salon } },
    user: { id: 'staff' },
    member: { permissions: PermissionFlagsBits.Administrator.toString() },
    options: { getSubcommand: () => 'reopen' },
    deferReply: mock(async () => undefined),
    editReply: mock(async () => undefined),
  };

  await ticketCommand.execute(interaction as never);

  expect(interaction.editReply).toHaveBeenCalled();
  const ecritureAuteur = edit.mock.calls.filter(([id]) => id === 'auteur').map(([, droits]) => droits.SendMessages);
  expect(ecritureAuteur.at(-1)).toBe(false);
}, 1000);

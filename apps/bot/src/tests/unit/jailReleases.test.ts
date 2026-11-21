import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const ICI = '100000000000000001';

/** Par échéance croissante : cinquante quarantaines de serveurs quittés, puis une d'un serveur de ce shard. */
const jails = [
  ...Array.from({ length: 50 }, (_, i) => ({ guildId: `serveur-quitte-${i}`, userId: `membre-${i}` })),
  { guildId: ICI, userId: 'membre-ici' },
];
const levees: string[] = [];

type Cle = { guildId_userId: { guildId: string; userId: string } };
const fauxPrisma = {
  memberJail: {
    findMany: async ({ where, take }: { where: { guildId?: { in: string[] } }; take: number }) =>
      jails.filter((jail) => !where.guildId || where.guildId.in.includes(jail.guildId)).slice(0, take),
    findUnique: async ({ where: { guildId_userId: cle } }: { where: Cle }) =>
      jails.find((jail) => jail.guildId === cle.guildId && jail.userId === cle.userId) ?? null,
    delete: async ({ where }: { where: Cle }) => levees.push(where.guildId_userId.userId),
  },
  sanction: { updateMany: async () => ({ count: 1 }) },
};

for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () =>
    completeModuleMock(path.resolve(import.meta.dir, '../../utils/db.ts'), { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma }));
}

const { processJailReleases } = await import('../../services/moderation/jailService.js');

describe('levée des quarantaines échues', () => {
  test('les quarantaines de serveurs quittés ne bloquent plus celles du serveur du shard', async () => {
    const client = { guilds: { cache: new Map([[ICI, { members: { fetch: async () => null } }]]) } } as unknown as Client;

    await processJailReleases(client);

    expect(levees).toEqual(['membre-ici']);
  });
});

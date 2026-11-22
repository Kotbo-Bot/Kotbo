import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const INVITANT = { guildId: '100000000000000001', channelId: '200000000000000001' };

type Member = { groupId: string; guildId: string; channelId: string };
const groups: { id: string; updateTopic: boolean; members: Member[] }[] = [];
const invite = {
  id: 'invitation-1',
  code: 'CODE',
  ...INVITANT,
  groupId: null as string | null,
  status: 'PENDING',
  uses: 0,
  maxUses: 2,
  expiresAt: new Date(Date.now() + 60_000),
};

const tx = {
  $executeRaw: mock(async () => 0),
  channelLinkInvite: {
    // La lecture voit l'état au moment où elle est lancée : les deux acceptations lisent avant d'écrire.
    findUnique: mock(async () => {
      const snapshot = { ...invite };
      await Bun.sleep(5);
      return snapshot;
    }),
    update: mock(async ({ data }: { data: Partial<typeof invite> }) => Object.assign(invite, data)),
  },
  channelLinkGroup: {
    findFirst: mock(async () => null),
    findMany: mock(async () => []),
    findUnique: mock(async ({ where }: { where: { id: string } }) => groups.find((group) => group.id === where.id) ?? null),
    create: mock(async ({ data }: { data: { updateTopic: boolean; members: { create: Omit<Member, 'groupId'> } } }) => {
      const id = `pont-${groups.length + 1}`;
      const group = { id, updateTopic: data.updateTopic, members: [{ groupId: id, ...data.members.create }] };
      groups.push(group);
      return group;
    }),
  },
  channelLinkGroupMember: {
    findFirst: mock(async ({ where }: { where: Member }) => groups.find((group) => group.id === where.groupId)
      ?.members.find((member) => member.guildId === where.guildId && member.channelId === where.channelId) ?? null),
    create: mock(async ({ data }: { data: Member }) => groups.find((group) => group.id === data.groupId)!.members.push(data)),
  },
};

// Les transactions passent l'une après l'autre, comme sous le verrou consultatif.
let file: Promise<unknown> = Promise.resolve();
const prismaMock = {
  ...tx,
  $transaction: mock((fn: (client: typeof tx) => Promise<unknown>) => {
    const run = file.then(() => fn(tx));
    file = run.catch(() => undefined);
    return run;
  }),
};

const dbSource = path.resolve(import.meta.dir, '../../utils/db.ts');
for (const suffixe of ['.ts', '.js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db${suffixe}`), () =>
    completeModuleMock(dbSource, { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock }));
}

const { activatedGuilds } = await import('../../utils/activation.js');
const { acceptLinkInvite } = await import('../../services/features/channelLinkService.js');

describe('acceptation d\'une invitation de pont', () => {
  test('deux acceptations simultanées d\'un même code n\'ouvrent qu\'un pont', async () => {
    activatedGuilds.add(INVITANT.guildId);
    const client = { guilds: { cache: new Map() } } as unknown as Client;
    const accepter = (guildId: string) =>
      acceptLinkInvite({ code: 'CODE', targetGuildId: guildId, targetChannelId: guildId, updateTopic: false, client });

    await Promise.all([accepter('100000000000000002'), accepter('100000000000000003')]);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((member) => member.guildId))
      .toEqual([INVITANT.guildId, '100000000000000002', '100000000000000003']);
  });
});

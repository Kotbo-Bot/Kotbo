import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder } from 'discord.js';

const guildId = '987654321098765432';
const userId = '123456789012345678';
const PARENT_CHANNEL_ID = '111111111111111111';
const LOG_CHANNEL_ID = '222222222222222222';
const TICKET_CATEGORY_ID = '333333333333333333';

const prismaMock = {
  guild: { findUnique: mock(async () => ({}) as Record<string, unknown>) },
  securityVerification: { update: mock(async (_args?: unknown) => ({})) },
  ticket: { create: mock(async (_args?: unknown) => ({ id: 'ticket-1' })) },
  staffMember: { findMany: mock(async () => [] as Array<{ userId: string }>) },
};

const notifyManyMock = mock(async (_userIds: Iterable<string>, _input: { title: string; dm?: boolean }) => undefined);

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/logger', () => ({
    logger: {
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
      debug: mock(() => undefined),
    },
  })],
  ['../../services/notifications/notifyService', () => ({ notifyMany: notifyManyMock })],
];

for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { deliverVerification } = await import('../../services/moderation/verificationDeliveryService.js');

// --- Discord doubles ---------------------------------------------------------

function makeEmbedAndRow() {
  return {
    embed: new EmbedBuilder().setTitle('Vérification'),
    row: new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('Vérifier').setStyle(ButtonStyle.Link).setURL('https://example.com/verify'),
    ),
  };
}

interface Harness {
  user: any;
  member: any;
  client: any;
  threadSend: ReturnType<typeof mock>;
  threadMembersAdd: ReturnType<typeof mock>;
  logSend: ReturnType<typeof mock>;
  channelCreate: ReturnType<typeof mock>;
  createdChannelSend: ReturnType<typeof mock>;
  threadsCreate: ReturnType<typeof mock>;
}

/** @param dmWorks - false simule des MP fermés. @param hasParent - false: aucun salon parent configuré. */
function makeHarness(opts: { dmWorks: boolean; hasParent: boolean }): Harness {
  const threadSend = mock(async () => undefined);
  const threadMembersAdd = mock(async () => undefined);
  const logSend = mock(async () => undefined);
  const createdChannelSend = mock(async () => undefined);

  const threadsCreate = mock(async () => ({
    id: 'thread-1',
    members: { add: threadMembersAdd },
    send: threadSend,
  }));

  const channelCreate = mock(async () => ({
    id: 'ticket-channel-1',
    send: createdChannelSend,
  }));

  const parentChannel = { id: PARENT_CHANNEL_ID, type: ChannelType.GuildText, threads: { create: threadsCreate } };
  const logChannel = { id: LOG_CHANNEL_ID, type: ChannelType.GuildText, send: logSend };

  const channels = {
    fetch: mock(async (id: string) => {
      if (id === PARENT_CHANNEL_ID) return opts.hasParent ? parentChannel : null;
      if (id === LOG_CHANNEL_ID) return logChannel;
      return null;
    }),
    cache: new Map([[TICKET_CATEGORY_ID, { id: TICKET_CATEGORY_ID, type: ChannelType.GuildCategory }]]),
    create: channelCreate,
  };

  const guild = {
    id: guildId,
    name: 'Serveur Test',
    channels,
    roles: { everyone: { id: guildId }, cache: new Map() },
  };

  const user = {
    id: userId,
    tag: 'membre#0001',
    username: 'membre',
    send: opts.dmWorks ? mock(async () => undefined) : mock(async () => { throw new Error('Cannot send messages to this user'); }),
  };

  const client = { guilds: { fetch: mock(async () => guild) } };
  const member = { id: userId, user, guild, client };

  return { user, member, client, threadSend, threadMembersAdd, logSend, channelCreate, createdChannelSend, threadsCreate };
}

function setGuildConfig(config: Record<string, unknown>) {
  prismaMock.guild.findUnique = mock(async () => config);
}

beforeEach(() => {
  prismaMock.securityVerification.update = mock(async () => ({}));
  prismaMock.ticket.create = mock(async () => ({ id: 'ticket-1' }));
  prismaMock.staffMember.findMany = mock(async () => []);
  notifyManyMock.mockClear();
});

const baseConfig = {
  verificationFallbackChannelId: PARENT_CHANNEL_ID,
  verificationChannelId: null,
  ticketCategoryId: TICKET_CATEGORY_ID,
  ticketStaffRoleId: null,
  moderatorRoleId: null,
  verificationLogChannelId: LOG_CHANNEL_ID,
  logChannelId: null,
};

describe('deliverVerification - MP délivré', () => {
  test('envoie le MP et ne crée aucun repli', async () => {
    setGuildConfig(baseConfig);
    const h = makeHarness({ dmWorks: true, hasParent: true });
    const { embed, row } = makeEmbedAndRow();

    const result = await deliverVerification({
      client: h.client, guildId, user: h.user, member: h.member, embed, row,
      reason: 'Test', verificationId: 'verif-1',
    });

    expect(result.dmSent).toBe(true);
    expect(result.fallbackKind).toBeNull();
    expect(result.fallbackChannelId).toBeNull();
    expect(h.user.send).toHaveBeenCalledTimes(1);
    // Aucun thread, ticket ou notification staff quand le MP passe.
    expect(h.threadsCreate).not.toHaveBeenCalled();
    expect(h.channelCreate).not.toHaveBeenCalled();
    expect(h.logSend).not.toHaveBeenCalled();
  });
});

describe('deliverVerification - MP fermés, repli en thread', () => {
  test('crée un thread privé, y ajoute le membre et notifie le staff', async () => {
    setGuildConfig(baseConfig);
    const h = makeHarness({ dmWorks: false, hasParent: true });
    const { embed, row } = makeEmbedAndRow();

    const result = await deliverVerification({
      client: h.client, guildId, user: h.user, member: h.member, embed, row,
      reason: 'Seuil de warns atteint', verificationId: 'verif-1',
    });

    expect(result.dmSent).toBe(false);
    expect(result.fallbackKind).toBe('THREAD');
    expect(result.fallbackChannelId).toBe('thread-1');

    // Thread privé, membre ajouté, lien posté.
    const threadArgs = h.threadsCreate.mock.calls[0][0] as { type: number; name: string };
    expect(threadArgs.type).toBe(ChannelType.PrivateThread);
    expect(threadArgs.name).toContain('membre');
    expect(h.threadMembersAdd).toHaveBeenCalledWith(userId);
    expect(h.threadSend).toHaveBeenCalledTimes(1);
    const sent = h.threadSend.mock.calls[0][0] as { embeds: unknown[]; components: unknown[] };
    expect(sent.embeds).toHaveLength(1);
    expect(sent.components).toHaveLength(1);

    // Le salon de repli est persisté pour le nettoyage ultérieur.
    const updateArgs = prismaMock.securityVerification.update.mock.calls[0][0] as any;
    expect(updateArgs.where.id).toBe('verif-1');
    expect(updateArgs.data).toMatchObject({ fallbackChannelId: 'thread-1', fallbackKind: 'THREAD' });

    // Staff notifié du MP échoué, avec le lien vers le thread.
    expect(h.logSend).toHaveBeenCalledTimes(1);
    const logEmbed = (h.logSend.mock.calls[0][0] as any).embeds[0].toJSON();
    expect(logEmbed.title).toContain('MP fermés');
    expect(JSON.stringify(logEmbed.fields)).toContain('thread-1');

    // Aucun ticket : le thread a suffi.
    expect(h.channelCreate).not.toHaveBeenCalled();
  });

  test('retombe sur verificationChannelId quand aucun salon de repli dédié', async () => {
    setGuildConfig({ ...baseConfig, verificationFallbackChannelId: null, verificationChannelId: PARENT_CHANNEL_ID });
    const h = makeHarness({ dmWorks: false, hasParent: true });
    const { embed, row } = makeEmbedAndRow();

    const result = await deliverVerification({
      client: h.client, guildId, user: h.user, member: h.member, embed, row, reason: 'Test',
    });

    expect(result.fallbackKind).toBe('THREAD');
    expect(h.threadsCreate).toHaveBeenCalledTimes(1);
  });
});

describe('deliverVerification - MP fermés, repli en ticket', () => {
  test('crée un ticket quand aucun salon parent n’est configuré', async () => {
    setGuildConfig({ ...baseConfig, verificationFallbackChannelId: null, verificationChannelId: null });
    const h = makeHarness({ dmWorks: false, hasParent: false });
    const { embed, row } = makeEmbedAndRow();

    const result = await deliverVerification({
      client: h.client, guildId, user: h.user, member: h.member, embed, row,
      reason: 'Vérif forcée', verificationId: 'verif-2',
    });

    expect(result.dmSent).toBe(false);
    expect(result.fallbackKind).toBe('TICKET');
    expect(result.fallbackChannelId).toBe('ticket-channel-1');
    expect(h.threadsCreate).not.toHaveBeenCalled();

    // Salon privé rattaché à la catégorie tickets.
    const createArgs = h.channelCreate.mock.calls[0][0] as any;
    expect(createArgs.name).toBe('verif-membre');
    expect(createArgs.type).toBe(ChannelType.GuildText);
    expect(createArgs.parent).toBe(TICKET_CATEGORY_ID);
    // @everyone ne voit pas le salon, le membre oui.
    expect(createArgs.permissionOverwrites[0].id).toBe(guildId);
    expect(createArgs.permissionOverwrites[1].id).toBe(userId);

    // Entrée Ticket créée et lien posté.
    const ticketArgs = prismaMock.ticket.create.mock.calls[0][0] as any;
    expect(ticketArgs.data).toMatchObject({ guildId, userId, channelId: 'ticket-channel-1', status: 'OPEN' });
    expect(h.createdChannelSend).toHaveBeenCalledTimes(1);
  });

  test('bascule sur un ticket si la création du thread échoue', async () => {
    setGuildConfig(baseConfig);
    const h = makeHarness({ dmWorks: false, hasParent: true });
    h.threadsCreate.mockImplementation(async () => { throw new Error('Missing Permissions'); });
    const { embed, row } = makeEmbedAndRow();

    const result = await deliverVerification({
      client: h.client, guildId, user: h.user, member: h.member, embed, row, reason: 'Test',
    });

    expect(result.fallbackKind).toBe('TICKET');
    expect(h.channelCreate).toHaveBeenCalledTimes(1);
  });
});

describe('deliverVerification - aucun repli possible', () => {
  test('membre absent du serveur : signale l’échec au staff', async () => {
    setGuildConfig(baseConfig);
    const h = makeHarness({ dmWorks: false, hasParent: true });
    const { embed, row } = makeEmbedAndRow();

    const result = await deliverVerification({
      client: h.client, guildId, user: h.user, member: null, embed, row, reason: 'Test',
    });

    expect(result.dmSent).toBe(false);
    expect(result.fallbackKind).toBeNull();
    expect(result.fallbackChannelId).toBeNull();
    expect(result.fallbackError).toContain("n'est pas sur le serveur");
    expect(h.threadsCreate).not.toHaveBeenCalled();
    expect(h.channelCreate).not.toHaveBeenCalled();

    // Le staff est prévenu qu'une action manuelle est nécessaire.
    const logEmbed = (h.logSend.mock.calls[0][0] as any).embeds[0].toJSON();
    expect(logEmbed.title).toContain('non délivré');
    expect(logEmbed.description).toContain('action manuelle');
  });

  test('échec du ticket : résultat vide plutôt qu’une exception', async () => {
    setGuildConfig({ ...baseConfig, verificationFallbackChannelId: null, verificationChannelId: null });
    const h = makeHarness({ dmWorks: false, hasParent: false });
    h.channelCreate.mockImplementation(async () => { throw new Error('Missing Permissions'); });
    const { embed, row } = makeEmbedAndRow();

    const result = await deliverVerification({
      client: h.client, guildId, user: h.user, member: h.member, embed, row, reason: 'Test',
    });

    expect(result.fallbackKind).toBeNull();
    expect(result.fallbackChannelId).toBeNull();
    expect(result.fallbackError).toBeTruthy();
    expect(h.logSend).toHaveBeenCalledTimes(1);
  });
});

describe('deliverVerification - notification des managers', () => {
  test('notifie les managers sur le dashboard quand le MP échoue', async () => {
    setGuildConfig(baseConfig);
    prismaMock.staffMember.findMany = mock(async () => [{ userId: 'manager-1' }, { userId: 'manager-2' }]);
    const h = makeHarness({ dmWorks: false, hasParent: true });
    const { embed, row } = makeEmbedAndRow();

    await deliverVerification({
      client: h.client, guildId, user: h.user, member: h.member, embed, row, reason: 'Test',
    });

    expect(notifyManyMock).toHaveBeenCalledTimes(1);
    const [notifiedUsers, input] = notifyManyMock.mock.calls[0];
    expect([...notifiedUsers]).toEqual(['manager-1', 'manager-2']);
    expect(input.title).toContain('MP de vérification non délivré');
    expect(input.dm).toBe(false);
  });
});

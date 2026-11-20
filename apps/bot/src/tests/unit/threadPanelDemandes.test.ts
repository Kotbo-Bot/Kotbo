import { describe, expect, mock, test } from 'bun:test';
import { Events, type Client } from 'discord.js';

mock.module('../../utils/db.js', () => {
  const db = {
    panelThread: { findUnique: async () => ({ threadId: 'fil', ownerId: '100000000000000001', bannedIds: [], closedAt: null }) },
    guild: { findUnique: async () => null },
  };
  return { default: db, prisma: db, prismaRead: db };
});

const { registerThreadPanelListener } = await import('../../events/threadPanel.js');

const ecouteurs = new Map<string, (interaction: unknown) => Promise<void>>();
registerThreadPanelListener({ on: (evenement: string, ecouteur: (interaction: unknown) => Promise<void>) => ecouteurs.set(evenement, ecouteur) } as unknown as Client);

describe('demande d\'accès à un fil privé', () => {
  test('une demande dont le message a disparu n\'empêche pas d\'en renvoyer une', async () => {
    const fil = {
      isThread: () => true,
      members: { fetch: async () => { throw new Error('Unknown Member'); } },
      messages: { fetch: async () => { throw new Error('Unknown Message'); } },
      send: mock(async () => ({ id: 'demande' })),
    };
    const cliquer = () => ecouteurs.get(Events.InteractionCreate)!({
      customId: 'tpanel:join:fil',
      guildId: 'g',
      isButton: () => true,
      inCachedGuild: () => true,
      user: { id: '200000000000000002', tag: 'bob' },
      member: { displayName: 'Bob' },
      client: { channels: { fetch: async () => fil } },
      deferReply: async () => {},
      editReply: async () => {},
    });

    await cliquer();
    await cliquer();

    expect(fil.send).toHaveBeenCalledTimes(2);
  });
});

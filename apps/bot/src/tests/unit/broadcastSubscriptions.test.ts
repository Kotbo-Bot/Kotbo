import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { ChannelType, Collection, type Client } from 'discord.js';

let storedSource: { guildId: string; channelId: string } | null = null;
const guildRows = new Map<string, { broadcastChannelId: string | null }>();

const mockDb = {
  botGlobalConfig: {
    findUnique: mock(async () => (storedSource ? { key: 'BROADCAST_SOURCE_CHANNEL', value: JSON.stringify(storedSource) } : null)),
    upsert: mock(async ({ update }: { update: { value: string } }) => {
      storedSource = JSON.parse(update.value) as { guildId: string; channelId: string };
      return {};
    }),
    deleteMany: mock(async () => {
      storedSource = null;
      return { count: 1 };
    }),
  },
  guild: {
    findUnique: mock(async ({ where }: { where: { id: string } }) => {
      const row = guildRows.get(where.id);
      return row
        ? {
            broadcastChannelId: row.broadcastChannelId,
            newsChannelId: null,
            publicChannelId: null,
            staffAnnouncementChannelId: null,
          }
        : null;
    }),
    upsert: mock(async ({ where, update }: { where: { id: string }; update: { broadcastChannelId: string | null } }) => {
      guildRows.set(where.id, { broadcastChannelId: update.broadcastChannelId });
      return {};
    }),
  },
};

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const {
  deliverBroadcastViaSource,
  resetBroadcastSubscriptionCache,
  subscribeAllGuildsToBroadcastSource,
  syncPendingBroadcastSubscriptions,
} = await import('../../services/system/broadcastService.js');

interface FakeGuildOptions {
  id: string;
  name: string;
  channelId: string;
  channelType?: ChannelType.GuildText | ChannelType.GuildAnnouncement;
  canManageWebhooks?: boolean;
  alreadyFollowing?: boolean;
  failSend?: boolean;
}

function makeFakeClient(guilds: FakeGuildOptions[], onPostFollow?: (channelId: string) => void, onSendSource?: () => void): Client {
  const guildMap = new Collection<string, unknown>();

  for (const g of guilds) {
    const channels = new Collection<string, unknown>();
    channels.set(g.channelId, {
      id: g.channelId,
      name: `news-${g.id}`,
      type: g.channelType ?? ChannelType.GuildText,
      rawPosition: 0,
      permissionsFor: () => ({
        has: (perms: unknown) => {
          if (g.canManageWebhooks === false) {
            if (Array.isArray(perms) && perms.some((p) => String(p).includes('ManageWebhooks') || p === 536870912n)) {
              return false;
            }
          }
          return true;
        },
      }),
      fetchWebhooks: async () =>
        g.alreadyFollowing && storedSource
          ? [{ type: 2, sourceChannel: { id: storedSource.channelId } }]
          : [],
      send: async () => {
        if (g.failSend) throw new Error('Discord send error');
        onSendSource?.();
        return {
          id: `msg-${g.id}`,
          crosspost: async () => undefined,
        };
      },
    });

    guildMap.set(g.id, {
      id: g.id,
      name: g.name,
      systemChannelId: g.channelId,
      roles: { everyone: 'everyone-role' },
      channels: { cache: channels },
    });
  }

  return {
    user: { id: 'bot-user' },
    isReady: () => true,
    guilds: { cache: guildMap },
    rest: {
      post: async (_route: string, opts?: { body?: { webhook_channel_id?: string } }) => {
        onPostFollow?.(opts?.body?.webhook_channel_id ?? '');
        return {};
      },
    },
  } as unknown as Client;
}

beforeEach(() => {
  storedSource = { guildId: 'source-1', channelId: 'ch-source' };
  guildRows.clear();
  resetBroadcastSubscriptionCache();
});

describe('broadcast source subscriptions & delivery', () => {
  test('subscribeAllGuildsToBroadcastSource ignore le serveur source et découpe avec maxImmediate', async () => {
    const followedChannels: string[] = [];
    const client = makeFakeClient(
      [
        { id: 'source-1', name: 'Source', channelId: 'ch-source', channelType: ChannelType.GuildAnnouncement },
        { id: 'g-1', name: 'Serveur 1', channelId: 'ch-1' },
        { id: 'g-2', name: 'Serveur 2', channelId: 'ch-2' },
        { id: 'g-3', name: 'Serveur 3', channelId: 'ch-3' },
      ],
      (chId) => followedChannels.push(chId),
    );

    const summary = await subscribeAllGuildsToBroadcastSource(client, 'ch-source', {
      sourceGuildId: 'source-1',
      maxImmediate: 2,
    });

    expect(summary.total).toBe(2);
    expect(summary.subscribed).toBe(2);
    expect(summary.pending).toBe(1);
    expect(followedChannels).toEqual(['ch-1', 'ch-2']);
  });

  test('syncPendingBroadcastSubscriptions abonne les serveurs par lots sans revérifier ceux déjà confirmés', async () => {
    const followedChannels: string[] = [];
    const client = makeFakeClient(
      [
        { id: 'source-1', name: 'Source', channelId: 'ch-source', channelType: ChannelType.GuildAnnouncement },
        { id: 'g-1', name: 'Serveur 1', channelId: 'ch-1' },
        { id: 'g-2', name: 'Serveur 2', channelId: 'ch-2' },
        { id: 'g-3', name: 'Serveur 3', channelId: 'ch-3' },
      ],
      (chId) => followedChannels.push(chId),
    );

    const first = await syncPendingBroadcastSubscriptions(client, 2);
    expect(first).toEqual({ checked: 2, subscribed: 2 });

    const second = await syncPendingBroadcastSubscriptions(client, 2);
    expect(second).toEqual({ checked: 1, subscribed: 1 });

    const third = await syncPendingBroadcastSubscriptions(client, 2);
    expect(third).toEqual({ checked: 0, subscribed: 0 });
    expect(followedChannels).toEqual(['ch-1', 'ch-2', 'ch-3']);
  });

  test('deliverBroadcastViaSource abonne les serveurs manquants avant crosspost et remonte toutes les livraisons', async () => {
    const timeline: string[] = [];
    const client = makeFakeClient(
      [
        { id: 'source-1', name: 'Source', channelId: 'ch-source', channelType: ChannelType.GuildAnnouncement },
        { id: 'g-1', name: 'Serveur 1', channelId: 'ch-1' },
        { id: 'g-2', name: 'Serveur 2', channelId: 'ch-2', alreadyFollowing: true },
        { id: 'g-3', name: 'Serveur 3', channelId: 'ch-3', canManageWebhooks: false },
      ],
      (chId) => timeline.push(`follow:${chId}`),
      () => timeline.push('send-source'),
    );

    const deliveries = await deliverBroadcastViaSource(client, storedSource!, {
      title: 'Annonce',
      message: 'Contenu',
      color: '#5865F2',
      thumbnailUrl: null,
      imageUrl: null,
      footerText: 'Footer',
    });

    expect(timeline).toEqual(['follow:ch-1', 'send-source']);
    expect(deliveries.map((d) => ({ guildId: d.guildId, status: d.status }))).toEqual([
      { guildId: 'source-1', status: 'SENT' },
      { guildId: 'g-1', status: 'SENT' },
      { guildId: 'g-2', status: 'SENT' },
      { guildId: 'g-3', status: 'SKIPPED' },
    ]);
  });

  test('deliverBroadcastViaSource propage léchec source à tous les serveurs abonnés', async () => {
    const client = makeFakeClient([
      { id: 'source-1', name: 'Source', channelId: 'ch-source', channelType: ChannelType.GuildAnnouncement, failSend: true },
      { id: 'g-1', name: 'Serveur 1', channelId: 'ch-1' },
    ]);

    const deliveries = await deliverBroadcastViaSource(client, storedSource!, {
      title: 'Annonce',
      message: 'Contenu',
      color: '#5865F2',
      thumbnailUrl: null,
      imageUrl: null,
      footerText: 'Footer',
    });

    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === 'FAILED')).toBe(true);
    expect(deliveries[1].reason).toContain('Discord send error');
  });
});

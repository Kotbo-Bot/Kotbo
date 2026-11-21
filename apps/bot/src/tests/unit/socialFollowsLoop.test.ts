import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';

// ==================== MOCK BASE DE DONNEES ====================

interface FollowUpdate {
  id: string;
  data: Record<string, unknown>;
}

let youtubeFollows: unknown[] = [];
let twitchFollows: unknown[] = [];
const updates: FollowUpdate[] = [];

const followStore = (rows: () => unknown[]) => ({
  findMany: mock(async (): Promise<unknown[]> => rows()),
  update: mock(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    updates.push({ id: where.id, data });
    return {};
  }),
});

const mockDb = {
  youtubeChannelFollow: followStore(() => youtubeFollows),
  twitchChannelFollow: followStore(() => twitchFollows),
};

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const { checkYoutubeFollows, resetYoutubeCacheForTests } = await import('../../services/integrations/youtubeService.js');
const { checkTwitchFollows, resetTwitchAuthForTests } = await import('../../services/integrations/twitchService.js');

// ==================== MOCK DISCORD ====================

interface SentMessage {
  channelId: string;
  content: string;
  embedTitle?: string;
}

const sent: SentMessage[] = [];

/** Client Discord minimal : seules les branches empruntees par le polling existent. */
function fakeClient(guildId: string, channelIds: string[]): Client {
  const channels = new Map(
    channelIds.map((id) => [id, {
      isTextBased: () => true,
      send: async (payload: { content: string; embeds: Array<{ data: { title?: string } }> }) => {
        sent.push({ channelId: id, content: payload.content, embedTitle: payload.embeds[0]?.data?.title });
      },
    }]),
  );

  const guild = {
    channels: { cache: channels, fetch: async () => null },
  };

  return {
    guilds: {
      cache: new Map([[guildId, guild]]),
      fetch: async () => null,
    },
  } as unknown as Client;
}

// ==================== FIXTURES ====================

const GUILD_ID = 'guild-1';
const PUBLIC_CHANNEL = 'public-channel';

function youtubeFollow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'yt-1',
    guildId: GUILD_ID,
    channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    channelName: 'Kotbo',
    discordChannelId: null,
    mention: null,
    liveMessage: null,
    videoMessage: null,
    shortMessage: null,
    lastLiveId: null,
    lastVideoId: 'deja-vu-001',
    lastShortId: 'deja-vu-002',
    guild: { publicChannelId: PUBLIC_CHANNEL, dashboardFeatureConfigs: [] as unknown[] },
    ...overrides,
  };
}

function twitchFollow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tw-1',
    guildId: GUILD_ID,
    streamerName: 'kotbo',
    streamerId: null,
    discordChannelId: null,
    mention: null,
    liveMessage: null,
    isLive: false,
    lastStreamId: null,
    guild: { publicChannelId: PUBLIC_CHANNEL, dashboardFeatureConfigs: [] as unknown[] },
    ...overrides,
  };
}

function rssFeed(videoId: string, title: string, publishedAt = new Date().toISOString()): string {
  return `<feed><entry><yt:videoId>${videoId}</yt:videoId><title>${title}</title><published>${publishedAt}</published></entry></feed>`;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    text: async () => body,
    json: async () => JSON.parse(body),
  } as Response;
}

beforeEach(() => {
  sent.length = 0;
  updates.length = 0;
  youtubeFollows = [];
  twitchFollows = [];
  resetYoutubeCacheForTests();
  resetTwitchAuthForTests();
  process.env.TWITCH_CLIENT_ID = 'client-id';
  process.env.TWITCH_CLIENT_SECRET = 'client-secret';
});

// ==================== TESTS YOUTUBE ====================

describe('checkYoutubeFollows', () => {
  /** Repond au flux RSS, a la page /live et au test de Short. */
  const youtubeRoutes = (feedBody: string, liveBody = '') => async (url: string) => {
    if (url.includes('feeds/videos.xml')) return textResponse(feedBody);
    if (url.includes('/live')) return textResponse(liveBody);
    if (url.includes('/shorts/')) return textResponse('', 303);
    return textResponse('', 404);
  };

  test('annonce une nouvelle video dans le salon public et memorise son id', async () => {
    youtubeFollows = [youtubeFollow()];

    await checkYoutubeFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), youtubeRoutes(rssFeed('nouvelle001', 'Refonte du bot')));

    expect(sent).toHaveLength(1);
    expect(sent[0].channelId).toBe(PUBLIC_CHANNEL);
    expect(sent[0].content).toBe('🎥 Nouvelle vidéo de **Kotbo** !');
    expect(sent[0].embedTitle).toBe('Refonte du bot');
    expect(updates).toEqual([{ id: 'yt-1', data: { lastVideoId: 'nouvelle001' } }]);
  });

  test('applique le message personnalise et la mention', async () => {
    youtubeFollows = [youtubeFollow({
      videoMessage: 'Hey [channel], nouvelle vidéo : [title]',
      mention: '<@&role-1>',
      discordChannelId: 'salon-dedie',
    })];

    await checkYoutubeFollows(
      fakeClient(GUILD_ID, [PUBLIC_CHANNEL, 'salon-dedie']),
      youtubeRoutes(rssFeed('nouvelle002', 'Episode 2')),
    );

    expect(sent[0].channelId).toBe('salon-dedie');
    expect(sent[0].content).toBe('<@&role-1> Hey Kotbo, nouvelle vidéo : Episode 2');
  });

  test('n envoie rien si la video est deja connue', async () => {
    youtubeFollows = [youtubeFollow({ lastVideoId: 'connue001' })];

    await checkYoutubeFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), youtubeRoutes(rssFeed('connue001', 'Deja publiee')));

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('memorise sans annoncer au premier passage sur la chaine', async () => {
    youtubeFollows = [youtubeFollow({ lastVideoId: null })];

    await checkYoutubeFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), youtubeRoutes(rssFeed('premiere001', 'Ancienne video')));

    expect(sent).toHaveLength(0);
    expect(updates).toEqual([{ id: 'yt-1', data: { lastVideoId: 'premiere001' } }]);
  });

  test('annonce un direct detecte sur la page /live', async () => {
    youtubeFollows = [youtubeFollow()];
    const liveHtml = '<link rel="canonical" href="https://www.youtube.com/watch?v=direct00001">"isLiveNow":true<meta property="og:title" content="Stream du soir">';

    await checkYoutubeFollows(
      fakeClient(GUILD_ID, [PUBLIC_CHANNEL]),
      youtubeRoutes(rssFeed('direct00001', 'Stream du soir'), liveHtml),
    );

    // Le direct figure aussi dans le flux RSS : une seule annonce doit sortir.
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe('🔴 **Kotbo** est en direct sur YouTube !');
    expect(updates).toEqual([{ id: 'yt-1', data: { lastLiveId: 'direct00001' } }]);
  });

  test('respecte la desactivation du module par la guilde', async () => {
    youtubeFollows = [youtubeFollow({
      guild: {
        publicChannelId: PUBLIC_CHANNEL,
        dashboardFeatureConfigs: [{ featureKey: 'youtube', enabled: false }],
      },
    })];

    await checkYoutubeFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), youtubeRoutes(rssFeed('nouvelle003', 'Titre')));

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('traite plus d abonnements que de requetes HTTP simultanees autorisees', async () => {
    // Regression : imbriquer le limiteur HTTP dans un limiteur par abonnement
    // faisait attendre chaque requete un creneau detenu par son propre parent.
    youtubeFollows = Array.from({ length: 12 }, (_, i) =>
      youtubeFollow({ id: `yt-${i}`, channelId: `UC${String(i).padStart(22, 'x')}` }));

    await checkYoutubeFollows(
      fakeClient(GUILD_ID, [PUBLIC_CHANNEL]),
      youtubeRoutes(rssFeed('massive0001', 'Video')),
    );

    expect(updates).toHaveLength(12);
  }, 5000);

  test('poursuit les autres abonnements si un salon est introuvable', async () => {
    youtubeFollows = [
      youtubeFollow({ id: 'yt-a', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', discordChannelId: 'salon-supprime' }),
      youtubeFollow({ id: 'yt-b', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb' }),
    ];

    await checkYoutubeFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), youtubeRoutes(rssFeed('nouvelle004', 'Titre')));

    expect(sent).toHaveLength(1);
    expect(updates).toHaveLength(2);
  });

  test('ne fait rien sans abonnement enregistre', async () => {
    await checkYoutubeFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), youtubeRoutes(rssFeed('x0000000001', 'Titre')));
    expect(updates).toHaveLength(0);
  });
});

// ==================== TESTS TWITCH ====================

describe('checkTwitchFollows', () => {
  const stream = (overrides: Record<string, unknown> = {}) => ({
    id: 'stream-1',
    user_id: '42',
    user_login: 'kotbo',
    user_name: 'Kotbo',
    title: 'Refonte du bot',
    game_name: 'Dev',
    viewer_count: 12,
    ...overrides,
  });

  const twitchRoutes = (streams: unknown[]) => async (url: string) => {
    if (url.includes('oauth2/token')) {
      return textResponse(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
    }
    return textResponse(JSON.stringify({ data: streams }));
  };

  test('annonce un passage en live et memorise le stream', async () => {
    twitchFollows = [twitchFollow()];

    await checkTwitchFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), twitchRoutes([stream()]));

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe('🎥 **Kotbo** est en live sur Twitch !');
    expect(updates).toEqual([{ id: 'tw-1', data: { isLive: true, lastStreamId: 'stream-1', streamerId: '42' } }]);
  });

  test('n annonce pas deux fois le meme stream', async () => {
    twitchFollows = [twitchFollow({ isLive: true, lastStreamId: 'stream-1' })];

    await checkTwitchFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), twitchRoutes([stream()]));

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('remet l etat a plat en fin de live, sans notification', async () => {
    twitchFollows = [twitchFollow({ isLive: true, lastStreamId: 'stream-1' })];

    await checkTwitchFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), twitchRoutes([]));

    expect(sent).toHaveLength(0);
    expect(updates).toEqual([{ id: 'tw-1', data: { isLive: false } }]);
  });

  test('applique le message personnalise et la mention', async () => {
    twitchFollows = [twitchFollow({
      liveMessage: '[channel] est en live sur [game] : [title]',
      mention: '@everyone',
    })];

    await checkTwitchFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), twitchRoutes([stream()]));

    expect(sent[0].content).toBe('@everyone Kotbo est en live sur Dev : Refonte du bot');
  });

  test('respecte la desactivation du module par la guilde', async () => {
    twitchFollows = [twitchFollow({
      guild: {
        publicChannelId: PUBLIC_CHANNEL,
        dashboardFeatureConfigs: [{ featureKey: 'twitch', enabled: false }],
      },
    })];

    await checkTwitchFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), twitchRoutes([stream()]));

    expect(sent).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('ne contacte pas Twitch sans identifiants configures', async () => {
    delete process.env.TWITCH_CLIENT_ID;
    twitchFollows = [twitchFollow()];
    let called = false;

    await checkTwitchFollows(fakeClient(GUILD_ID, [PUBLIC_CHANNEL]), async () => {
      called = true;
      return textResponse('{}');
    });

    expect(called).toBe(false);
    expect(updates).toHaveLength(0);
  });
});

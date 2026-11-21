import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildYoutubeNotification,
  checkYoutubeLiveStatus,
  decodeXmlEntities,
  detectLiveFromHtml,
  extractChannelAvatarFromHtml,
  extractChannelIdFromHtml,
  extractChannelNameFromHtml,
  extractFromQuery,
  fetchChannelAvatar,
  fetchLatestVideo,
  fetchRecentVideos,
  isYoutubeShort,
  parseYoutubeFeed,
  planYoutubeActions,
  resetYoutubeCacheForTests,
  resolveVideoThumbnail,
  resolveYoutubeChannel,
  sanitizeFeedText,
  type FetchLike,
  type YoutubeAction,
  type YoutubeFollowState,
  type YoutubeVideo,
} from '../../services/integrations/youtubeService';

const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';

function feedEntry(videoId: string, title: string, published: string): string {
  return `<entry><id>yt:video:${videoId}</id><yt:videoId>${videoId}</yt:videoId><yt:channelId>${CHANNEL_ID}</yt:channelId><title>${title}</title><published>${published}</published></entry>`;
}

function feed(...entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed><title>Ma chaine</title>${entries.join('')}</feed>`;
}

/** Reponse minimale suffisante pour les chemins de code testes. */
function textResponse(body: string, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as Response;
}

/** `fetch` de test routant par sous-chaine d'URL, et enregistrant les appels. */
function routedFetch(routes: Array<[string, Response | (() => Response)]>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    for (const [needle, response] of routes) {
      if (url.includes(needle)) {
        return typeof response === 'function' ? response() : response;
      }
    }
    return textResponse('', { ok: false, status: 404 });
  }) as FetchLike & { calls: string[] };
  impl.calls = calls;
  return impl;
}

const EMPTY_STATE: YoutubeFollowState = { lastLiveId: null, lastVideoId: null, lastShortId: null };

function video(overrides: Partial<YoutubeVideo> = {}): YoutubeVideo {
  return {
    videoId: 'vid00000001',
    title: 'Une video',
    publishedAt: new Date('2026-07-26T10:00:00Z'),
    description: null,
    thumbnailUrl: null,
    isShort: false,
    ...overrides,
  };
}

afterEach(() => {
  resetYoutubeCacheForTests();
  delete process.env.YOUTUBE_API_KEY;
});

describe('youtubeService - parsing du flux', () => {
  test('extrait les videos du flux Atom', () => {
    const videos = parseYoutubeFeed(
      feed(
        feedEntry('aaaaaaaaaaa', 'Ancienne', '2026-07-20T10:00:00+00:00'),
        feedEntry('bbbbbbbbbbb', 'Recente', '2026-07-25T10:00:00+00:00'),
      ),
    );

    expect(videos).toHaveLength(2);
    expect(videos[0].title).toBe('Recente');
  });

  test('trie du plus recent au plus ancien', () => {
    const videos = parseYoutubeFeed(
      feed(
        feedEntry('aaaaaaaaaaa', 'A', '2026-01-01T00:00:00+00:00'),
        feedEntry('ccccccccccc', 'C', '2026-03-01T00:00:00+00:00'),
        feedEntry('bbbbbbbbbbb', 'B', '2026-02-01T00:00:00+00:00'),
      ),
    );

    expect(videos.map((v) => v.videoId)).toEqual(['ccccccccccc', 'bbbbbbbbbbb', 'aaaaaaaaaaa']);
  });

  test('decode les entites XML des titres', () => {
    const videos = parseYoutubeFeed(feed(feedEntry('aaaaaaaaaaa', 'Tom &amp; Jerry &quot;live&quot;', '2026-07-25T10:00:00+00:00')));
    expect(videos[0].title).toBe('Tom & Jerry "live"');
  });

  test('ignore les entrees incompletes ou aux dates invalides', () => {
    const broken = '<entry><yt:videoId>zzz</yt:videoId></entry>';
    const badDate = feedEntry('ddddddddddd', 'D', 'pas-une-date');
    expect(parseYoutubeFeed(feed(broken, badDate))).toHaveLength(0);
  });

  test('renvoie une liste vide sur un flux vide', () => {
    expect(parseYoutubeFeed('')).toEqual([]);
  });

  test('decodeXmlEntities gere les references numeriques', () => {
    expect(decodeXmlEntities('caf&#233;')).toBe('café');
  });

  test('reprend la description et la miniature exposees par le flux', () => {
    const entry = `<entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>A</title><published>2026-07-25T10:00:00+00:00</published>`
      + `<media:group><media:thumbnail url="https://i2.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg" width="480" height="360"/>`
      + `<media:description>Ligne 1&#10;Ligne 2</media:description></media:group></entry>`;

    const [parsed] = parseYoutubeFeed(feed(entry));

    expect(parsed.description).toBe('Ligne 1\nLigne 2');
    expect(parsed.thumbnailUrl).toBe('https://i2.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg');
  });

  test('laisse description et miniature a null quand le flux ne les porte pas', () => {
    const [parsed] = parseYoutubeFeed(feed(feedEntry('aaaaaaaaaaa', 'A', '2026-07-25T10:00:00+00:00')));

    expect(parsed.description).toBeNull();
    expect(parsed.thumbnailUrl).toBeNull();
  });

  test('sanitizeFeedText retire les caracteres invisibles dune description tierce', () => {
    expect(sanitizeFeedText('Bonjour\u200Bmonde\u202E \u0000')).toBe('Bonjourmonde');
    expect(sanitizeFeedText('a\r\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('youtubeService - detection du direct', () => {
  const canonical = (id: string) => `<link rel="canonical" href="https://www.youtube.com/watch?v=${id}">`;

  test('detecte un direct en cours', () => {
    const html = `${canonical('live0000001')}<meta property="og:title" content="Stream du soir - YouTube">`
      + `<meta property="og:description" content="On papote jusqu a minuit">"isLiveNow":true`;
    expect(detectLiveFromHtml(html)).toEqual({
      isLive: true,
      videoId: 'live0000001',
      title: 'Stream du soir',
      description: 'On papote jusqu a minuit',
    });
  });

  test('ne signale pas de direct sur une rediffusion', () => {
    // La page /live retombe sur le dernier direct termine : isLiveNow y vaut false.
    const html = `${canonical('past0000001')}"isLiveNow":false`;
    expect(detectLiveFromHtml(html).isLive).toBe(false);
  });

  test('ne signale pas de direct sans identifiant de video', () => {
    expect(detectLiveFromHtml('"isLiveNow":true').isLive).toBe(false);
  });

  test('retombe sur un titre par defaut si aucun titre exploitable', () => {
    const html = `"isLiveNow":true"videoId":"live0000002"`;
    expect(detectLiveFromHtml(html).title).toBe('En direct sur YouTube');
  });

  test('checkYoutubeLiveStatus met le resultat en cache', async () => {
    const html = `<link rel="canonical" href="https://www.youtube.com/watch?v=live0000003">"isLiveNow":true`;
    const impl = routedFetch([['/live', textResponse(html)]]);

    const first = await checkYoutubeLiveStatus(CHANNEL_ID, impl);
    const second = await checkYoutubeLiveStatus(CHANNEL_ID, impl);

    expect(first.videoId).toBe('live0000003');
    expect(second).toEqual(first);
    expect(impl.calls).toHaveLength(1);
  });

  test('checkYoutubeLiveStatus renvoie hors-ligne si la page est indisponible', async () => {
    const impl = routedFetch([]);
    expect(await checkYoutubeLiveStatus(CHANNEL_ID, impl)).toEqual({ isLive: false });
  });
});

describe('youtubeService - resolution de chaine', () => {
  test('extractFromQuery reconnait un identifiant brut', () => {
    expect(extractFromQuery(CHANNEL_ID)).toEqual({ handle: null, channelId: CHANNEL_ID });
  });

  test('extractFromQuery reconnait une URL /channel/', () => {
    expect(extractFromQuery(`https://www.youtube.com/channel/${CHANNEL_ID}/videos`))
      .toEqual({ handle: null, channelId: CHANNEL_ID });
  });

  test('extractFromQuery reconnait une URL de handle', () => {
    expect(extractFromQuery('https://www.youtube.com/@kotbo/videos')).toEqual({ handle: 'kotbo', channelId: null });
  });

  test('extractFromQuery reconnait les anciennes URLs /c/ et /user/', () => {
    expect(extractFromQuery('https://www.youtube.com/c/kotbo').handle).toBe('kotbo');
    expect(extractFromQuery('https://www.youtube.com/user/kotbo').handle).toBe('kotbo');
  });

  test('extractFromQuery reconnait un handle nu', () => {
    expect(extractFromQuery('@kotbo')).toEqual({ handle: 'kotbo', channelId: null });
  });

  test('extractChannelIdFromHtml lit les differentes formes exposees par YouTube', () => {
    expect(extractChannelIdFromHtml(`<meta itemprop="identifier" content="${CHANNEL_ID}">`)).toBe(CHANNEL_ID);
    expect(extractChannelIdFromHtml(`{"externalId":"${CHANNEL_ID}"}`)).toBe(CHANNEL_ID);
    expect(extractChannelIdFromHtml(`<a href="/channel/${CHANNEL_ID}">`)).toBe(CHANNEL_ID);
    expect(extractChannelIdFromHtml('<html></html>')).toBeNull();
  });

  test('extractChannelNameFromHtml retire le suffixe YouTube', () => {
    expect(extractChannelNameFromHtml('<title>Kotbo - YouTube</title>')).toBe('Kotbo');
  });

  test('resout un handle sans cle API via la page publique', async () => {
    const html = `<meta property="og:title" content="Kotbo - YouTube"><meta itemprop="identifier" content="${CHANNEL_ID}">`;
    const impl = routedFetch([['youtube.com/@kotbo', textResponse(html)]]);

    expect(await resolveYoutubeChannel('@kotbo', impl)).toEqual({
      channelId: CHANNEL_ID,
      channelName: 'Kotbo',
    });
    // Aucune requete vers l'API Google sans cle configuree.
    expect(impl.calls.some((u) => u.includes('googleapis'))).toBe(false);
  });

  test('utilise l API quand la cle est presente', async () => {
    process.env.YOUTUBE_API_KEY = 'test-key';
    const body = JSON.stringify({ items: [{ id: CHANNEL_ID, snippet: { title: 'Kotbo' } }] });
    const impl = routedFetch([['googleapis.com', textResponse(body)]]);

    expect(await resolveYoutubeChannel(CHANNEL_ID, impl)).toEqual({
      channelId: CHANNEL_ID,
      channelName: 'Kotbo',
    });
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls[0]).toContain(`id=${CHANNEL_ID}`);
  });

  test('interroge l API par handle quand la saisie est un @pseudo', async () => {
    process.env.YOUTUBE_API_KEY = 'test-key';
    const body = JSON.stringify({ items: [{ id: CHANNEL_ID, snippet: { title: 'Kotbo' } }] });
    const impl = routedFetch([['googleapis.com', textResponse(body)]]);

    await resolveYoutubeChannel('@kotbo', impl);

    expect(impl.calls[0]).toContain('forHandle=%40kotbo');
  });

  test('retombe sur la page publique si l API ne trouve rien', async () => {
    process.env.YOUTUBE_API_KEY = 'test-key';
    const html = `<meta property="og:title" content="Kotbo"><meta itemprop="identifier" content="${CHANNEL_ID}">`;
    const impl = routedFetch([
      ['googleapis.com', textResponse(JSON.stringify({ items: [] }))],
      ['youtube.com/@kotbo', textResponse(html)],
    ]);

    expect(await resolveYoutubeChannel('@kotbo', impl)).toEqual({
      channelId: CHANNEL_ID,
      channelName: 'Kotbo',
    });
  });

  test('met la resolution en cache', async () => {
    const html = `<meta property="og:title" content="Kotbo"><meta itemprop="identifier" content="${CHANNEL_ID}">`;
    const impl = routedFetch([['youtube.com/@kotbo', textResponse(html)]]);

    await resolveYoutubeChannel('@kotbo', impl);
    await resolveYoutubeChannel('@kotbo', impl);

    expect(impl.calls).toHaveLength(1);
  });

  test('renvoie null pour une saisie vide ou introuvable', async () => {
    const impl = routedFetch([]);
    expect(await resolveYoutubeChannel('   ', impl)).toBeNull();
    expect(await resolveYoutubeChannel('@inconnu', impl)).toBeNull();
  });
});

describe('youtubeService - recuperation des videos', () => {
  test('fetchRecentVideos lit le flux RSS sans consommer de quota API', async () => {
    const impl = routedFetch([['feeds/videos.xml', textResponse(feed(feedEntry('aaaaaaaaaaa', 'A', '2026-07-25T10:00:00+00:00')))]]);

    const videos = await fetchRecentVideos(CHANNEL_ID, impl);

    expect(videos).toHaveLength(1);
    expect(impl.calls.some((u) => u.includes('googleapis'))).toBe(false);
  });

  test('fetchRecentVideos renvoie une liste vide si le flux est inaccessible', async () => {
    expect(await fetchRecentVideos(CHANNEL_ID, routedFetch([]))).toEqual([]);
  });

  test('isYoutubeShort distingue un Short d une video classique', async () => {
    const short = routedFetch([['/shorts/', textResponse('', { status: 200 })]]);
    const notShort = routedFetch([['/shorts/', textResponse('', { ok: false, status: 303 })]]);

    expect(await isYoutubeShort('short000001', short)).toBe(true);
    expect(await isYoutubeShort('video000001', notShort)).toBe(false);
  });

  test('isYoutubeShort met en cache y compris le resultat negatif', async () => {
    const impl = routedFetch([['/shorts/', textResponse('', { ok: false, status: 303 })]]);

    await isYoutubeShort('video000002', impl);
    await isYoutubeShort('video000002', impl);

    expect(impl.calls).toHaveLength(1);
  });

  test('fetchLatestVideo renvoie la video la plus recente, pas la plus ancienne', async () => {
    const impl = routedFetch([
      ['feeds/videos.xml', textResponse(feed(
        feedEntry('oldold00001', 'Ancienne', '2020-01-01T00:00:00+00:00'),
        feedEntry('newnew00001', 'Recente', '2026-07-25T10:00:00+00:00'),
      ))],
      ['/shorts/', textResponse('', { ok: false, status: 303 })],
    ]);

    const latest = await fetchLatestVideo(CHANNEL_ID, impl);

    expect(latest?.videoId).toBe('newnew00001');
    expect(latest?.isShort).toBe(false);
  });

  test('fetchLatestVideo renvoie null si la chaine n a aucune video', async () => {
    const impl = routedFetch([['feeds/videos.xml', textResponse(feed())]]);
    expect(await fetchLatestVideo(CHANNEL_ID, impl)).toBeNull();
  });
});

describe('youtubeService - visuels de la notification', () => {
  test('extractChannelAvatarFromHtml lit og:image puis le player payload', () => {
    expect(extractChannelAvatarFromHtml('<meta property="og:image" content="https://yt3.googleusercontent.com/a.jpg">'))
      .toBe('https://yt3.googleusercontent.com/a.jpg');
    expect(extractChannelAvatarFromHtml('"avatar":{"thumbnails":[{"url":"https:\\/\\/yt3.googleusercontent.com\\/b.jpg"'))
      .toBe('https://yt3.googleusercontent.com/b.jpg');
    expect(extractChannelAvatarFromHtml('<html></html>')).toBeNull();
  });

  test('extractChannelAvatarFromHtml refuse une URL non https', () => {
    expect(extractChannelAvatarFromHtml('<meta property="og:image" content="//yt3.googleusercontent.com/a.jpg">')).toBeNull();
  });

  test('fetchChannelAvatar retombe sur la page publique et met en cache', async () => {
    const impl = routedFetch([
      [`channel/${CHANNEL_ID}`, textResponse('<meta property="og:image" content="https://yt3.googleusercontent.com/a.jpg">')],
    ]);

    expect(await fetchChannelAvatar(CHANNEL_ID, impl)).toBe('https://yt3.googleusercontent.com/a.jpg');
    await fetchChannelAvatar(CHANNEL_ID, impl);

    expect(impl.calls).toHaveLength(1);
    expect(impl.calls.some((u) => u.includes('googleapis'))).toBe(false);
  });

  test('fetchChannelAvatar renvoie null si aucun avatar n est trouvable', async () => {
    expect(await fetchChannelAvatar(CHANNEL_ID, routedFetch([]))).toBeNull();
  });

  test('resolveVideoThumbnail prefere maxresdefault quand elle existe', async () => {
    const impl = routedFetch([['maxresdefault', textResponse('', { status: 200 })]]);

    expect(await resolveVideoThumbnail('vid00000001', null, impl))
      .toBe('https://i.ytimg.com/vi/vid00000001/maxresdefault.jpg');
  });

  test('resolveVideoThumbnail retombe sur la miniature du flux', async () => {
    const impl = routedFetch([['maxresdefault', textResponse('', { ok: false, status: 404 })]]);
    const fromFeed = 'https://i2.ytimg.com/vi/vid00000002/hqdefault.jpg';

    expect(await resolveVideoThumbnail('vid00000002', fromFeed, impl)).toBe(fromFeed);
  });

  test('resolveVideoThumbnail retombe sur hqdefault sans miniature de flux', async () => {
    const impl = routedFetch([['maxresdefault', textResponse('', { ok: false, status: 404 })]]);

    expect(await resolveVideoThumbnail('vid00000003', null, impl))
      .toBe('https://i.ytimg.com/vi/vid00000003/hqdefault.jpg');
  });
});

describe('youtubeService - decision des annonces', () => {
  const now = new Date('2026-07-26T12:00:00Z');
  const kinds = (actions: YoutubeAction[]) => actions.map((a) => `${a.kind}:${a.notify}`);

  test('annonce un direct nouvellement detecte', () => {
    const actions = planYoutubeActions(
      EMPTY_STATE,
      { live: { isLive: true, videoId: 'live0000001', title: 'Stream' } },
      now,
    );

    expect(kinds(actions)).toEqual(['live:true']);
  });

  test('n annonce pas deux fois le meme direct', () => {
    const actions = planYoutubeActions(
      { ...EMPTY_STATE, lastLiveId: 'live0000001' },
      { live: { isLive: true, videoId: 'live0000001' } },
      now,
    );

    expect(actions).toHaveLength(0);
  });

  test('memorise sans annoncer au premier passage sur une chaine', () => {
    const actions = planYoutubeActions(EMPTY_STATE, { latestVideo: video() }, now);

    expect(kinds(actions)).toEqual(['video:false']);
    expect(actions[0].videoId).toBe('vid00000001');
  });

  test('annonce une nouvelle video une fois la chaine amorcee', () => {
    const actions = planYoutubeActions(
      { ...EMPTY_STATE, lastVideoId: 'ancienne001' },
      { latestVideo: video() },
      now,
    );

    expect(kinds(actions)).toEqual(['video:true']);
  });

  test('n annonce pas une video deja publiee', () => {
    const actions = planYoutubeActions(
      { ...EMPTY_STATE, lastVideoId: 'vid00000001' },
      { latestVideo: video() },
      now,
    );

    expect(actions).toHaveLength(0);
  });

  test('ne republie pas le back-catalogue apres reamorcage', () => {
    const actions = planYoutubeActions(
      { ...EMPTY_STATE, lastVideoId: 'ancienne001' },
      { latestVideo: video({ publishedAt: new Date('2020-01-01T00:00:00Z') }) },
      now,
    );

    expect(kinds(actions)).toEqual(['video:false']);
  });

  test('traite un Short avec son propre etat', () => {
    const actions = planYoutubeActions(
      { ...EMPTY_STATE, lastShortId: 'ancienshort' },
      { latestVideo: video({ videoId: 'short000001', isShort: true }) },
      now,
    );

    expect(kinds(actions)).toEqual(['short:true']);
  });

  test('n annonce pas la video du direct une seconde fois comme upload', () => {
    // Le direct apparait aussi dans le flux RSS : sans garde, doublon garanti.
    const live = { isLive: true, videoId: 'live0000001', title: 'Stream' };
    const actions = planYoutubeActions(
      { ...EMPTY_STATE, lastVideoId: 'ancienne001' },
      { live, latestVideo: video({ videoId: 'live0000001' }) },
      now,
    );

    expect(kinds(actions)).toEqual(['live:true']);
  });

  test('n annonce pas comme upload un direct deja annonce', () => {
    const actions = planYoutubeActions(
      { ...EMPTY_STATE, lastLiveId: 'live0000001', lastVideoId: 'ancienne001' },
      { latestVideo: video({ videoId: 'live0000001' }) },
      now,
    );

    expect(actions).toHaveLength(0);
  });

  test('peut annoncer un direct et une video dans le meme passage', () => {
    const actions = planYoutubeActions(
      { ...EMPTY_STATE, lastVideoId: 'ancienne001' },
      { live: { isLive: true, videoId: 'live0000001' }, latestVideo: video() },
      now,
    );

    expect(kinds(actions)).toEqual(['live:true', 'video:true']);
  });

  test('ne decide rien sans direct ni video', () => {
    expect(planYoutubeActions(EMPTY_STATE, {}, now)).toEqual([]);
  });

  test('transporte description et miniature jusqu a l annonce', () => {
    const [action] = planYoutubeActions(
      { ...EMPTY_STATE, lastVideoId: 'ancienne001' },
      { latestVideo: video({ description: 'Resume', thumbnailUrl: 'https://i2.ytimg.com/vi/x/hqdefault.jpg' }) },
      now,
    );

    expect(action.description).toBe('Resume');
    expect(action.thumbnailUrl).toBe('https://i2.ytimg.com/vi/x/hqdefault.jpg');
  });

  test('transporte la description du direct', () => {
    const [action] = planYoutubeActions(
      EMPTY_STATE,
      { live: { isLive: true, videoId: 'live0000001', title: 'Stream', description: 'On papote' } },
      now,
    );

    expect(action.description).toBe('On papote');
  });
});

describe('youtubeService - rendu des notifications', () => {
  const follow = {
    channelName: 'Kotbo',
    liveMessage: null as string | null,
    videoMessage: null as string | null,
    shortMessage: null as string | null,
  };

  const action: YoutubeAction = {
    kind: 'video',
    videoId: 'vid00000001',
    title: 'Refonte du bot',
    publishedAt: new Date('2026-07-26T10:00:00Z'),
    notify: true,
  };

  test('utilise les messages par defaut sans personnalisation', () => {
    const result = buildYoutubeNotification(follow, action);

    expect(result.content).toBe('🎥 Nouvelle vidéo de **Kotbo** !');
    expect(result.embedTitle).toBe('Refonte du bot');
  });

  test('applique le modele en syntaxe crochets du dashboard', () => {
    const result = buildYoutubeNotification(
      { ...follow, videoMessage: '🎥 Nouvelle vidéo de [channel] : [title]' },
      action,
    );

    expect(result.content).toBe('🎥 Nouvelle vidéo de Kotbo : Refonte du bot');
    expect(result.embedTitle).toBe('🎥 Nouvelle vidéo de Kotbo : Refonte du bot');
  });

  test('conserve le titre par defaut si le modele n utilise pas [title]', () => {
    const result = buildYoutubeNotification({ ...follow, videoMessage: 'Du neuf chez [channel] !' }, action);

    expect(result.content).toBe('Du neuf chez Kotbo !');
    expect(result.embedTitle).toBe('Refonte du bot');
  });

  test('choisit le modele correspondant au type d annonce', () => {
    const configured = { ...follow, liveMessage: 'LIVE [channel]', shortMessage: 'SHORT [channel]' };

    expect(buildYoutubeNotification(configured, { ...action, kind: 'live' }).content).toBe('LIVE Kotbo');
    expect(buildYoutubeNotification(configured, { ...action, kind: 'short' }).content).toBe('SHORT Kotbo');
    // Le modele video reste vide : message par defaut.
    expect(buildYoutubeNotification(configured, action).content).toBe('🎥 Nouvelle vidéo de **Kotbo** !');
  });

  test('prefixe le titre de l embed selon le type', () => {
    expect(buildYoutubeNotification(follow, { ...action, kind: 'live' }).embedTitle).toBe('🔴 En Live : Refonte du bot');
    expect(buildYoutubeNotification(follow, { ...action, kind: 'short' }).embedTitle).toBe('⚡ Short : Refonte du bot');
  });
});

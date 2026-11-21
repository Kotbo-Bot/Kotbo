import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildStreamsUrl,
  buildTwitchNotification,
  chunkLogins,
  fetchLiveStreams,
  getTwitchUserId,
  normalizeTwitchLogin,
  resetTwitchAuthForTests,
  shouldAnnounceStream,
  type FetchLike,
  type TwitchStream,
} from '../../services/integrations/twitchService';

function stream(overrides: Partial<TwitchStream> = {}): TwitchStream {
  return {
    id: 'stream-1',
    user_id: '42',
    user_login: 'kotbo',
    user_name: 'Kotbo',
    title: 'Refonte du bot',
    game_name: 'Software and Game Development',
    viewer_count: 128,
    thumbnail_url: 'https://static-cdn.jtvnw.net/previews/kotbo-{width}x{height}.jpg',
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

/** `fetch` de test : sert le jeton OAuth puis delegue les appels Helix. */
function twitchFetch(handler: (url: string) => Response): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    if (url.includes('id.twitch.tv/oauth2/token')) {
      return jsonResponse({ access_token: 'token-abc', expires_in: 3600 });
    }
    return handler(url);
  }) as FetchLike & { calls: string[] };
  impl.calls = calls;
  return impl;
}

describe('twitchService - normalisation du login', () => {
  test('accepte un pseudo brut', () => {
    expect(normalizeTwitchLogin('  Kotbo  ')).toBe('kotbo');
  });

  test('extrait le login d une URL de chaine', () => {
    // Sans cette extraction, le login stocke ne correspondrait jamais a Helix.
    expect(normalizeTwitchLogin('https://www.twitch.tv/kotbo')).toBe('kotbo');
    expect(normalizeTwitchLogin('twitch.tv/Kotbo/videos')).toBe('kotbo');
  });

  test('retire un arobase de tete', () => {
    expect(normalizeTwitchLogin('@kotbo')).toBe('kotbo');
  });

  test('rejette les saisies invalides', () => {
    expect(normalizeTwitchLogin('')).toBeNull();
    expect(normalizeTwitchLogin('ab')).toBeNull();
    expect(normalizeTwitchLogin('kot bo')).toBeNull();
    expect(normalizeTwitchLogin('kot-bo!')).toBeNull();
    expect(normalizeTwitchLogin('x'.repeat(26))).toBeNull();
  });
});

describe('twitchService - construction des requetes', () => {
  test('buildStreamsUrl encode un parametre par login', () => {
    expect(buildStreamsUrl(['kotbo', 'autre'])).toBe(
      'https://api.twitch.tv/helix/streams?user_login=kotbo&user_login=autre',
    );
  });

  test('chunkLogins respecte la limite de 100 imposee par Helix', () => {
    const logins = Array.from({ length: 250 }, (_, i) => `user${i}`);
    const chunks = chunkLogins(logins);

    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  test('chunkLogins renvoie une liste vide sans login', () => {
    expect(chunkLogins([])).toEqual([]);
  });
});

describe('twitchService - decision d annonce', () => {
  test('annonce un streamer qui vient de passer en live', () => {
    expect(shouldAnnounceStream({ isLive: false, lastStreamId: null }, 'stream-1')).toBe(true);
  });

  test('n annonce pas deux fois le meme stream', () => {
    expect(shouldAnnounceStream({ isLive: true, lastStreamId: 'stream-1' }, 'stream-1')).toBe(false);
  });

  test('annonce un nouveau stream apres une coupure de connexion', () => {
    // Twitch attribue un nouvel id : c'est bien un nouveau live a annoncer.
    expect(shouldAnnounceStream({ isLive: true, lastStreamId: 'stream-1' }, 'stream-2')).toBe(true);
  });
});

describe('twitchService - rendu des notifications', () => {
  test('utilise le message par defaut sans personnalisation', () => {
    const result = buildTwitchNotification({ liveMessage: null }, stream());

    expect(result.content).toBe('🎥 **Kotbo** est en live sur Twitch !');
    expect(result.embedTitle).toBe('Refonte du bot');
  });

  test('applique le modele en syntaxe crochets du dashboard', () => {
    const result = buildTwitchNotification({ liveMessage: '🎥 [channel] est en live : [title]' }, stream());

    expect(result.content).toBe('🎥 Kotbo est en live : Refonte du bot');
    expect(result.embedTitle).toBe('🎥 Kotbo est en live : Refonte du bot');
  });

  test('expose le jeu et le nombre de spectateurs au modele', () => {
    const result = buildTwitchNotification({ liveMessage: '[channel] joue a [game] devant [viewers] pers.' }, stream());

    expect(result.content).toBe('Kotbo joue a Software and Game Development devant 128 pers.');
  });

  test('conserve le titre du stream si le modele n utilise pas [title]', () => {
    const result = buildTwitchNotification({ liveMessage: '[channel] est en live !' }, stream());

    expect(result.embedTitle).toBe('Refonte du bot');
  });
});

describe('twitchService - appels API', () => {
  beforeEach(() => {
    resetTwitchAuthForTests();
    process.env.TWITCH_CLIENT_ID = 'client-id';
    process.env.TWITCH_CLIENT_SECRET = 'client-secret';
  });

  afterEach(() => {
    resetTwitchAuthForTests();
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
  });

  test('getTwitchUserId renvoie l identifiant de la chaine', async () => {
    const impl = twitchFetch(() => jsonResponse({ data: [{ id: '42', login: 'kotbo' }] }));

    expect(await getTwitchUserId('https://twitch.tv/Kotbo', impl)).toBe('42');
    expect(impl.calls[1]).toBe('https://api.twitch.tv/helix/users?login=kotbo');
  });

  test('getTwitchUserId renvoie null pour une chaine inexistante', async () => {
    const impl = twitchFetch(() => jsonResponse({ data: [] }));
    expect(await getTwitchUserId('kotbo', impl)).toBeNull();
  });

  test('getTwitchUserId n appelle pas l API pour une saisie invalide', async () => {
    const impl = twitchFetch(() => jsonResponse({ data: [] }));

    expect(await getTwitchUserId('ab', impl)).toBeNull();
    expect(impl.calls).toHaveLength(0);
  });

  test('reutilise le jeton en cache entre deux appels', async () => {
    const impl = twitchFetch(() => jsonResponse({ data: [{ id: '42', login: 'kotbo' }] }));

    await getTwitchUserId('kotbo', impl);
    await getTwitchUserId('kotbo', impl);

    expect(impl.calls.filter((u) => u.includes('oauth2/token'))).toHaveLength(1);
  });

  test('renouvelle le jeton et rejoue la requete apres un 401', async () => {
    let helixCalls = 0;
    const impl = twitchFetch(() => {
      helixCalls++;
      // Jeton revoque avant expiration : le premier appel echoue, le second passe.
      return helixCalls === 1
        ? jsonResponse({ error: 'Unauthorized' }, { ok: false, status: 401 })
        : jsonResponse({ data: [{ id: '42', login: 'kotbo' }] });
    });

    expect(await getTwitchUserId('kotbo', impl)).toBe('42');
    expect(impl.calls.filter((u) => u.includes('oauth2/token'))).toHaveLength(2);
  });

  test('abandonne apres un second 401', async () => {
    const impl = twitchFetch(() => jsonResponse({}, { ok: false, status: 401 }));
    expect(await getTwitchUserId('kotbo', impl)).toBeNull();
  });

  test('fetchLiveStreams indexe les streams par login en minuscules', async () => {
    const impl = twitchFetch(() => jsonResponse({ data: [stream({ user_login: 'Kotbo' })] }));

    const liveMap = await fetchLiveStreams(['kotbo', 'horsligne'], impl);

    expect(liveMap.get('kotbo')?.id).toBe('stream-1');
    expect(liveMap.has('horsligne')).toBe(false);
  });

  test('fetchLiveStreams decoupe les requetes au-dela de 100 chaines', async () => {
    const impl = twitchFetch(() => jsonResponse({ data: [] }));

    await fetchLiveStreams(Array.from({ length: 150 }, (_, i) => `user${i}`), impl);

    expect(impl.calls.filter((u) => u.includes('helix/streams'))).toHaveLength(2);
  });

  test('fetchLiveStreams ignore un lot en erreur sans perdre les autres', async () => {
    let batch = 0;
    const impl = twitchFetch(() => {
      batch++;
      return batch === 1
        ? jsonResponse({}, { ok: false, status: 500 })
        : jsonResponse({ data: [stream({ user_login: 'user100' })] });
    });

    const liveMap = await fetchLiveStreams(Array.from({ length: 150 }, (_, i) => `user${i}`), impl);

    expect(liveMap.has('user100')).toBe(true);
  });

  test('renvoie une map vide sans identifiants Twitch configures', async () => {
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
    const impl = twitchFetch(() => jsonResponse({ data: [stream()] }));

    expect((await fetchLiveStreams(['kotbo'], impl)).size).toBe(0);
    expect(impl.calls).toHaveLength(0);
  });
});

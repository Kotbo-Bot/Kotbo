// Un lot Helix en échec ne dit rien du statut de ses chaînes : un live en cours
// reste en ligne, et n'est pas réannoncé, mention comprise, au retour d'Helix.
import { afterAll, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';

type Suivi = { id: string; isLive: boolean; lastStreamId: string | null } & Record<string, unknown>;
const suivis: Suivi[] = [{
  id: 'suivi-1', guildId: 'g1', streamerName: 'kotbo', isLive: true, lastStreamId: 'stream-1',
  discordChannelId: 'salon', mention: '@everyone', liveMessage: null,
  guild: { publicChannelId: null, dashboardFeatureConfigs: [] },
}];
const mockDb = {
  twitchChannelFollow: {
    findMany: async () => suivis.map((suivi) => ({ ...suivi })),
    update: async ({ where, data }: { where: { id: string }; data: Partial<Suivi> }) =>
      Object.assign(suivis.find((suivi) => suivi.id === where.id)!, data),
  },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const env = { TWITCH_CLIENT_ID: process.env.TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET: process.env.TWITCH_CLIENT_SECRET };
Object.assign(process.env, { TWITCH_CLIENT_ID: 'client', TWITCH_CLIENT_SECRET: 'secret' });
afterAll(() => {
  for (const [cle, valeur] of Object.entries(env)) {
    if (valeur === undefined) delete process.env[cle];
    else process.env[cle] = valeur;
  }
});

const { checkTwitchFollows } = await import('../../services/integrations/twitchService.js');

const send = mock(async () => undefined);
const salon = { isTextBased: () => true, send };
const client = { guilds: { cache: new Map([['g1', { channels: { cache: new Map([['salon', salon]]) } }]]) } } as unknown as Client;

/** Helix : le jeton OAuth, puis `statuts` pour l'endpoint des streams. */
const helix = (statuts: () => Response) => async (url: string) =>
  url.includes('oauth2/token') ? Response.json({ access_token: 'jeton', expires_in: 3600 }) : statuts();

test('une panne de Helix laisse le live en ligne et ne le fait pas réannoncer à son retour', async () => {
  await checkTwitchFollows(client, helix(() => new Response('panne', { status: 500 })));
  expect(suivis[0].isLive).toBe(true);

  await checkTwitchFollows(client, helix(() => Response.json({ data: [{ id: 'stream-1', user_login: 'kotbo', user_name: 'Kotbo', title: 'Live' }] })));
  expect(send).not.toHaveBeenCalled();
  expect(suivis[0]).toMatchObject({ isLive: true, lastStreamId: 'stream-1' });
});

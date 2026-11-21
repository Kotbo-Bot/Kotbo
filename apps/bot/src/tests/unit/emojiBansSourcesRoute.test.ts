// Kotbo recense tous les serveurs où il est : la recherche et la liste d'emojis
// d'un serveur source ne doivent pas révéler un serveur privé à un autre.
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { Collection, type Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN } from '../../api/shared.js';
import { dashboardCall, mockDashboardGate } from '../helpers/honoDashboard.js';

const GUILD = '100000000000000001';
const PRIVATE = '300000000000000001';
const DISCOVERABLE = '300000000000000002';
const TAGGED = '300000000000000003';

type Fiche = { guildId: string; name: string; icon: string | null; memberCount: number | null; source: string };
const fiches: Fiche[] = [
  { guildId: PRIVATE, name: 'Club privé', icon: null, memberCount: 40, source: 'bot' },
  { guildId: DISCOVERABLE, name: 'Club public', icon: null, memberCount: 900, source: 'bot' },
  { guildId: TAGGED, name: 'Club du tag', icon: null, memberCount: 12, source: 'tag' },
];

/** Les filtres Prisma de ces routes : égalité, not, in, notIn, contains insensible, OR et AND. */
type Where = Record<string, unknown>;
function respecte(fiche: Fiche, where: Where): boolean {
  return Object.entries(where).every(([champ, filtre]) => {
    if (champ === 'OR') return (filtre as Where[]).some((w) => respecte(fiche, w));
    if (champ === 'AND') return [filtre].flat().every((w) => respecte(fiche, w as Where));
    const valeur = fiche[champ as keyof Fiche];
    if (typeof filtre !== 'object' || filtre === null) return valeur === filtre;
    const f = filtre as { not?: unknown; in?: unknown[]; notIn?: unknown[]; contains?: string };
    return (!('not' in f) || valeur !== f.not)
      && (!f.in || f.in.includes(valeur))
      && (!f.notIn || !f.notIn.includes(valeur))
      && (f.contains === undefined || String(valeur).toLowerCase().includes(f.contains.toLowerCase()));
  });
}

const mockDb = {
  discordExternalGuild: {
    findMany: mock(async ({ where, take }: { where: Where; take?: number }) => fiches
      .filter((f) => respecte(f, where))
      .sort((a, b) => (b.memberCount ?? -Infinity) - (a.memberCount ?? -Infinity))
      .slice(0, take)),
    findUnique: mock(async ({ where }: { where: { guildId: string } }) => fiches.find((f) => f.guildId === where.guildId) ?? null),
    upsert: mock(async ({ where, create, update }: { where: { guildId: string }; create: Fiche; update: Partial<Fiche> }) => {
      const fiche = fiches.find((f) => f.guildId === where.guildId);
      if (!fiche) return fiches[fiches.push(create) - 1];
      // Prisma ne touche pas un champ `undefined`.
      for (const [champ, valeur] of Object.entries(update)) if (valeur !== undefined) Object.assign(fiche, { [champ]: valeur });
      return fiche;
    }),
  },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: '200000000000000001', username: 'Admin' });
const { createEmojiBansRouter } = await import('../../api/routes/dashboard/modules/emoji-bans.js');
const { resolveExternalGuild } = await import('../../services/core/serverTagService.js');

const guild = (id: string, features: string[]) => ({
  id,
  features,
  emojis: { cache: new Collection([['1', { id: '1', name: 'secret', animated: false }]]) },
  stickers: { cache: new Collection(), fetch: async () => new Collection() },
});
const client = {
  guilds: { cache: new Collection<string, object>([[PRIVATE, guild(PRIVATE, [])], [DISCOVERABLE, guild(DISCOVERABLE, ['DISCOVERABLE'])]]) },
} as unknown as Client;
const router = createEmojiBansRouter(client);
const call = (suffix: string) => dashboardCall(router, 'GET', `/api/dashboard/guilds/${GUILD}/emoji-bans${suffix}`);
const recherche = async (q: string) => (await call(`/search?q=${q}`)).body.servers.map((s: { guildId: string }) => s.guildId);

describe('serveurs sources des emojis interdits', () => {
  test('la recherche tait un serveur privé connu de Kotbo seul', async () => {
    expect(await recherche('club')).toEqual([DISCOVERABLE, TAGGED]);
  });

  test('vingt fiches privées mieux classées ne masquent pas les serveurs publics', async () => {
    const privees = Array.from({ length: 20 }, (_, i) => ({ guildId: `4000000000000000${10 + i}`, name: `Club fermé ${i}`, icon: null, memberCount: 5000 + i, source: 'bot' }));
    fiches.push(...privees);
    try {
      expect(await recherche('club')).toEqual([DISCOVERABLE, TAGGED]);
    } finally {
      fiches.splice(-privees.length);
    }
  });

  test('une fiche résolue par tag reste proposée quand Kotbo relit ce serveur dans son cache', async () => {
    // Kotbo est aussi sur le serveur du tag, qui n'est pas découvrable.
    const vivant = {
      ...guild(TAGGED, []), name: 'Club du tag', icon: null, description: null, memberCount: 12,
      emojis: { cache: new Collection() }, bannerURL: () => null, discoverySplashURL: () => null, splashURL: () => null,
    };
    (client.guilds.cache as Collection<string, object>).set(TAGGED, vivant);
    try {
      await resolveExternalGuild(client, TAGGED);
      expect(await recherche('club')).toContain(TAGGED);
    } finally {
      client.guilds.cache.delete(TAGGED);
    }
  });

  test("les emojis d'un serveur privé ne sont pas listés, ceux d'un serveur découvrable le sont", async () => {
    expect((await call(`/sources/${PRIVATE}`)).body.emojis).toEqual([]);
    expect((await call(`/sources/${DISCOVERABLE}`)).body.emojis).toHaveLength(1);
  });
});

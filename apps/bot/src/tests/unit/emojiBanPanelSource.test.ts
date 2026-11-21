// Comme Discord, le panneau du clic droit ne nomme le serveur d'origine d'un
// emoji que s'il est public : un serveur privé reste désigné par son id.
import { expect, mock, test } from 'bun:test';
import path from 'node:path';
import { Collection, type Message } from 'discord.js';

const PRIVATE = '300000000000000001';
const DISCOVERABLE = '300000000000000002';
const SANS_FICHE = '300000000000000003';

const fiches = [
  { guildId: PRIVATE, name: 'Club privé', source: 'bot' },
  { guildId: DISCOVERABLE, name: 'Club public', source: 'bot' },
];
const mockDb = {
  discordExternalGuild: {
    findMany: mock(async ({ where }: { where: { guildId: { in: string[] } } }) => fiches.filter((f) => where.guildId.in.includes(f.guildId))),
  },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}
const { buildEmojiBanPicker } = await import('../../services/moderation/emojiBanPanel.js');

const guild = (id: string, name: string, features: string[]) => ({ id, name, features, iconURL: () => `https://cdn.discordapp.com/icons/${id}.png` });
const message = {
  guildId: '100000000000000001',
  content: '<:secret:400000000000000001> <:fete:400000000000000002> <:neuf:400000000000000003>',
  stickers: new Collection(),
  client: {
    emojis: { cache: new Map([
      ['400000000000000001', { guild: { id: PRIVATE } }],
      ['400000000000000002', { guild: { id: DISCOVERABLE } }],
      ['400000000000000003', { guild: { id: SANS_FICHE } }],
    ]) },
    guilds: { cache: new Map([
      [PRIVATE, guild(PRIVATE, 'Club privé', [])],
      [DISCOVERABLE, guild(DISCOVERABLE, 'Club public', ['DISCOVERABLE'])],
      [SANS_FICHE, guild(SANS_FICHE, 'Club sans fiche', ['DISCOVERABLE'])],
    ]) },
  },
} as unknown as Message<true>;

test("le panneau tait le nom d'un serveur privé d'origine et garde celui d'un serveur public", async () => {
  const panel = JSON.stringify(await buildEmojiBanPicker(message, '200000000000000001'));
  expect(panel).not.toContain('Club privé');
  expect(panel).toContain(PRIVATE);
  expect(panel).toContain('Club public');
  // Découvrable mais pas encore recensé en base : Kotbo le voit, il garde son nom.
  expect(panel).toContain('Club sans fiche');
});

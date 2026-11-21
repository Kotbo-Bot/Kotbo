import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { Events, type Client, type EmbedBuilder } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const envoyes: EmbedBuilder[] = [];
mock.module('../../utils/db.js', () => ({ default: {}, prisma: {}, prismaRead: {} }));
mock.module('../../utils/logDispatch.js', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/logDispatch.ts'), {
  sendLogEmbed: async (_guild: unknown, embed: EmbedBuilder) => { envoyes.push(embed); },
}));

const { registerAdvancedLogsListener } = await import('../../events/advancedLogs.js');

const ecouteurs = new Map<string, (...args: unknown[]) => Promise<void>>();
registerAdvancedLogsListener({
  guilds: { cache: new Map() },
  on: (evenement: string, ecouteur: (...args: unknown[]) => Promise<void>) => ecouteurs.set(evenement, ecouteur),
} as unknown as Client);

const champ = (nom: string) => envoyes.at(-1)?.data.fields?.find((f) => f.name === nom)?.value ?? '';

describe('logs avancés : champs bornés à la limite Discord', () => {
  test('« Salon modifié » avec de longs sujets', async () => {
    const salon = (topic: string) => ({ id: '1', name: 'général', guild: {}, topic });

    await ecouteurs.get(Events.ChannelUpdate)!(salon('a'.repeat(1000)), salon('b'.repeat(1000)));

    expect(champ('Détails').length).toBeGreaterThan(0);
    expect(champ('Détails').length).toBeLessThanOrEqual(1024);
  });

  test('« Rôles membre modifiés » avec de nombreux rôles', async () => {
    const membre = (roles: number) => ({
      id: '2', partial: false, guild: { id: 'g' }, user: { tag: 'bob' },
      roles: { cache: new Map(Array.from({ length: roles }, (_, i) => [`90000000000000${1000 + i}`, { id: `90000000000000${1000 + i}`, name: `rôle ${i}` }])) },
    });

    await ecouteurs.get(Events.GuildMemberUpdate)!(membre(0), membre(60));

    expect(champ('Changements').length).toBeGreaterThan(0);
    expect(champ('Changements').length).toBeLessThanOrEqual(1024);
  });
});

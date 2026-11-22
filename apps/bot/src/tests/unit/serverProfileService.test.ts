import { afterAll, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';

// Le serveur décrit a une invitation permanente suivie en base.
const mockDb = {
  guildInvite: { findFirst: mock(async () => ({ code: 'entree-privee' })) },
  communitySite: { findUnique: mock(async () => null) },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

// Pas de réseau : le widget public du serveur n'est pas activé.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { getServerProfile, resolveDefaultInvite } = await import('../../services/analytics/serverProfileService.js');

describe('getServerProfile', () => {
  test('la fiche d’un serveur tiers ne livre pas son invitation permanente suivie', async () => {
    // Le bot n'est pas sur le serveur décrit : ni vanity, ni aperçu de découverte.
    const client = {
      guilds: { cache: new Map() },
      fetchGuildPreview: () => Promise.reject(new Error('Unknown Guild')),
    } as unknown as Client;
    const guildId = '111111111111111111';

    // L'invitation suivie existe bien : le profil du serveur courant la garde…
    expect(await resolveDefaultInvite(client, guildId)).toEqual({
      code: 'entree-privee',
      url: 'https://discord.gg/entree-privee',
      kind: 'tracked',
    });
    // …mais la fiche d'un serveur désigné par son seul identifiant ne la donne pas.
    const profile = await getServerProfile(client, guildId, 'Serveur tiers');
    expect(profile.defaultInvite).toBeNull();
  });
});

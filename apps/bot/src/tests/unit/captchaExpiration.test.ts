import { describe, expect, mock, test } from 'bun:test';
import type { Client } from 'discord.js';

type Ligne = Record<string, unknown>;

const echue = new Date(Date.now() - 60_000);
const sessions: Ligne[] = [
  { id: 'ici', guildId: 'shard-courant', status: 'PENDING', awaitingTurn: false, expiresAt: echue },
  { id: 'ailleurs', guildId: 'autre-shard', status: 'PENDING', awaitingTurn: false, expiresAt: echue },
];

function correspond(ligne: Ligne, where: Ligne): boolean {
  return Object.entries(where).every(([champ, cond]) => {
    const valeur = ligne[champ];
    if (cond && typeof cond === 'object' && 'in' in cond) return (cond.in as unknown[]).includes(valeur);
    if (cond && typeof cond === 'object' && 'lte' in cond) return (valeur as Date) <= (cond.lte as Date);
    return valeur === cond;
  });
}

mock.module('../../utils/db.js', () => {
  const db = {
    captchaSession: {
      findMany: async ({ where }: { where: Ligne }) => sessions.filter((s) => correspond(s, where)),
      update: async ({ where, data }: { where: { id: string }; data: Ligne }) => Object.assign(sessions.find((s) => s.id === where.id)!, data),
    },
  };
  return { default: db, prisma: db, prismaRead: db };
});
mock.module('../../services/moderation/raidProtectionService.js', () => ({ getRaidProtectionConfig: async () => null }));

const { expireOverdueCaptchaSessions } = await import('../../services/moderation/captchaService.js');

describe('expiration des captchas échus', () => {
  test('un shard ne touche pas aux sessions des serveurs d\'un autre shard', async () => {
    const client = { guilds: { cache: new Map([['shard-courant', {}]]) } } as unknown as Client;

    await expireOverdueCaptchaSessions(client);

    expect(sessions.map((s) => s.status)).toEqual(['EXPIRED', 'PENDING']);
  });
});

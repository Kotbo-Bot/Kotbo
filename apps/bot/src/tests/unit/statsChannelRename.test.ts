import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { ChannelType, Collection, Events, VoiceChannel, type Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '987654321098765432';
const CHANNEL_ID = '876543210987654321';
const GLOBAL_PASS_INTERVAL_MS = 10 * 60 * 1000;

/** Borne d'attente d'un renommage, réduite pour que le test reste rapide. */
const RENAME_BOUND_MS = 40;
/** Au-delà, la mise à jour est considérée comme figée. */
const STUCK_AFTER_MS = 1_000;

const prismaMock = {
  guild: {
    findUnique: mock(async () => ({
      statsEnabled: true,
      statsConfig: { memberChannelId: CHANNEL_ID, memberTemplate: 'Membres : {count}' },
    })),
    findMany: mock(async () => [{ id: GUILD_ID }]),
  },
};

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}

const realDiscordUtils = await import('../../utils/discord.js');
mockerModule('../../utils/db', { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock });
mockerModule('../../utils/discord', { ...realDiscordUtils, RENAME_TIMEOUT_MS: RENAME_BOUND_MS });

const { registerStatsChannelListener, updateGuildStats } = await import('../../events/stats.js');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Renommages que Discord n'a pas encore appliqués (fenêtre de 10 minutes). */
let heldRenames: Array<() => void> = [];

function discordAppliesHeldRenames(): void {
  for (const apply of heldRenames.splice(0)) apply();
}

const channel = Object.assign(Object.create(VoiceChannel.prototype) as VoiceChannel, {
  id: CHANNEL_ID,
  name: 'Membres : 41',
  type: ChannelType.GuildVoice,
});
const setName = mock((name: string) => new Promise<VoiceChannel>((resolve) => {
  heldRenames.push(() => {
    channel.name = name;
    resolve(channel);
  });
}));
Object.assign(channel, { setName });

const guild = {
  id: GUILD_ID,
  name: 'Serveur de test',
  memberCount: 42,
  preferredLocale: 'fr',
  premiumSubscriptionCount: 0,
  members: { cache: new Collection<string, unknown>() },
  channels: { cache: new Collection<string, unknown>([[CHANNEL_ID, channel]]) },
};

const handlers = new Map<string, (...args: unknown[]) => void>();
const client = {
  guilds: { cache: new Collection<string, unknown>([[GUILD_ID, guild]]) },
  on: (event: string, handler: (...args: unknown[]) => void) => {
    handlers.set(event, handler);
    return client;
  },
} as unknown as Client;

/** Lance une mise à jour et dit si elle a rendu la main avant d'être jugée figée. */
async function runPass(): Promise<'terminée' | 'figée'> {
  return Promise.race([
    updateGuildStats(client, GUILD_ID).then(() => 'terminée' as const),
    delay(STUCK_AFTER_MS).then(() => 'figée' as const),
  ]);
}

beforeEach(() => {
  channel.name = 'Membres : 41';
  guild.memberCount = 42;
  setName.mockClear();
  prismaMock.guild.findMany.mockClear();
});

afterEach(async () => {
  // Discord finit toujours par appliquer ce qu'il retenait : rien ne reste en suspens d'un test à l'autre.
  discordAppliesHeldRenames();
  await delay(0);
});

describe('renommage borné des salons statistiques', () => {
  test('un renommage que Discord fait patienter ne fige pas la mise à jour', async () => {
    expect(await runPass()).toBe('terminée');
    expect(setName).toHaveBeenCalledTimes(1);
    expect(setName).toHaveBeenCalledWith('Membres : 42');
  });

  test('un renommage encore en attente de Discord n\'est pas empilé une seconde fois', async () => {
    await runPass();
    guild.memberCount = 43;
    await runPass();

    expect(setName).toHaveBeenCalledTimes(1);

    // Une fois le renommage appliqué par Discord, la passe suivante peut de nouveau renommer.
    discordAppliesHeldRenames();
    await delay(0);
    expect(await runPass()).toBe('terminée');
    expect(setName).toHaveBeenCalledTimes(2);
    expect(setName).toHaveBeenLastCalledWith('Membres : 43');
  });

  test('une passe globale ne démarre pas tant que la précédente tourne', async () => {
    const realSetInterval = globalThis.setInterval;
    const globalTicks: Array<() => void> = [];
    globalThis.setInterval = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === GLOBAL_PASS_INTERVAL_MS) {
        globalTicks.push(handler);
        return 0;
      }
      return realSetInterval(handler, ms, ...rest);
    }) as unknown as typeof setInterval;

    try {
      registerStatsChannelListener(client);
      handlers.get(Events.ClientReady)?.();
      expect(globalTicks).toHaveLength(1);

      // L'intervalle de 10 minutes tombe alors que la première passe n'est pas finie :
      // la seconde ne démarre pas, elle ne relit même pas la liste des serveurs.
      globalTicks[0]();
      expect(prismaMock.guild.findMany).toHaveBeenCalledTimes(1);

      // La première passe terminée (renommage borné), la suivante repart normalement.
      const deadline = Date.now() + STUCK_AFTER_MS;
      while (prismaMock.guild.findMany.mock.calls.length < 2 && Date.now() < deadline) {
        await delay(RENAME_BOUND_MS);
        globalTicks[0]();
      }
      expect(prismaMock.guild.findMany).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});

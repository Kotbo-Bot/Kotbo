import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client, Guild } from 'discord.js';

const RAID_MESSAGE = '@everyone @here <@&555555555555555555> rejoignez vite discord.gg/raid';

const session = { id: 'session-1', guildId: 'guild-1', channelId: 'sandbox-1', status: 'RUNNING' };
const mockDb = {
  simulationConfig: {
    findUnique: async () => ({ guildId: 'guild-1', enabled: true, testChannelId: 'sandbox-1', stepTimeoutSeconds: 0, traineeRoleIds: [] }),
  },
  simulationScenario: {
    findFirst: async () => ({
      id: 'scenario-1',
      steps: [{
        id: 'step-1',
        kind: 'SPAM',
        authorName: 'Raider',
        authorAvatarUrl: null,
        content: RAID_MESSAGE,
        delaySeconds: 0,
        expected: { action: 'BAN' },
        points: 10,
      }],
    }),
  },
  simulationSession: {
    findFirst: async () => null,
    create: async () => session,
    // La clôture relit la session avec son scénario : rien à clôturer ici.
    findUnique: async (args: { include?: unknown }) => (args.include ? null : session),
    update: async () => session,
  },
  simulationAnswer: { create: async () => ({}) },
};
for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { startSession } = await import('../../services/staff/simulationService.js');

describe('déroulé d\'une simulation', () => {
  test('un incident de raid s\'affiche tel quel mais ne notifie ni @everyone ni les rôles', async () => {
    let resolveSent!: (options: Record<string, unknown>) => void;
    const sent = new Promise<Record<string, unknown>>((resolve) => { resolveSent = resolve; });

    const webhook = {
      id: 'webhook-1',
      name: 'Kotbo Simulation',
      owner: { id: 'bot-1' },
      send: async (options: Record<string, unknown>) => { resolveSent(options); return { id: 'posted-1' }; },
    };
    const sandbox = {
      id: 'sandbox-1',
      fetchWebhooks: async () => [webhook],
      send: async () => null,
      messages: { delete: async () => null },
    };
    const guild = { id: 'guild-1', channels: { cache: new Map([['sandbox-1', sandbox]]) } } as unknown as Guild;
    const client = { user: { id: 'bot-1' }, guilds: { cache: new Map([['guild-1', guild]]) } } as unknown as Client;

    await startSession(client, guild, 'scenario-1', { id: 'trainee-1', name: 'Alice' }, 'sandbox-1');
    const options = await sent;

    expect(options.content).toBe(RAID_MESSAGE);
    expect(options.allowedMentions).toEqual({ parse: [] });
  });
});

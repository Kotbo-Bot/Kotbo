import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

/**
 * D2 — `sendLogEmbed` passe à l'audit en base les détails fournis par
 * l'appelant ; sans eux, l'audit garde le résumé de l'embed, comme avant.
 */

const audits: Array<Record<string, unknown>> = [];
const prismaMock = {
  guildLogEventConfig: { findUnique: mock(async () => ({ enabled: true, channelId: '700000000000000000' })) },
  guild: { findUnique: mock(async () => null) },
};

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/cache.ts'), {
    getCachedGuild: mock(async () => ({ logIgnoredChannelIds: [] })),
    cache: { get: mock(async () => null), set: mock(async () => undefined) },
  })],
  ['../../utils/auditLogger', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/auditLogger.ts'), {
    queueAuditLog: mock((log: Record<string, unknown>) => { audits.push(log); }),
  })],
];
for (const [relatif, fabrique] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}

const { sendLogEmbed } = await import('../../utils/logDispatch.js');

const guild = {
  id: '100000000000000000',
  name: 'Serveur',
  channels: { cache: new Map(), fetch: mock(async () => null) },
} as never;

function embed() {
  return new EmbedBuilder().setTitle('🎛️ Action').addFields(
    { name: 'Membre', value: 'a' }, { name: 'Salon', value: 'b' }, { name: 'Action', value: 'c' },
    { name: 'Composant', value: 'd' }, { name: 'Issue', value: 'Sans effet' },
  );
}

beforeEach(() => { audits.length = 0; });

describe('D2 — audit en base de sendLogEmbed', () => {
  test('sans détails fournis : résumé de l\'embed et salon de logs, comme avant', async () => {
    await sendLogEmbed(guild, embed(), 'voice_panel', undefined, 'tag', ['1']);
    expect(audits).toHaveLength(1);
    expect(audits[0].channelId).toBe('700000000000000000');
    expect(String(audits[0].details)).not.toContain('Issue');
  });

  test('détails fournis : passés tels quels, avec le salon de l\'action', async () => {
    await sendLogEmbed(guild, embed(), 'voice_panel', undefined, 'tag', ['1'], { details: 'Issue: Sans effet', channelId: '1' });
    expect(audits[0].details).toBe('Issue: Sans effet');
    expect(audits[0].channelId).toBe('1');
  });
});

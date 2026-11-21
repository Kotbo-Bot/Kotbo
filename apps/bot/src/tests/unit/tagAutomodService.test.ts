import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { PermissionFlagsBits, PermissionsBitField, type GuildMember } from 'discord.js';
import type { TagAutomodConfig } from '@prisma/client';

const mockDb = {
  guild: { findUnique: mock(async () => ({ id: 'guild-1', language: 'fr' })) },
  discordExternalGuild: { findUnique: mock(async () => null) },
  tagAutomodEvent: { create: mock(async () => ({})) },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { applyTagHit } = await import('../../services/moderation/tagAutomod/tagAutomodService.js');

/** Rôle placé sous le bot, non géré : seul `admin` change. */
const role = (id: string, admin: boolean) =>
  [id, { id, managed: false, editable: true, permissions: new PermissionsBitField(admin ? PermissionFlagsBits.Administrator : 0n) }] as const;

const add = mock(async () => undefined);
const member = {
  id: 'member-1',
  user: { tag: 'membre#0001' },
  guild: { id: 'guild-1', preferredLocale: 'fr', roles: { cache: new Map([role('role-ok', false), role('role-admin', true)]) } },
  roles: { add },
} as unknown as GuildMember;

const applyRole = (roleId: string) => applyTagHit(
  member,
  { guildId: '200', tag: 'RAID' },
  { trigger: 'JOIN', action: 'ROLE', roleId } as Parameters<typeof applyTagHit>[2],
  { testMode: false } as TagAutomodConfig,
  { silent: true },
);

describe('applyTagHit : action ROLE', () => {
  test('une règle donne un rôle ordinaire, jamais un rôle Administrateur placé sous le bot', async () => {
    expect(await applyRole('role-ok')).toBe('APPLIED');
    expect(await applyRole('role-admin')).toBe('FAILED');
    expect(add).toHaveBeenCalledTimes(1);
  });
});

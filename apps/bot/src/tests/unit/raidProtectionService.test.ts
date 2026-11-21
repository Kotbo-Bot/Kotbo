import { describe, expect, mock, test } from 'bun:test';
import type { Guild } from 'discord.js';
import type { RaidProtectionConfig } from '@prisma/client';

let row = {} as RaidProtectionConfig;

mock.module('../../utils/db.js', () => {
  const db = {
    raidProtectionConfig: {
      findUnique: async () => row,
      upsert: async ({ update }: { update: Partial<RaidProtectionConfig> }) => (row = { ...row, ...update }),
    },
  };
  return { default: db, prisma: db, prismaRead: db };
});
mock.module('../../utils/cache.js', () => ({ cache: { get: async () => null, set: async () => {}, delete: async () => {} } }));
mock.module('../../services/notifications/notifyService.js', () => ({ notifyJoinBlocked: async () => {} }));

const { activateRaidMode, deactivateRaidMode } = await import('../../services/moderation/raidProtectionService.js');

describe('raid mode automatique en action LOCK', () => {
  test('la sortie du raid mode rouvre les invitations', async () => {
    row = { guildId: 'g', antiRaidAction: 'LOCK', joinLockEnabled: false, dmLockEnabled: false, raidModeActive: false, antiRaidAlertChannelId: null } as RaidProtectionConfig;
    const setIncidentActions = mock(async (_: { invitesDisabledUntil: Date | null }) => {});
    const guild = { id: 'g', name: 'G', setIncidentActions } as unknown as Guild;

    await activateRaidMode(guild, row, false);
    expect(setIncidentActions.mock.lastCall?.[0].invitesDisabledUntil).toBeInstanceOf(Date);

    await deactivateRaidMode(guild);
    expect(setIncidentActions.mock.lastCall?.[0].invitesDisabledUntil).toBeNull();
  });
});

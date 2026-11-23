import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import { TextChannel, Client } from 'discord.js';
import type { StaffServerLink } from '@prisma/client';

// Mock the database dependency
const mockDb = {
  staffServerLink: {
    findMany: mock(() => Promise.resolve([] as unknown[])),
  },
};

const dbPath = path.resolve(__dirname, '../../utils/db.ts');
const dbJsPath = path.resolve(__dirname, '../../utils/db.js');

mock.module(dbPath, () => ({
  default: mockDb,
  prisma: mockDb,
  prismaRead: mockDb,
}));

mock.module(dbJsPath, () => ({
  default: mockDb,
  prisma: mockDb,
  prismaRead: mockDb,
}));

import {
  resolveStaffNotifyChannelId,
  computeStaffRoleTransition,
  getStaffServerNotifyChannel,
} from '../../services/staff/staffServerService.js';

describe('StaffServerService unit tests', () => {
  beforeEach(() => {
    (mockDb.staffServerLink.findMany as ReturnType<typeof mock>).mockClear();
  });

  describe('resolveStaffNotifyChannelId', () => {
    test('should resolve correct channel ID when mapping exists and link is enabled', () => {
      const links = [
        {
          id: 'link-1',
          enabled: true,
          mainGuildId: 'main-1',
          staffGuildId: 'staff-1',
          modlogMirrorChannelId: 'channel-modlog',
          sanctionReportChannelId: 'channel-sanctions',
          internalReportChannelId: 'channel-reports',
        } as StaffServerLink,
      ];

      expect(resolveStaffNotifyChannelId(links, 'main-1', 'internalReport')).toEqual({ staffGuildId: 'staff-1', channelId: 'channel-reports' });

      const res = resolveStaffNotifyChannelId(links, 'main-1', 'modlog');
      expect(res).toEqual({ staffGuildId: 'staff-1', channelId: 'channel-modlog' });

      const res2 = resolveStaffNotifyChannelId(links, 'main-1', 'sanctionReport');
      expect(res2).toEqual({ staffGuildId: 'staff-1', channelId: 'channel-sanctions' });
    });

    test('should return null if link is disabled', () => {
      const links = [
        {
          id: 'link-1',
          enabled: false,
          mainGuildId: 'main-1',
          staffGuildId: 'staff-1',
          modlogMirrorChannelId: 'channel-modlog',
        } as StaffServerLink,
      ];

      const res = resolveStaffNotifyChannelId(links, 'main-1', 'modlog');
      expect(res).toBeNull();
    });

    test('should return null if channel ID is not configured', () => {
      const links = [
        {
          id: 'link-1',
          enabled: true,
          mainGuildId: 'main-1',
          staffGuildId: 'staff-1',
        } as StaffServerLink,
      ];

      const res = resolveStaffNotifyChannelId(links, 'main-1', 'modlog');
      expect(res).toBeNull();
    });
  });

  describe('computeStaffRoleTransition', () => {
    const mockLink = {
      id: 'link-1',
      roleMappings: [
        { mainDiscordRoleId: 'role-main-admin', staffDiscordRoleId: 'role-staff-admin' },
        { mainDiscordRoleId: 'role-main-mod', staffDiscordRoleId: 'role-staff-mod' },
      ],
    } as unknown as Parameters<typeof computeStaffRoleTransition>[0];

    test('gained-first: transitioning from no staff roles to having one', () => {
      const res = computeStaffRoleTransition(mockLink, ['role-user'], ['role-user', 'role-main-mod'], true);
      expect(res).toBe('gained-first');
    });

    test('lost-all: transitioning from having staff roles to having none', () => {
      const res = computeStaffRoleTransition(mockLink, ['role-user', 'role-main-mod', 'role-main-admin'], ['role-user'], true);
      expect(res).toBe('lost-all');
    });

    test('none: no change in staff roles presence', () => {
      const res1 = computeStaffRoleTransition(mockLink, ['role-main-mod'], ['role-main-admin'], true);
      expect(res1).toBe('none');

      const res2 = computeStaffRoleTransition(mockLink, ['role-user'], ['role-user', 'role-other'], true);
      expect(res2).toBe('none');
    });
  });

  describe('getStaffServerNotifyChannel', () => {
    test('resolves and returns TextChannel when configured', async () => {
      const mockLinks = [
        {
          id: 'link-1',
          enabled: true,
          mainGuildId: 'main-1',
          staffGuildId: 'staff-1',
          modlogMirrorChannelId: 'channel-modlog',
          roleMappings: [],
        },
      ];
      mockDb.staffServerLink.findMany.mockResolvedValue(mockLinks);

      const mockChannel = Object.create(TextChannel.prototype);
      Object.assign(mockChannel, {
        id: 'channel-modlog',
        guildId: 'staff-1',
      });

      const mockClient = {
        channels: {
          fetch: mock(() => Promise.resolve(mockChannel)),
        },
      } as unknown as Client;

      const res = await getStaffServerNotifyChannel(mockClient, 'main-1', 'modlog');
      expect(res).toBe(mockChannel);
      expect(mockClient.channels.fetch).toHaveBeenCalledWith('channel-modlog');
    });

    test('returns null if resolved channel has mismatched guild ID', async () => {
      const mockLinks = [
        {
          id: 'link-1',
          enabled: true,
          mainGuildId: 'main-1',
          staffGuildId: 'staff-1',
          modlogMirrorChannelId: 'channel-modlog',
          roleMappings: [],
        },
      ];
      mockDb.staffServerLink.findMany.mockResolvedValue(mockLinks);

      const mockChannel = Object.create(TextChannel.prototype);
      Object.assign(mockChannel, {
        id: 'channel-modlog',
        guildId: 'wrong-guild',
      });

      const mockClient = {
        channels: {
          fetch: mock(() => Promise.resolve(mockChannel)),
        },
      } as unknown as Client;

      const res = await getStaffServerNotifyChannel(mockClient, 'main-1', 'modlog');
      expect(res).toBeNull();
    });
  });
});

import { describe, expect, test, mock } from 'bun:test';
import {
  recordMemberIdentityChange,
  compareAndRecordIdentityChanges,
  getMemberIdentityHistory,
} from '../../services/moderation/memberHistoryService.js';
import prisma from '../../utils/db.js';

describe('memberHistoryService', () => {
  test('ne crée pas d\'entrée si l\'ancienne et la nouvelle valeur sont identiques', async () => {
    let created = false;
    const origCreate = prisma.memberProfileHistory.create;
    // @ts-expect-error test mock
    prisma.memberProfileHistory.create = async () => {
      created = true;
      return {} as any;
    };

    try {
      await recordMemberIdentityChange('guild-1', 'user-1', 'username', 'alice', 'alice');
      expect(created).toBe(false);

      await recordMemberIdentityChange('guild-1', 'user-1', 'username', null, null);
      expect(created).toBe(false);

      await recordMemberIdentityChange('guild-1', 'user-1', 'username', '   ', '');
      expect(created).toBe(false);
    } finally {
      prisma.memberProfileHistory.create = origCreate;
    }
  });

  test('détecte et enregistre les divergences sur les 6 attributs d\'identité', async () => {
    const recorded: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
    const origCreate = prisma.memberProfileHistory.create;
    const origFindFirst = prisma.memberProfileHistory.findFirst;

    // @ts-expect-error test mock
    prisma.memberProfileHistory.findFirst = async () => null;
    // @ts-expect-error test mock
    prisma.memberProfileHistory.create = async ({ data }: any) => {
      recorded.push({ field: data.field, oldValue: data.oldValue, newValue: data.newValue });
      return {} as any;
    };

    try {
      await compareAndRecordIdentityChanges(
        'guild-1',
        'user-1',
        {
          username: 'old_username',
          displayName: 'Old Nick',
          avatarUrl: 'https://cdn.discordapp.com/avatars/1.png',
          bio: 'Ancienne description',
          primaryGuildTag: 'OLDTAG',
          pronouns: 'il/lui',
        },
        {
          username: 'new_username',
          displayName: 'New Nick',
          avatarUrl: 'https://cdn.discordapp.com/avatars/2.png',
          bio: 'Nouvelle description',
          primaryGuildTag: 'NEWTAG',
          pronouns: 'iel',
        },
      );

      expect(recorded.length).toBe(6);
      expect(recorded.find((r) => r.field === 'username')).toEqual({
        field: 'username',
        oldValue: 'old_username',
        newValue: 'new_username',
      });
      expect(recorded.find((r) => r.field === 'displayName')).toEqual({
        field: 'displayName',
        oldValue: 'Old Nick',
        newValue: 'New Nick',
      });
      expect(recorded.find((r) => r.field === 'avatar')).toEqual({
        field: 'avatar',
        oldValue: 'https://cdn.discordapp.com/avatars/1.png',
        newValue: 'https://cdn.discordapp.com/avatars/2.png',
      });
      expect(recorded.find((r) => r.field === 'bio')).toEqual({
        field: 'bio',
        oldValue: 'Ancienne description',
        newValue: 'Nouvelle description',
      });
      expect(recorded.find((r) => r.field === 'tag')).toEqual({
        field: 'tag',
        oldValue: 'OLDTAG',
        newValue: 'NEWTAG',
      });
      expect(recorded.find((r) => r.field === 'pronouns')).toEqual({
        field: 'pronouns',
        oldValue: 'il/lui',
        newValue: 'iel',
      });
    } finally {
      prisma.memberProfileHistory.create = origCreate;
      prisma.memberProfileHistory.findFirst = origFindFirst;
    }
  });

  test('ignore les champs dont la valeur n\'a pas changé', async () => {
    const recorded: Array<{ field: string }> = [];
    const origCreate = prisma.memberProfileHistory.create;
    const origFindFirst = prisma.memberProfileHistory.findFirst;

    // @ts-expect-error test mock
    prisma.memberProfileHistory.findFirst = async () => null;
    // @ts-expect-error test mock
    prisma.memberProfileHistory.create = async ({ data }: any) => {
      recorded.push({ field: data.field });
      return {} as any;
    };

    try {
      await compareAndRecordIdentityChanges(
        'guild-1',
        'user-1',
        {
          username: 'same_username',
          displayName: 'Old Nick',
          avatarUrl: 'same_avatar',
        },
        {
          username: 'same_username',
          displayName: 'New Nick',
          avatarUrl: 'same_avatar',
        },
      );

      expect(recorded.length).toBe(1);
      expect(recorded[0].field).toBe('displayName');
    } finally {
      prisma.memberProfileHistory.create = origCreate;
      prisma.memberProfileHistory.findFirst = origFindFirst;
    }
  });

  test('getMemberIdentityHistory formate correctement les dates en ISO', async () => {
    const origFindMany = prisma.memberProfileHistory.findMany;
    const now = new Date('2026-11-18T12:00:00.000Z');

    // @ts-expect-error test mock
    prisma.memberProfileHistory.findMany = async () => [
      {
        id: 'hist-1',
        guildId: 'guild-1',
        userId: 'user-1',
        field: 'username',
        oldValue: 'bob',
        newValue: 'robert',
        recordedAt: now,
      },
    ];

    try {
      const history = await getMemberIdentityHistory('guild-1', 'user-1');
      expect(history).toEqual([
        {
          id: 'hist-1',
          field: 'username',
          oldValue: 'bob',
          newValue: 'robert',
          recordedAt: '2026-11-18T12:00:00.000Z',
        },
      ]);
    } finally {
      prisma.memberProfileHistory.findMany = origFindMany;
    }
  });
});


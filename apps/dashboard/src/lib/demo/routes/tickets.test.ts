import { describe, expect, test } from 'bun:test';
import { toInboxRow } from './tickets';

const message = (isStaff: boolean, createdAt: string) => ({
  id: createdAt, authorId: 'a', authorName: 'a', authorAvatar: null, isStaff, content: '', htmlContent: '', createdAt,
});

const ticket = (status: string, messages: ReturnType<typeof message>[]) => ({
  id: 't', guildId: 'g', channelId: 'c', channelName: 'ticket', userId: 'u', userTag: 'yanis', userName: 'Yanis',
  userAvatar: null, status, claimedById: null, claimedBy: null, claimedByAvatar: null, subject: 'Spam en MP',
  createdAt: '2026-11-01T10:00:00Z', closedAt: null, type: 'report', priority: 'HIGH', messages,
});

describe('toInboxRow', () => {
  const types = [{ id: 'report', label: 'Signalement' }];

  test('donne au centre de support les champs qu’il lit, sla compris', () => {
    const row = toInboxRow(ticket('OPEN', [message(false, '1'), message(true, '2'), message(false, '3')]), types);
    expect(row.sla).toEqual({ firstResponse: null, resolution: null, worst: null });
    expect(row.tags).toEqual([]);
    expect(row).toMatchObject({
      username: 'Yanis', reason: 'Spam en MP', ticketTypeLabel: 'Signalement',
      firstResponseAt: '2', lastMemberMessageAt: '3', lastStaffMessageAt: '2', waitingOn: 'staff',
    });
  });

  test('un ticket fermé n’attend personne', () => {
    expect(toInboxRow(ticket('CLOSED', [message(false, '1')]), types).waitingOn).toBeNull();
    expect(toInboxRow(ticket('OPEN', [message(true, '1')]), types).waitingOn).toBe('member');
  });
});

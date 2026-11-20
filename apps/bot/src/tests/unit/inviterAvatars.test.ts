/**
 * inviterAvatars.test.ts
 *
 * Le classement « Meilleurs inviteurs » du dashboard affichait une initiale a
 * la place de la photo : la route `/invitations` renvoyait `inviterUsage` sans
 * avatar. On verrouille la fusion usage + identites.
 */

import { describe, expect, test } from 'bun:test';
import { attachInviterAvatars } from '../../services/analytics/inviterAvatars.js';

const usage = (inviterId: string | null) => ({
  inviterId,
  inviterTag: 'tag',
  _count: { _all: 1, leftAt: 0 },
  _max: { joinedAt: null },
});

describe('attachInviterAvatars', () => {
  test("pose l'avatar connu de chaque inviteur", () => {
    const identities = new Map([['42', { avatarUrl: 'https://cdn/a.png' }]]);
    const [entry] = attachInviterAvatars([usage('42')], identities);
    expect(entry.avatarUrl).toBe('https://cdn/a.png');
    expect(entry._count._all).toBe(1);
  });

  test('renvoie null sans identite ni inviteur', () => {
    const result = attachInviterAvatars([usage('7'), usage(null)], new Map());
    expect(result.map((entry) => entry.avatarUrl)).toEqual([null, null]);
  });
});

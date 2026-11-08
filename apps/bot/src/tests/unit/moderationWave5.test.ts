import { beforeEach, describe, expect, test } from 'bun:test';
import { GuildMemberFlags } from 'discord.js';
import { isMemberDiscordQuarantined } from '../../services/moderation/jailService.js';
import { notePreventiveActivity, resetGroupSpam } from '../../services/moderation/groupSpamSlowmode.js';

describe('isMemberDiscordQuarantined', () => {
  test('détecte les drapeaux de quarantaine AutoMod Discord', () => {
    const clean = { flags: { has: () => false } } as never;
    expect(isMemberDiscordQuarantined(clean)).toEqual({ quarantined: false, reasons: [] });

    const nickAndBio = {
      flags: {
        has: (flag: number) =>
          flag === GuildMemberFlags.AutomodQuarantinedUsernameOrGuildNickname ||
          flag === GuildMemberFlags.AutomodQuarantinedBio,
      },
    } as never;
    expect(isMemberDiscordQuarantined(nickAndBio)).toEqual({
      quarantined: true,
      reasons: ['pseudo ou surnom', 'biographie'],
    });
  });
});

describe('notePreventiveActivity', () => {
  beforeEach(() => resetGroupSpam());

  test('compte les messages et les auteurs distincts dans la fenêtre glissante', () => {
    const t0 = 1_000_000;
    notePreventiveActivity('chan1', 'u1', 10, t0);
    notePreventiveActivity('chan1', 'u2', 10, t0 + 1000);
    const r1 = notePreventiveActivity('chan1', 'u1', 10, t0 + 2000);
    expect(r1).toEqual({ messageCount: 3, distinctUsers: 2, userIds: ['u1', 'u2'] });

    // Après 10,5 s, le premier message de u1 expire mais ceux à +1 s et +2 s restent.
    const r2 = notePreventiveActivity('chan1', 'u3', 10, t0 + 10_500);
    expect(r2).toEqual({ messageCount: 3, distinctUsers: 3, userIds: ['u2', 'u1', 'u3'] });
  });
});

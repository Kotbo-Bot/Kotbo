import { describe, expect, test } from 'bun:test';
import { GuildMemberFlags, UserFlags } from 'discord.js';
import type { GuildMember } from 'discord.js';
import type { RaidProtectionConfig } from '@prisma/client';
import { assessArrival, decideCaptcha } from '../../services/moderation/captchaTrigger.js';

const DAY = 24 * 60 * 60 * 1000;

function fakeMember(opts: { ageDays: number; avatar?: boolean; username?: string; globalName?: string | null; spammer?: boolean; quarantined?: boolean; id?: string }): GuildMember {
  return {
    id: opts.id ?? '111111111111111111',
    user: {
      createdTimestamp: Date.now() - opts.ageDays * DAY,
      avatar: opts.avatar === false ? null : 'abc',
      username: opts.username ?? 'camille',
      globalName: opts.globalName === undefined ? 'Camille' : opts.globalName,
      flags: { has: (flag: number) => Boolean(opts.spammer) && flag === UserFlags.Spammer },
    },
    flags: { has: (flag: number) => Boolean(opts.quarantined) && flag === GuildMemberFlags.AutomodQuarantinedUsernameOrGuildNickname },
  } as unknown as GuildMember;
}

function config(patch: Partial<RaidProtectionConfig> = {}): RaidProtectionConfig {
  return {
    captchaEnabled: true,
    captchaChannelId: '222222222222222222',
    captchaUnverifiedRoleId: '333333333333333333',
    captchaTrigger: 'ALWAYS',
    raidModeActive: false,
    antiRaidAction: 'LOCK',
    shieldLevel: 5,
    accountAgeWhitelist: [],
    ...patch,
  } as RaidProtectionConfig;
}

describe('assessArrival', () => {
  test('un compte ancien avec avatar et nom ordinaire n\'est pas suspect', () => {
    expect(assessArrival(fakeMember({ ageDays: 400 })).suspicious).toBe(false);
  });

  test('un compte du jour, sans avatar, au pseudo généré est suspect', () => {
    const result = assessArrival(fakeMember({ ageDays: 0.2, avatar: false, username: 'user83920174', globalName: null }));
    expect(result.suspicious).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(2);
  });

  test('un compte signalé spammeur par Discord est suspect même s\'il est ancien', () => {
    expect(assessArrival(fakeMember({ ageDays: 900, spammer: true })).suspicious).toBe(true);
  });
});

describe('decideCaptcha', () => {
  test('permanent : tout le monde passe le captcha', () => {
    expect(decideCaptcha(fakeMember({ ageDays: 400 }), config()).challenge).toBe(true);
  });

  test('automatique : personne hors raid, tout le monde pendant un raid', () => {
    expect(decideCaptcha(fakeMember({ ageDays: 400 }), config({ captchaTrigger: 'AUTO' })).challenge).toBe(false);
    expect(decideCaptcha(fakeMember({ ageDays: 400 }), config({ captchaTrigger: 'AUTO', raidModeActive: true })).challenge).toBe(true);
  });

  test('intelligent : seulement les profils suspects hors raid, sauf approbation de l\'équipe', () => {
    const suspect = fakeMember({ ageDays: 0.1, avatar: false, username: 'xkqzvbtrm', globalName: null });
    expect(decideCaptcha(fakeMember({ ageDays: 400 }), config({ captchaTrigger: 'SMART' })).challenge).toBe(false);
    expect(decideCaptcha(suspect, config({ captchaTrigger: 'SMART' })).challenge).toBe(true);
    expect(decideCaptcha(suspect, config({ captchaTrigger: 'SMART', accountAgeWhitelist: [suspect.id] })).challenge).toBe(false);
  });

  test('Shield 3 impose le captcha à tous, même désactivé ou automatique', () => {
    const decision = decideCaptcha(fakeMember({ ageDays: 400 }), config({ captchaEnabled: false, captchaTrigger: 'AUTO', shieldLevel: 3 }));
    expect(decision).toMatchObject({ challenge: true, frozen: false });
  });

  test('Shield 2 et 1 gèlent le captcha', () => {
    expect(decideCaptcha(fakeMember({ ageDays: 400 }), config({ shieldLevel: 2 }))).toMatchObject({ challenge: true, frozen: true });
    expect(decideCaptcha(fakeMember({ ageDays: 400 }), config({ shieldLevel: 1 })).frozen).toBe(true);
  });

  test('sans salon ni rôle de captcha, Shield n\'impose rien', () => {
    expect(decideCaptcha(fakeMember({ ageDays: 400 }), config({ captchaEnabled: false, captchaChannelId: null, shieldLevel: 2 })).challenge).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  decideTag,
  isImpersonatingTag,
  renderTagMessage,
  ruleMatches,
  tagSkeleton,
  waveThreshold,
  type ConfigLike,
  type RuleLike,
} from '../../services/moderation/tagAutomod/tagRules.js';

const OWN = '100';

function rule(over: Partial<RuleLike>): RuleLike {
  return {
    id: 'r', name: 'r', enabled: true, effect: 'BLOCK', targetType: 'SERVER', targetGuildId: null, pattern: null,
    matchMode: 'EXACT', action: 'ALERT', durationMin: null, roleId: null, message: null, escalateAfterMin: null,
    escalateAction: null, escalateDurationMin: null, expiresAt: null, ...over,
  };
}

const OFF: ConfigLike = {
  allowlistOnly: false, allowlistAction: 'ALERT', allowlistDurationMin: null,
  sharedListEnabled: false, sharedListAction: 'ALERT', sharedListDurationMin: null,
  newAccountEnabled: false, newAccountDays: 7, newAccountScope: 'UNKNOWN', newAccountAction: 'ALERT', newAccountDurationMin: null,
  impersonationEnabled: false, impersonationAction: 'ALERT', impersonationDurationMin: null,
};

const ctx = (guildId: string, tag: string, over: Partial<Parameters<typeof decideTag>[2]> = {}) => ({
  tag: { guildId, tag }, trigger: 'JOIN' as const, ownGuildId: OWN, ownTag: 'KTBO', accountAgeDays: 400, sharedFlagged: false, ...over,
});

describe('tagRules', () => {
  test('squelette : homoglyphes, chiffres et accents ramenés au latin', () => {
    expect(tagSkeleton('KΤB0')).toBe(tagSkeleton('ktbo'));
    expect(tagSkeleton('Ràid')).toBe('rald');
  });

  test('imitation du tag du serveur, jamais le vrai tag', () => {
    expect(isImpersonatingTag({ guildId: '200', tag: 'KT8O' }, OWN, 'KTBO')).toBe(true);
    expect(isImpersonatingTag({ guildId: OWN, tag: 'KTBO' }, OWN, 'KTBO')).toBe(false);
    expect(isImpersonatingTag({ guildId: '200', tag: 'RAID' }, OWN, 'KTBO')).toBe(false);
  });

  test('règles serveur, texte, regex et expiration', () => {
    const now = Date.now();
    expect(ruleMatches(rule({ targetGuildId: '200' }), { guildId: '200', tag: 'X' })).toBe(true);
    expect(ruleMatches(rule({ targetType: 'TEXT', pattern: 'raid' }), { guildId: '9', tag: 'RA1D' })).toBe(true);
    expect(ruleMatches(rule({ targetType: 'TEXT', pattern: 'ai', matchMode: 'CONTAINS' }), { guildId: '9', tag: 'RAID' })).toBe(true);
    expect(ruleMatches(rule({ targetType: 'TEXT', pattern: '^R.+D$', matchMode: 'REGEX' }), { guildId: '9', tag: 'RAID' })).toBe(true);
    expect(ruleMatches(rule({ targetType: 'TEXT', pattern: '(', matchMode: 'REGEX' }), { guildId: '9', tag: 'RAID' })).toBe(false);
    expect(ruleMatches(rule({ targetGuildId: '200', expiresAt: new Date(now - 1) }), { guildId: '200', tag: 'X' }, now)).toBe(false);
  });

  test('la réponse la plus forte gagne, une règle « autoriser » écarte tout', () => {
    const rules = [rule({ targetGuildId: '200', action: 'TICKET' }), rule({ targetType: 'TEXT', pattern: 'RAID', action: 'BAN' })];
    expect(decideTag(OFF, rules, ctx('200', 'RAID'))?.action).toBe('BAN');
    const allow = [...rules, rule({ effect: 'ALLOW', targetGuildId: '200' })];
    expect(decideTag({ ...OFF, allowlistOnly: true }, allow, ctx('200', 'RAID'))).toBeNull();
    expect(decideTag(OFF, rules, ctx(OWN, 'RAID'))).toBeNull();
  });

  test('détections : liste blanche, compte récent, liste partagée, imitation', () => {
    expect(decideTag({ ...OFF, allowlistOnly: true, allowlistAction: 'JAIL' }, [], ctx('300', 'ABC'))?.trigger).toBe('ALLOWLIST');
    expect(decideTag({ ...OFF, newAccountEnabled: true }, [], ctx('300', 'ABC', { accountAgeDays: 2 }))?.trigger).toBe('NEW_ACCOUNT');
    expect(decideTag({ ...OFF, newAccountEnabled: true }, [], ctx('300', 'ABC'))).toBeNull();
    const allowed = [rule({ effect: 'ALLOW', targetGuildId: '300' })];
    expect(decideTag({ ...OFF, newAccountEnabled: true }, allowed, ctx('300', 'ABC', { accountAgeDays: 2 }))).toBeNull();
    expect(decideTag({ ...OFF, newAccountEnabled: true, newAccountScope: 'ANY' }, allowed, ctx('300', 'ABC', { accountAgeDays: 2 }))?.trigger).toBe('NEW_ACCOUNT');
    expect(decideTag({ ...OFF, sharedListEnabled: true, sharedListAction: 'KICK' }, [], ctx('300', 'ABC', { sharedFlagged: true }))?.action).toBe('KICK');
    expect(decideTag({ ...OFF, impersonationEnabled: true }, [], ctx('300', 'KTB0'))?.trigger).toBe('IMPERSONATION');
  });

  test('seuil de vague fixe et adaptatif', () => {
    const base = { waveMode: 'ADAPTIVE', wavePreset: 'NORMAL', waveThreshold: 5, waveWindowSec: 120 };
    expect(waveThreshold(base, 10)).toEqual({ threshold: 5, windowSec: 120 });
    expect(waveThreshold(base, 14_400).threshold).toBe(62);
    expect(waveThreshold({ ...base, waveMode: 'FIXED', waveThreshold: 1, waveWindowSec: 5 })).toEqual({ threshold: 2, windowSec: 10 });
  });

  test('variables du message', () => {
    expect(renderTagMessage('{user} {tag} {server} {delay}', { user: 'a', tag: 'b', server: 'c', delay: 'd' })).toBe('a b c d');
  });
});

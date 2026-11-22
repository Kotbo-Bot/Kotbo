import { describe, expect, test } from 'bun:test';
import {
  evaluateConditions,
  normalizeConditions,
  periodStartKey,
  type ConditionResolvers,
  type ConditionSubject,
  type GiveawayCondition,
} from '../../services/features/giveawayConditions';

const ROLE_A = '100000000000000001';
const ROLE_B = '100000000000000002';
const days = (n: number) => new Date(Date.now() - n * 86_400_000);

const subject = (over: Partial<ConditionSubject> = {}): ConditionSubject => ({
  userId: '1',
  guildId: '2',
  roleIds: [],
  accountCreatedAt: days(100),
  joinedAt: days(10),
  isBooster: false,
  hasAvatar: true,
  hasBanner: false,
  hasServerTag: false,
  nickname: 'Kot | Alice',
  customStatus: undefined,
  startedAt: days(1),
  ...over,
});

const resolvers = (over: Partial<ConditionResolvers> = {}): ConditionResolvers => ({
  periodStat: async () => 0,
  flatStat: async () => 0,
  hasVotedTopgg: async () => false,
  isInGuild: async () => false,
  ...over,
});

const run = (conditions: GiveawayCondition[], s = subject(), r = resolvers()) =>
  evaluateConditions(conditions, s, r);

describe('evaluateConditions', () => {
  test('sans condition, tout le monde passe', async () => {
    expect((await run([])).allowed).toBe(true);
  });

  test('toutes les conditions sont obligatoires et tous les manquements sont rendus', async () => {
    const result = await run([
      { type: 'roles_all', roleIds: [ROLE_A] },
      { type: 'booster', mode: 'required' },
      { type: 'banner' },
    ]);
    expect(result.allowed).toBe(false);
    expect(result.failures.map((f) => f.condition.type)).toEqual(['roles_all', 'booster', 'banner']);
  });

  test('roles_all exige tous les rôles, roles_any un seul, roles_none aucun', async () => {
    const s = subject({ roleIds: [ROLE_A] });
    expect((await run([{ type: 'roles_all', roleIds: [ROLE_A, ROLE_B] }], s)).allowed).toBe(false);
    expect((await run([{ type: 'roles_any', roleIds: [ROLE_A, ROLE_B] }], s)).allowed).toBe(true);
    expect((await run([{ type: 'roles_none', roleIds: [ROLE_A] }], s)).allowed).toBe(false);
  });

  test('un groupe est satisfait par une seule de ses conditions', async () => {
    const group: GiveawayCondition[] = [
      { type: 'roles_any', roleIds: [ROLE_B], group: 'g' },
      { type: 'messages', min: 500, period: 'total', group: 'g' },
    ];
    const enough = resolvers({ periodStat: async () => 800 });
    expect((await run(group, subject(), enough)).allowed).toBe(true);
    expect((await run(group, subject({ roleIds: [ROLE_B] }))).allowed).toBe(true);
  });

  test('un groupe entier échoue avec toutes ses conditions, marquées du groupe', async () => {
    const result = await run([
      { type: 'roles_any', roleIds: [ROLE_B], group: 'g' },
      { type: 'messages', min: 500, period: 'total', group: 'g' },
      { type: 'avatar' },
    ]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((f) => f.group === 'g')).toBe(true);
  });

  test('une donnée inconnue laisse passer, jamais l\'inverse', async () => {
    const result = await run(
      [{ type: 'account_age', days: 30 }, { type: 'booster', mode: 'required' }, { type: 'topgg_vote' }, { type: 'level', min: 5 }],
      subject({ accountCreatedAt: null, isBooster: null }),
      resolvers({ hasVotedTopgg: async () => null, flatStat: async () => null }),
    );
    expect(result.allowed).toBe(true);
  });

  test('le statut n\'est pas vérifié sans l\'intent Presences', async () => {
    const c: GiveawayCondition[] = [{ type: 'status_contains', text: 'kotbo' }];
    expect((await run(c, subject({ customStatus: undefined }))).allowed).toBe(true);
    expect((await run(c, subject({ customStatus: 'Vive Kotbo' }))).allowed).toBe(true);
    expect((await run(c, subject({ customStatus: 'rien' }))).allowed).toBe(false);
  });

  test('ancienneté, pseudo et compteurs', async () => {
    expect((await run([{ type: 'member_age', days: 30 }])).allowed).toBe(false);
    expect((await run([{ type: 'account_age', days: 30 }])).allowed).toBe(true);
    expect((await run([{ type: 'nickname_contains', text: 'KOT' }])).allowed).toBe(true);
    const r = resolvers({ flatStat: async (stat) => (stat === 'invites' ? 3 : 0) });
    expect((await run([{ type: 'invites', min: 3 }], subject(), r)).allowed).toBe(true);
    expect((await run([{ type: 'coins', min: 1 }], subject(), r)).allowed).toBe(false);
  });

  test('la période et le lancement sont transmis au compteur', async () => {
    const seen: unknown[] = [];
    const s = subject();
    await run([{ type: 'voice_minutes', min: 10, period: 'since_start' }], s, resolvers({
      periodStat: async (stat, period, since) => { seen.push(stat, period, since); return 0; },
    }));
    expect(seen).toEqual(['voice_minutes', 'since_start', s.startedAt]);
  });

  test('booster exclu : un booster est refusé', async () => {
    const c: GiveawayCondition[] = [{ type: 'booster', mode: 'excluded' }];
    expect((await run(c, subject({ isBooster: true }))).allowed).toBe(false);
    expect((await run(c, subject({ isBooster: false }))).allowed).toBe(true);
  });
});

describe('periodStartKey', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  test('total n\'a pas de borne', () => expect(periodStartKey('total', now, now)).toBeNull());
  test('7 et 30 jours glissants', () => {
    expect(periodStartKey('7d', now, now)).toBe('2026-11-15');
    expect(periodStartKey('30d', now, now)).toBe('2026-10-23');
  });
  test('depuis le lancement', () => {
    expect(periodStartKey('since_start', new Date('2026-11-20T08:00:00Z'), now)).toBe('2026-11-20');
  });
});

describe('normalizeConditions', () => {
  test('écarte les conditions invalides et compte les rejets', () => {
    const { conditions, rejected } = normalizeConditions([
      { type: 'roles_any', roleIds: [ROLE_A, 'pas-un-id'] },
      { type: 'messages', min: 0, period: 'total' },
      { type: 'messages', min: 10, period: 'hier' },
      { type: 'inconnu' },
      { type: 'booster', mode: 'required', group: 'g' },
      'texte',
    ]);
    expect(conditions).toEqual([
      { type: 'roles_any', roleIds: [ROLE_A] },
      { type: 'booster', mode: 'required', group: 'g' },
    ]);
    expect(rejected).toBe(4);
  });

  test('plafonne le nombre de conditions et le texte', () => {
    const many = Array.from({ length: 30 }, () => ({ type: 'avatar' }));
    expect(normalizeConditions(many).conditions).toHaveLength(15);
    expect(normalizeConditions([{ type: 'nickname_contains', text: 'x'.repeat(65) }]).conditions).toEqual([]);
  });

  test('une valeur non tableau donne une liste vide', () => {
    expect(normalizeConditions(undefined)).toEqual({ conditions: [], rejected: 0 });
    expect(normalizeConditions({})).toEqual({ conditions: [], rejected: 1 });
  });
});

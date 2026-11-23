import { describe, expect, test } from 'bun:test';
import {
  conditionsFromServerFilter,
  conditionsPayload,
  defaultCondition,
  isConditionComplete,
} from './giveawayConditions';

describe('conditions de giveaway (dashboard)', () => {
  test('une condition de rôles vide est incomplète, un booster est toujours complet', () => {
    expect(isConditionComplete(defaultCondition('roles_any'))).toBe(false);
    expect(isConditionComplete({ type: 'roles_any', roleIds: ['1'] })).toBe(true);
    expect(isConditionComplete(defaultCondition('booster'))).toBe(true);
    expect(isConditionComplete(defaultCondition('in_guild'))).toBe(false);
    expect(isConditionComplete({ type: 'in_guild', guildId: '123456789012345678' })).toBe(true);
  });

  test('la charge utile écarte les incomplètes et ne garde que les champs du type', () => {
    const payload = conditionsPayload([
      { type: 'messages', min: 50, period: '7d', text: 'parasite', days: 3, group: ' a ' },
      { type: 'nickname_contains', text: '  ' },
      { type: 'avatar', group: '' },
    ]);
    expect(payload).toEqual([
      { type: 'messages', min: 50, period: '7d', group: 'a' },
      { type: 'avatar' },
    ]);
  });

  test('le filtre du serveur devient des conditions de départ', () => {
    expect(conditionsFromServerFilter({ requiredRoleIds: ['1'], minLevel: 5, minAccountAgeDays: 0 })).toEqual([
      { type: 'roles_any', roleIds: ['1'] },
      { type: 'level', min: 5 },
    ]);
    expect(conditionsFromServerFilter({})).toEqual([]);
  });
});

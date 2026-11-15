import { describe, expect, test } from 'bun:test';
import {
  SEASON_DURATION_DAYS,
  SEASON_NAME_MAX,
  SEASON_REWARDS_MAX,
  SEASON_REWARD_COINS,
  planSeasonRewards,
  readStoredSeasonRewards,
  seasonProgress,
  validateSeasonRewards,
  validateSeasonSchedule,
} from '@kotbo/shared';

const ROLE = '123456789012345678';
const OTHER_ROLE = '223456789012345678';
const DAY_MS = 86_400_000;

describe('validateSeasonRewards', () => {
  test('rend les récompenses triées par rang, rôle absent normalisé à null', () => {
    const result = validateSeasonRewards([
      { rank: 3, coins: 100 },
      { rank: 1, roleId: ROLE, coins: 0 },
    ]);
    expect(result).toEqual({
      rewards: [
        { rank: 1, roleId: ROLE, coins: 0 },
        { rank: 3, roleId: null, coins: 100 },
      ],
    });
  });

  test('refuse autre chose qu\'une liste', () => {
    expect(validateSeasonRewards({ rank: 1 })).toEqual({ error: 'NOT_ARRAY' });
  });

  test('refuse plus de récompenses que la limite', () => {
    const many = Array.from({ length: SEASON_REWARDS_MAX + 1 }, (_, i) => ({ rank: i + 1, coins: 1 }));
    expect(validateSeasonRewards(many)).toEqual({ error: 'TOO_MANY' });
  });

  test('refuse un rang qui n\'est pas un entier positif', () => {
    expect(validateSeasonRewards([{ rank: 0, coins: 1 }])).toEqual({ error: 'BAD_RANK' });
    expect(validateSeasonRewards([{ rank: 1.5, coins: 1 }])).toEqual({ error: 'BAD_RANK' });
  });

  test('refuse un rôle qui n\'est pas un identifiant Discord', () => {
    expect(validateSeasonRewards([{ rank: 1, roleId: 'admin' }])).toEqual({ error: 'BAD_ROLE' });
  });

  test('refuse des pièces hors bornes', () => {
    expect(validateSeasonRewards([{ rank: 1, coins: -1 }])).toEqual({ error: 'BAD_COINS' });
    expect(validateSeasonRewards([{ rank: 1, coins: SEASON_REWARD_COINS.max + 1 }])).toEqual({ error: 'BAD_COINS' });
  });

  test('refuse une récompense qui ne donne rien', () => {
    expect(validateSeasonRewards([{ rank: 1, roleId: '', coins: 0 }])).toEqual({ error: 'EMPTY_REWARD' });
  });

  test('refuse deux récompenses pour le même rang', () => {
    expect(validateSeasonRewards([{ rank: 1, coins: 5 }, { rank: 1, roleId: ROLE }])).toEqual({ error: 'DUPLICATE_RANK' });
  });
});

describe('readStoredSeasonRewards', () => {
  test('relit les récompenses enregistrées par l\'ancienne version, champ badge compris', () => {
    expect(readStoredSeasonRewards([{ rank: 2, roleId: ROLE, badge: 'gold' }])).toEqual([{ rank: 2, roleId: ROLE, coins: 0 }]);
  });

  test('rend une liste vide pour un contenu absent ou illisible', () => {
    expect(readStoredSeasonRewards(null)).toEqual([]);
    expect(readStoredSeasonRewards('oops')).toEqual([]);
    expect(readStoredSeasonRewards([{ rank: 'one' }])).toEqual([]);
  });
});

describe('validateSeasonSchedule', () => {
  const now = new Date('2026-11-15T12:00:00Z');

  test('accepte une saison à venir et nettoie le nom', () => {
    const result = validateSeasonSchedule({ name: '  Hiver  ', startDate: '2026-12-01T00:00:00Z', endDate: '2027-01-01T00:00:00Z' }, now);
    expect(result).toEqual({
      schedule: { name: 'Hiver', startDate: new Date('2026-12-01T00:00:00Z'), endDate: new Date('2027-01-01T00:00:00Z') },
    });
  });

  test('accepte un début déjà passé : la saison s\'ouvre tout de suite', () => {
    const result = validateSeasonSchedule({ name: 'Hiver', startDate: '2026-11-01T00:00:00Z', endDate: '2026-12-01T00:00:00Z' }, now);
    expect('schedule' in result).toBe(true);
  });

  test('refuse un nom vide ou trop long', () => {
    expect(validateSeasonSchedule({ name: '   ', startDate: '2026-12-01', endDate: '2027-01-01' }, now)).toEqual({ error: 'BAD_NAME' });
    expect(validateSeasonSchedule({ name: 'x'.repeat(SEASON_NAME_MAX + 1), startDate: '2026-12-01', endDate: '2027-01-01' }, now)).toEqual({ error: 'BAD_NAME' });
  });

  test('refuse une date illisible', () => {
    expect(validateSeasonSchedule({ name: 'Hiver', startDate: 'demain', endDate: '2027-01-01' }, now)).toEqual({ error: 'BAD_DATE' });
  });

  test('refuse une fin avant le début', () => {
    expect(validateSeasonSchedule({ name: 'Hiver', startDate: '2027-01-01', endDate: '2026-12-01' }, now)).toEqual({ error: 'END_BEFORE_START' });
  });

  test('refuse une fin déjà passée', () => {
    expect(validateSeasonSchedule({ name: 'Hiver', startDate: '2026-10-01', endDate: '2026-11-01' }, now)).toEqual({ error: 'END_IN_PAST' });
  });

  test('refuse une saison plus courte ou plus longue que les bornes', () => {
    const start = new Date('2026-12-01T00:00:00Z');
    const tooShort = new Date(start.getTime() + (SEASON_DURATION_DAYS.min * DAY_MS) / 2);
    const tooLong = new Date(start.getTime() + (SEASON_DURATION_DAYS.max + 1) * DAY_MS);
    expect(validateSeasonSchedule({ name: 'Hiver', startDate: start.toISOString(), endDate: tooShort.toISOString() }, now)).toEqual({ error: 'BAD_DURATION' });
    expect(validateSeasonSchedule({ name: 'Hiver', startDate: start.toISOString(), endDate: tooLong.toISOString() }, now)).toEqual({ error: 'BAD_DURATION' });
  });
});

describe('planSeasonRewards', () => {
  const standings = [
    { userId: 'a', rank: 1 },
    { userId: 'b', rank: 2 },
  ];

  test('associe chaque récompense au membre classé à ce rang', () => {
    const plan = planSeasonRewards(
      [{ rank: 1, roleId: ROLE, coins: 500 }, { rank: 2, roleId: OTHER_ROLE, coins: 0 }],
      standings,
    );
    expect(plan).toEqual([
      { userId: 'a', rank: 1, roleId: ROLE, coins: 500 },
      { userId: 'b', rank: 2, roleId: OTHER_ROLE, coins: 0 },
    ]);
  });

  test('ignore un rang que personne n\'occupe', () => {
    expect(planSeasonRewards([{ rank: 5, roleId: null, coins: 10 }], standings)).toEqual([]);
  });

  test('ajoute le rôle du premier à ses récompenses', () => {
    expect(planSeasonRewards([], standings, ROLE)).toEqual([{ userId: 'a', rank: 1, roleId: ROLE, coins: 0 }]);
  });

  test('cumule le rôle du premier avec une récompense de rang 1 sans la perdre', () => {
    const plan = planSeasonRewards([{ rank: 1, roleId: OTHER_ROLE, coins: 50 }], standings, ROLE);
    expect(plan).toEqual([
      { userId: 'a', rank: 1, roleId: OTHER_ROLE, coins: 50 },
      { userId: 'a', rank: 1, roleId: ROLE, coins: 0 },
    ]);
  });

  test('ne double pas un rôle du premier déjà donné par la récompense de rang 1', () => {
    expect(planSeasonRewards([{ rank: 1, roleId: ROLE, coins: 50 }], standings, ROLE)).toEqual([
      { userId: 'a', rank: 1, roleId: ROLE, coins: 50 },
    ]);
  });
});

describe('seasonProgress', () => {
  const start = new Date('2026-11-01T00:00:00Z');
  const end = new Date('2026-11-11T00:00:00Z');

  test('rend l\'avancement et les jours restants', () => {
    expect(seasonProgress(start, end, new Date('2026-11-06T00:00:00Z'))).toEqual({ percent: 50, daysLeft: 5 });
  });

  test('borne l\'avancement entre 0 et 100', () => {
    expect(seasonProgress(start, end, new Date('2026-10-01T00:00:00Z'))).toEqual({ percent: 0, daysLeft: 41 });
    expect(seasonProgress(start, end, new Date('2026-12-01T00:00:00Z'))).toEqual({ percent: 100, daysLeft: 0 });
  });

  test('compte un jour entamé comme un jour restant', () => {
    expect(seasonProgress(start, end, new Date('2026-11-10T20:00:00Z')).daysLeft).toBe(1);
  });
});

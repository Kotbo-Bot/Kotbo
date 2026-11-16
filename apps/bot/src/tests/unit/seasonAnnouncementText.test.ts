import { describe, expect, test } from 'bun:test';
import {
  fillSeasonTemplate,
  planSeasonRewards,
  sampleSeasonStandings,
  seasonEndAnnouncement,
  seasonReminderAnnouncement,
  seasonStartAnnouncement,
  type SeasonAnnouncementLabels,
} from '@kotbo/shared';

const LABELS: SeasonAnnouncementLabels = {
  locale: 'fr',
  startTitle: 'Saison #{number} · {name}',
  startBody: 'Jusqu’au {date}.',
  rewardsHeading: 'Récompenses',
  topRoleLine: 'Premier · {role}',
  rewardCoins: '{coins} pièces',
  endTitle: 'Fin #{number} · {name}',
  endLine: '#{rank} {user} +{xp}',
  endEmpty: 'Personne.',
  rewardsGivenHeading: 'Données',
  reminderTitle: 'Dernier jour #{number} · {name}',
  reminderBody: 'Clôture le {date}.',
};

describe('fillSeasonTemplate', () => {
  test('remplit les trous connus et laisse les autres', () => {
    expect(fillSeasonTemplate('{a} et {b}', { a: 1 })).toBe('1 et {b}');
  });
});

describe('seasonStartAnnouncement', () => {
  test('titre, date et récompenses combinées rôle + pièces', () => {
    const text = seasonStartAnnouncement(LABELS, { number: 2, name: 'Hiver', date: '1 déc.' }, [{ rank: 1, role: '@Or', coins: '500' }], '@Champion');
    expect(text.title).toBe('Saison #2 · Hiver');
    expect(text.description.split('\n')).toEqual(['Jusqu’au 1 déc..', '', '**Récompenses**', 'Premier · @Champion', '#1 · @Or + 500 pièces']);
  });

  test('sans récompense, une seule ligne', () => {
    expect(seasonStartAnnouncement(LABELS, { number: 1, name: 'A', date: 'x' }, [], null).description).toBe('Jusqu’au x.');
  });
});

describe('seasonEndAnnouncement', () => {
  const standings = [1, 2, 3, 4].map((rank) => ({ rank, user: `u${rank}`, xp: String(1000 - rank) }));

  test('podium limité à trois puis récompenses données', () => {
    const text = seasonEndAnnouncement(LABELS, { number: 2, name: 'Hiver' }, standings, [{ user: 'u1', role: null, coins: '50' }]);
    expect(text.description.split('\n')).toEqual(['#1 u1 +999', '#2 u2 +998', '#3 u3 +997', '', '**Données**', 'u1 · 50 pièces']);
  });

  test('saison sans classé : message dédié', () => {
    expect(seasonEndAnnouncement(LABELS, { number: 2, name: 'Hiver' }, [], []).description).toBe('Personne.');
  });
});

describe('sampleSeasonStandings', () => {
  test('sans récompense, le podium seul', () => {
    expect(sampleSeasonStandings([]).map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  test('prolongé jusqu\'au dernier rang récompensé, XP décroissante', () => {
    const sample = sampleSeasonStandings([{ rank: 1 }, { rank: 7 }]);
    expect(sample.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(sample.every((entry, i) => i === 0 || entry.xp < sample[i - 1].xp)).toBe(true);
    expect(sample.every((entry) => entry.xp > 0)).toBe(true);
  });

  test('chaque récompense trouve son gagnant fictif', () => {
    const rewards = [{ rank: 2, roleId: null, coins: 10 }, { rank: 10, roleId: null, coins: 5 }];
    expect(planSeasonRewards(rewards, sampleSeasonStandings(rewards)).map((entry) => entry.rank)).toEqual([2, 10]);
  });
});

describe('seasonReminderAnnouncement', () => {
  test('titre, date de clôture puis classement provisoire limité au podium', () => {
    const standings = [1, 2, 3, 4].map((rank) => ({ rank, user: `u${rank}`, xp: String(100 - rank) }));
    const text = seasonReminderAnnouncement(LABELS, { number: 2, name: 'Hiver', date: '1 déc.' }, standings);
    expect(text.title).toBe('Dernier jour #2 · Hiver');
    expect(text.description.split('\n')).toEqual(['Clôture le 1 déc..', '', '#1 u1 +99', '#2 u2 +98', '#3 u3 +97']);
  });

  test('sans classé, la date seule', () => {
    expect(seasonReminderAnnouncement(LABELS, { number: 2, name: 'Hiver', date: 'x' }, []).description).toBe('Clôture le x.');
  });
});

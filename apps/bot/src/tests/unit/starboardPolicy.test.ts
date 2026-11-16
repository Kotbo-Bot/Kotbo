import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STARBOARD_CONFIG,
  STARBOARD_BUSY_PER_DAY,
  STARBOARD_EXCERPT_MAX,
  STARBOARD_STATS_DAYS,
  decodeScoreCursor,
  encodeScoreCursor,
  isStarboardPeriod,
  isStarboardSort,
  starboardAdvice,
  starboardExcerpt,
  starboardPeriodStart,
} from '@kotbo/shared';

const NOW = new Date('2026-11-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('valeurs par défaut', () => {
  test('reprennent celles du schéma', () => {
    expect(DEFAULT_STARBOARD_CONFIG.threshold).toBe(5);
    expect(DEFAULT_STARBOARD_CONFIG.upvoteEmojis).toEqual(['👍']);
    expect(DEFAULT_STARBOARD_CONFIG.embedColor).toBe('#F5C518');
    expect(DEFAULT_STARBOARD_CONFIG.channelId).toBeNull();
  });
});

describe('périodes', () => {
  test('reconnaît les périodes et les tris', () => {
    expect(isStarboardPeriod('week')).toBe(true);
    expect(isStarboardPeriod('year')).toBe(false);
    expect(isStarboardSort('score')).toBe(true);
    expect(isStarboardSort('oldest')).toBe(false);
  });

  test('semaine et mois comptent en jours glissants, « tout » n’a pas de début', () => {
    expect(starboardPeriodStart('week', NOW)?.getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
    expect(starboardPeriodStart('month', NOW)?.getTime()).toBe(NOW.getTime() - 30 * DAY_MS);
    expect(starboardPeriodStart('all', NOW)).toBeNull();
  });
});

describe('extrait du message', () => {
  test('vide ou absent : rien', () => {
    expect(starboardExcerpt(null)).toBeNull();
    expect(starboardExcerpt('   ')).toBeNull();
  });

  test('court : rendu tel quel, sans espaces autour', () => {
    expect(starboardExcerpt('  bonjour\nà tous  ')).toBe('bonjour\nà tous');
  });

  test('long : coupé avec des points de suspension, à la borne', () => {
    const excerpt = starboardExcerpt('a'.repeat(STARBOARD_EXCERPT_MAX + 50));
    expect(excerpt).toHaveLength(STARBOARD_EXCERPT_MAX);
    expect(excerpt?.endsWith('…')).toBe(true);
  });
});

describe('curseur au score', () => {
  test('aller-retour', () => {
    expect(decodeScoreCursor(encodeScoreCursor(42, 'clentry0001'))).toEqual({ score: 42, id: 'clentry0001' });
  });

  test('score négatif accepté, forme invalide refusée', () => {
    expect(decodeScoreCursor('-3_abc')).toEqual({ score: -3, id: 'abc' });
    expect(decodeScoreCursor('abc')).toBeNull();
    expect(decodeScoreCursor('12_')).toBeNull();
    expect(decodeScoreCursor('12_a;b')).toBeNull();
  });
});

describe('conseils', () => {
  const base = { channelId: '123456789012345678', channelFound: true, missingPermissions: [], postedRecent: 4, lastPostedAt: NOW };

  test('tout va bien : aucun conseil', () => {
    expect(starboardAdvice(base)).toEqual([]);
  });

  test('sans salon, seul ce conseil compte', () => {
    expect(starboardAdvice({ ...base, channelId: null, postedRecent: 0 })).toEqual(['NO_CHANNEL']);
  });

  test('salon disparu, puis permissions manquantes', () => {
    expect(starboardAdvice({ ...base, channelFound: false })).toEqual(['CHANNEL_GONE']);
    expect(starboardAdvice({ ...base, missingPermissions: ['SendMessages'] })).toEqual(['MISSING_PERMISSIONS']);
  });

  test('salon invérifiable (serveur hors cache) : pas de fausse alerte', () => {
    expect(starboardAdvice({ ...base, channelFound: null })).toEqual([]);
  });

  test('module qui s’endort : déjà publié, plus rien sur la fenêtre', () => {
    const lastPostedAt = new Date(NOW.getTime() - (STARBOARD_STATS_DAYS + 5) * DAY_MS);
    expect(starboardAdvice({ ...base, postedRecent: 0, lastPostedAt })).toEqual(['QUIET']);
  });

  test('jamais rien publié : pas encore de conseil sur le seuil', () => {
    expect(starboardAdvice({ ...base, postedRecent: 0, lastPostedAt: null })).toEqual([]);
  });

  test('rafale de publications : seuil trop bas', () => {
    const postedRecent = STARBOARD_BUSY_PER_DAY * STARBOARD_STATS_DAYS;
    expect(starboardAdvice({ ...base, postedRecent })).toEqual(['BUSY']);
    expect(starboardAdvice({ ...base, postedRecent: postedRecent - 1 })).toEqual([]);
  });
});

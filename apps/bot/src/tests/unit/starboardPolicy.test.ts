import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STARBOARD_CONFIG,
  STARBOARD_BUSY_PER_DAY,
  STARBOARD_CHANNEL_THRESHOLDS_MAX,
  STARBOARD_EXCERPT_MAX,
  STARBOARD_STATS_DAYS,
  decodeScoreCursor,
  encodeScoreCursor,
  isDiscordMediaUrl,
  isStarboardPeriod,
  isStarboardSort,
  normalizeStarboardChannelThresholds,
  starboardAdvice,
  starboardExcerpt,
  starboardPeriodStart,
  starboardSkipReason,
  starboardThresholdFor,
} from '@kotbo/shared';

const NOW = new Date('2026-11-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('valeurs par défaut', () => {
  test('reprennent celles du schéma', () => {
    expect(DEFAULT_STARBOARD_CONFIG.threshold).toBe(5);
    expect(DEFAULT_STARBOARD_CONFIG.upvoteEmojis).toEqual(['👍']);
    expect(DEFAULT_STARBOARD_CONFIG.embedColor).toBe('#F5C518');
    expect(DEFAULT_STARBOARD_CONFIG.channelId).toBeNull();
    expect(DEFAULT_STARBOARD_CONFIG.maxMessageAgeDays).toBe(0);
    expect(DEFAULT_STARBOARD_CONFIG.channelThresholds).toEqual({});
    expect(DEFAULT_STARBOARD_CONFIG.blockedUserIds).toEqual([]);
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

describe('seuil par salon', () => {
  const settings = { threshold: 5, channelThresholds: { '111111111111111111': 10, '222222222222222222': 2 } };

  test('le salon a le sien, sinon le seuil du serveur', () => {
    expect(starboardThresholdFor(settings, '111111111111111111', null)).toBe(10);
    expect(starboardThresholdFor(settings, '333333333333333333', null)).toBe(5);
  });

  test('un fil prend le sien, sinon celui de son salon parent', () => {
    expect(starboardThresholdFor(settings, '444444444444444444', '222222222222222222')).toBe(2);
    expect(starboardThresholdFor({ ...settings, channelThresholds: { ...settings.channelThresholds, '444444444444444444': 7 } }, '444444444444444444', '222222222222222222')).toBe(7);
  });
});

describe('normalizeStarboardChannelThresholds', () => {
  test('garde les paires valides', () => {
    expect(normalizeStarboardChannelThresholds({ '111111111111111111': 8 })).toEqual({ thresholds: { '111111111111111111': 8 } });
  });

  test.each([
    [null, 'NOT_OBJECT'],
    [['111111111111111111'], 'NOT_OBJECT'],
    [{ abc: 3 }, 'BAD_CHANNEL'],
    [{ '111111111111111111': 0 }, 'BAD_THRESHOLD'],
    [{ '111111111111111111': 2.5 }, 'BAD_THRESHOLD'],
    [Object.fromEntries(Array.from({ length: STARBOARD_CHANNEL_THRESHOLDS_MAX + 1 }, (_, i) => [`1${String(i).padStart(17, '0')}`, 3])), 'TOO_MANY'],
  ])('refuse %j (%s)', (raw, error) => {
    expect(normalizeStarboardChannelThresholds(raw)).toEqual({ error });
  });
});

describe('starboardSkipReason', () => {
  const settings = { blockedUserIds: ['999'], maxMessageAgeDays: 7 };
  const candidate = {
    authorId: '111',
    blocked: false,
    sourceNsfw: false,
    boardNsfw: false,
    messageCreatedAt: new Date(NOW.getTime() - DAY_MS),
    alreadyEntered: false,
  };

  test('rien n’empêche : null', () => {
    expect(starboardSkipReason(settings, candidate, NOW)).toBeNull();
  });

  test('message exclu par le staff, puis auteur exclu', () => {
    expect(starboardSkipReason(settings, { ...candidate, blocked: true, authorId: '999' }, NOW)).toBe('BLOCKED_MESSAGE');
    expect(starboardSkipReason(settings, { ...candidate, authorId: '999' }, NOW)).toBe('BLOCKED_AUTHOR');
  });

  test('NSFW vers un salon tout public : jamais ; vers un salon NSFW : permis', () => {
    expect(starboardSkipReason(settings, { ...candidate, sourceNsfw: true }, NOW)).toBe('NSFW');
    expect(starboardSkipReason(settings, { ...candidate, sourceNsfw: true, boardNsfw: true }, NOW)).toBeNull();
  });

  test('trop ancien pour entrer, mais un message déjà à la une continue de vivre', () => {
    const old = { ...candidate, messageCreatedAt: new Date(NOW.getTime() - 8 * DAY_MS) };
    expect(starboardSkipReason(settings, old, NOW)).toBe('TOO_OLD');
    expect(starboardSkipReason(settings, { ...old, alreadyEntered: true }, NOW)).toBeNull();
    expect(starboardSkipReason({ ...settings, maxMessageAgeDays: 0 }, old, NOW)).toBeNull();
  });
});

describe('isDiscordMediaUrl', () => {
  test.each([
    'https://cdn.discordapp.com/attachments/1/2/chat.png?ex=1',
    'https://media.discordapp.net/attachments/1/2/chat.png',
    'https://images-ext-1.discordapp.net/external/abc/https/example.com/a.png',
    'https://media.discordapp.net/stickers/123.png',
  ])('hébergée par Discord : %s', (url) => {
    expect(isDiscordMediaUrl(url)).toBe(true);
  });

  test.each([
    'https://example.com/a.png',
    'http://cdn.discordapp.com/a.png',
    'https://cdn.discordapp.com.evil.com/a.png',
    'https://evil.com/?cdn.discordapp.com',
    'javascript:alert(1)',
    'pas une url',
  ])('refusée : %s', (url) => {
    expect(isDiscordMediaUrl(url)).toBe(false);
  });
});

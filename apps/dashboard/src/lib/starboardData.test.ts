import { describe, test, expect } from 'bun:test';
import { DEFAULT_STARBOARD_CONFIG } from '@kotbo/shared';
import { toStarboardConfig, toStarboardOverview } from './starboardData';

const STATS = { postedRecent: 2, avgPeakRecent: 7.5, bestPeakRecent: 9, onBoard: 1, lastPostedAt: '2026-11-10T10:00:00.000Z' };

describe('toStarboardConfig', () => {
  test('refuse ce qui n’est pas un objet', () => {
    expect(toStarboardConfig(null)).toBeNull();
    expect(toStarboardConfig('config')).toBeNull();
  });

  test('un champ absent prend sa valeur par défaut, les tableaux ne sont pas partagés', () => {
    const config = toStarboardConfig({ threshold: 8 });
    expect(config?.threshold).toBe(8);
    expect(config?.embedColor).toBe(DEFAULT_STARBOARD_CONFIG.embedColor);
    config?.upvoteEmojis.push('⭐');
    expect(DEFAULT_STARBOARD_CONFIG.upvoteEmojis).toEqual(['👍']);
  });

  test('ne garde pas les champs étrangers au formulaire', () => {
    const config = toStarboardConfig({ enabled: true, guildId: '1', threshold: 3 });
    expect(config && 'enabled' in config).toBe(false);
    expect(config && 'guildId' in config).toBe(false);
  });

  test('paliers copiés, sans partager la liste reçue', () => {
    const tiers = [{ threshold: 5, roleId: '111111111111111111' }];
    const config = toStarboardConfig({ tiers });
    expect(config?.tiers).toEqual(tiers);
    expect(config?.tiers).not.toBe(tiers);
  });

  test('un tableau mal formé retombe sur la valeur par défaut', () => {
    expect(toStarboardConfig({ watchedChannels: 'abc' })?.watchedChannels).toEqual([]);
  });

  test('seuils par salon : objet copié, forme inattendue ignorée', () => {
    const raw = { '111111111111111111': 8 };
    const config = toStarboardConfig({ channelThresholds: raw });
    expect(config?.channelThresholds).toEqual(raw);
    expect(config?.channelThresholds).not.toBe(raw);
    expect(toStarboardConfig({ channelThresholds: ['111111111111111111'] })?.channelThresholds).toEqual({});
    expect(toStarboardConfig({ channelThresholds: null })?.channelThresholds).toEqual({});
  });
});

describe('toStarboardOverview', () => {
  test('réponse d’un bot plus ancien (réglages seuls) : refusée', () => {
    expect(toStarboardOverview({ config: { threshold: 5 } })).toBeNull();
  });

  test('réponse complète', () => {
    const overview = toStarboardOverview({
      config: { threshold: 4 },
      stats: STATS,
      topEntries: [{ id: 'e1' }],
      channelStats: [{ channelId: '1', count: 2 }],
      health: { channelFound: false, missingPermissions: [] },
      messageLabels: { locale: 'fr', jumpButton: 'Aller au message', footerVotes: '{up} pour', attachmentsField: 'Pièces jointes' },
    });
    expect(overview?.config.threshold).toBe(4);
    expect(overview?.stats.postedRecent).toBe(2);
    expect(overview?.topEntries).toHaveLength(1);
    expect(overview?.health.channelFound).toBe(false);
    expect(overview?.messageLabels?.jumpButton).toBe('Aller au message');
  });

  test('listes et état absents : vides, état invérifiable, sans aperçu', () => {
    const overview = toStarboardOverview({ config: {}, stats: STATS });
    expect(overview?.topEntries).toEqual([]);
    expect(overview?.channelStats).toEqual([]);
    expect(overview?.health).toEqual({ channelFound: null, missingPermissions: [] });
    expect(overview?.messageLabels).toBeNull();
    expect(overview?.blockedMembers).toEqual([]);
    expect(overview?.topAuthors).toEqual([]);
    expect(overview?.unmanageableTierRoleIds).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeRankCardCustomization,
  rankCardEmojiCodePoint,
  rankCardEmojiImageUrl,
  rankCardFontStack,
  getRankCardBackground,
  getRankCardFont,
  DEFAULT_RANK_CARD_CUSTOMIZATION,
  RANK_CARD_BACKGROUNDS,
  RANK_CARD_EMOJIS,
  RANK_CARD_FONTS,
  RANK_CARD_MAX_EMOJIS,
  RANK_CARD_ACHIEVEMENTS,
  RANK_CARD_BADGE_ICONS,
  RANK_CARD_BAR_STYLES,
  RANK_CARD_FRAMES,
  RANK_CARD_MAX_BADGES,
  RANK_CARD_PATTERNS,
  RANK_CARD_TIER_COLORS,
  getRankCardAchievement,
  isManualRankCardAchievement,
  isRankCardItemUnlocked,
  rankCardAchievementsFromMetrics,
  rankCardBadgeImageUrl,
} from '@kotbo/shared';

describe('normalizeRankCardCustomization', () => {
  test('retombe sur le defaut pour toute entree non exploitable', () => {
    for (const raw of [null, undefined, 42, 'default', [], true]) {
      expect(normalizeRankCardCustomization(raw)).toEqual(DEFAULT_RANK_CARD_CUSTOMIZATION);
    }
  });

  test('conserve un fond du catalogue', () => {
    const preset = RANK_CARD_BACKGROUNDS.filter((entry) => !entry.unlockedBy).at(-1)!;
    expect(preset.id).not.toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.backgroundId);
    expect(normalizeRankCardCustomization({ backgroundId: preset.id }).backgroundId).toBe(preset.id);
  });

  test('remplace un fond hors catalogue par le defaut', () => {
    const result = normalizeRankCardCustomization({ backgroundId: 'nimportequoi' });
    expect(result.backgroundId).toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.backgroundId);
  });

  test('ecarte les emojis hors catalogue sans rejeter les autres', () => {
    const result = normalizeRankCardCustomization({ emojis: ['🔥', '🍕', '⭐'] });
    expect(result.emojis).toEqual(['🔥', '⭐']);
  });

  test('preserve l ordre choisi', () => {
    expect(normalizeRankCardCustomization({ emojis: ['⭐', '🔥'] }).emojis).toEqual(['⭐', '🔥']);
  });

  test('deduplique', () => {
    expect(normalizeRankCardCustomization({ emojis: ['🔥', '🔥', '⭐'] }).emojis).toEqual(['🔥', '⭐']);
  });

  test('plafonne au maximum autorise', () => {
    const tous = RANK_CARD_EMOJIS.map((emoji) => emoji.value);
    expect(tous.length).toBeGreaterThan(RANK_CARD_MAX_EMOJIS);
    expect(normalizeRankCardCustomization({ emojis: tous }).emojis).toHaveLength(RANK_CARD_MAX_EMOJIS);
  });

  test('ignore les entrees non textuelles de la liste', () => {
    const result = normalizeRankCardCustomization({ emojis: [null, 7, {}, '🔥'] });
    expect(result.emojis).toEqual(['🔥']);
  });

  test('vide la liste quand `emojis` n est pas un tableau', () => {
    expect(normalizeRankCardCustomization({ emojis: '🔥' }).emojis).toEqual([]);
  });

  test('ne recopie pas les cles inconnues du corps de requete', () => {
    const result = normalizeRankCardCustomization({ backgroundId: 'midnight', injecte: 'oui' });
    expect(Object.keys(result).sort()).toEqual([
      'backgroundId', 'badges', 'barStyleId', 'emojis', 'fontId', 'frameId', 'patternId', 'titleId',
    ]);
  });

  test('conserve une police du catalogue', () => {
    const font = RANK_CARD_FONTS[RANK_CARD_FONTS.length - 1];
    expect(normalizeRankCardCustomization({ fontId: font.id }).fontId).toBe(font.id);
  });

  test('remplace une police hors catalogue par le defaut', () => {
    for (const raw of ['Comic Sans MS', '', 42, null]) {
      expect(normalizeRankCardCustomization({ fontId: raw }).fontId)
        .toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.fontId);
    }
  });
});

describe('elements reserves aux succes', () => {
  const tous = new Set(RANK_CARD_ACHIEVEMENTS.map((achievement) => achievement.id));

  test('sans succes fourni, un fond reserve retombe sur le defaut', () => {
    const reserve = RANK_CARD_BACKGROUNDS.find((preset) => preset.unlockedBy)!;
    expect(normalizeRankCardCustomization({ backgroundId: reserve.id }).backgroundId)
      .toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.backgroundId);
  });

  test('un fond reserve est conserve quand son succes est acquis', () => {
    const reserve = RANK_CARD_BACKGROUNDS.find((preset) => preset.unlockedBy)!;
    const unlocked = new Set([reserve.unlockedBy!]);
    expect(normalizeRankCardCustomization({ backgroundId: reserve.id }, unlocked).backgroundId).toBe(reserve.id);
  });

  test('cadre et motif reserves suivent la meme regle', () => {
    const cadre = RANK_CARD_FRAMES.find((preset) => preset.unlockedBy)!;
    const motif = RANK_CARD_PATTERNS.find((preset) => preset.unlockedBy)!;
    const sans = normalizeRankCardCustomization({ frameId: cadre.id, patternId: motif.id });
    expect(sans.frameId).toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.frameId);
    expect(sans.patternId).toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.patternId);
    const avec = normalizeRankCardCustomization({ frameId: cadre.id, patternId: motif.id }, tous);
    expect(avec.frameId).toBe(cadre.id);
    expect(avec.patternId).toBe(motif.id);
  });

  test('un titre non acquis est retire', () => {
    expect(normalizeRankCardCustomization({ titleId: 'kotbo_staff' }).titleId).toBeNull();
    expect(normalizeRankCardCustomization({ titleId: 'kotbo_staff' }, new Set(['kotbo_staff'])).titleId).toBe('kotbo_staff');
  });

  test('un titre hors catalogue est retire meme s il figure dans les succes', () => {
    expect(normalizeRankCardCustomization({ titleId: 'invente' }, new Set(['invente'])).titleId).toBeNull();
  });

  test('les badges ne gardent que les succes acquis, dedupliques et plafonnes', () => {
    const ids = RANK_CARD_ACHIEVEMENTS.map((achievement) => achievement.id);
    expect(ids.length).toBeGreaterThan(RANK_CARD_MAX_BADGES);
    const unlocked = new Set([ids[0], ids[1]]);
    expect(normalizeRankCardCustomization({ badges: [ids[2], ids[1], ids[1], 7, ids[0]] }, unlocked).badges)
      .toEqual([ids[1], ids[0]]);
    expect(normalizeRankCardCustomization({ badges: ids }, tous).badges).toHaveLength(RANK_CARD_MAX_BADGES);
  });

  test('isRankCardItemUnlocked ouvre les elements sans condition', () => {
    expect(isRankCardItemUnlocked(undefined, new Set())).toBe(true);
    expect(isRankCardItemUnlocked('level_50', new Set())).toBe(false);
    expect(isRankCardItemUnlocked('level_50', new Set(['level_50']))).toBe(true);
  });
});

describe('rankCardAchievementsFromMetrics', () => {
  test('aucune metrique, aucun succes', () => {
    expect(rankCardAchievementsFromMetrics({})).toEqual([]);
  });

  test('un palier atteint ouvre aussi les paliers inferieurs', () => {
    const ids = rankCardAchievementsFromMetrics({ maxLevel: 50 }).map((achievement) => achievement.id);
    expect(ids).toEqual(['level_25', 'level_50']);
  });

  test('le seuil est inclusif', () => {
    const ids = rankCardAchievementsFromMetrics({ supporterMonths: 6 }).map((achievement) => achievement.id);
    expect(ids).toEqual(['supporter_1', 'supporter_6']);
  });

  test('un filleul qui a paye ouvre le succes Parrain', () => {
    const ids = rankCardAchievementsFromMetrics({ referrals: 1 }).map((achievement) => achievement.id);
    expect(ids).toEqual(['referrer']);
    expect(getRankCardAchievement('referrer')?.revocable).toBe(false);
  });

  test('un succes manuel n est jamais atteint par une metrique', () => {
    expect(rankCardAchievementsFromMetrics({ manual: 1000 })).toEqual([]);
  });

  test('les succes manuels restent acquis une fois attribues', () => {
    const manuels = RANK_CARD_ACHIEVEMENTS.filter(isManualRankCardAchievement);
    expect(manuels.map((achievement) => achievement.id)).toEqual(['bug_hunter', 'tester', 'contributor']);
    expect(manuels.every((achievement) => !achievement.revocable)).toBe(true);
  });

  test('seul le statut staff est revocable', () => {
    const revocables = RANK_CARD_ACHIEVEMENTS.filter((achievement) => achievement.revocable).map((achievement) => achievement.id);
    expect(revocables).toEqual(['kotbo_staff']);
  });
});

describe('catalogue de la carte de rang', () => {
  test('les identifiants de succes sont uniques', () => {
    const ids = RANK_CARD_ACHIEVEMENTS.map((achievement) => achievement.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('chaque image de badge existe dans les deux applications', () => {
    // Le rendu retombe silencieusement sur le trace si le PNG manque : sans ce
    // test, un badge deploye sans son asset passerait inapercu.
    const botDir = fileURLToPath(new URL('../../../assets/rank-badges/', import.meta.url));
    const dashboardDir = fileURLToPath(new URL('../../../../dashboard/public/rank-badges/', import.meta.url));
    const manquants: string[] = [];
    for (const achievement of RANK_CARD_ACHIEVEMENTS) {
      if (!achievement.image) continue;
      expect(rankCardBadgeImageUrl(achievement.image)).toBe(`/rank-badges/${achievement.image}.png`);
      if (!existsSync(`${botDir}${achievement.image}.png`)) manquants.push(`bot/${achievement.image}.png`);
      if (!existsSync(`${dashboardDir}${achievement.image}.png`)) manquants.push(`dashboard/${achievement.image}.png`);
    }
    expect(manquants).toEqual([]);
  });

  test('chaque succes a une icone et un palier connus', () => {
    for (const achievement of RANK_CARD_ACHIEVEMENTS) {
      expect(RANK_CARD_BADGE_ICONS[achievement.icon]).toBeDefined();
      expect(RANK_CARD_TIER_COLORS[achievement.tier].length).toBeGreaterThanOrEqual(2);
    }
  });

  test('toute condition de deblocage designe un succes du catalogue', () => {
    // Une faute de frappe dans `unlockedBy` rendrait l element impossible a obtenir.
    const presets = [...RANK_CARD_BACKGROUNDS, ...RANK_CARD_FRAMES, ...RANK_CARD_PATTERNS, ...RANK_CARD_BAR_STYLES];
    const orphelins = presets.filter((preset) => preset.unlockedBy && !getRankCardAchievement(preset.unlockedBy));
    expect(orphelins.map((preset) => preset.id)).toEqual([]);
  });

  test('les decors par defaut existent et sont ouverts a tous', () => {
    const defaults: Array<[Array<{ id: string; unlockedBy?: string }>, string]> = [
      [RANK_CARD_BACKGROUNDS, DEFAULT_RANK_CARD_CUSTOMIZATION.backgroundId],
      [RANK_CARD_FRAMES, DEFAULT_RANK_CARD_CUSTOMIZATION.frameId],
      [RANK_CARD_PATTERNS, DEFAULT_RANK_CARD_CUSTOMIZATION.patternId],
      [RANK_CARD_BAR_STYLES, DEFAULT_RANK_CARD_CUSTOMIZATION.barStyleId],
    ];
    for (const [presets, id] of defaults) {
      const preset = presets.find((entry) => entry.id === id);
      expect(preset).toBeDefined();
      expect(preset!.unlockedBy).toBeUndefined();
    }
  });

  test('les identifiants de decor sont uniques', () => {
    for (const presets of [RANK_CARD_FRAMES, RANK_CARD_PATTERNS, RANK_CARD_BAR_STYLES]) {
      const ids = presets.map((preset) => preset.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('le fond par defaut existe', () => {
    expect(RANK_CARD_BACKGROUNDS.some((p) => p.id === DEFAULT_RANK_CARD_CUSTOMIZATION.backgroundId)).toBe(true);
  });

  test('les identifiants de fond sont uniques', () => {
    const ids = RANK_CARD_BACKGROUNDS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('chaque fond fournit au moins deux teintes d accent', () => {
    // `renderRankCard` lit accentBar[0] et le dernier arret pour l anneau, la
    // barre d XP et les libelles : une seule teinte donnerait un degrade plat.
    for (const preset of RANK_CARD_BACKGROUNDS) {
      expect(preset.accentBar.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('getRankCardBackground retombe sur le defaut hors catalogue', () => {
    expect(getRankCardBackground('inconnu').id).toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.backgroundId);
    expect(getRankCardBackground(null).id).toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.backgroundId);
  });

  test('les points de code emoji sont uniques', () => {
    const points = RANK_CARD_EMOJIS.map((emoji) => emoji.codePoint);
    expect(new Set(points).size).toBe(points.length);
  });

  test('resout le point de code et l asset des emojis du catalogue', () => {
    for (const emoji of RANK_CARD_EMOJIS) {
      expect(rankCardEmojiCodePoint(emoji.value)).toBe(emoji.codePoint);
      expect(rankCardEmojiImageUrl(emoji.value)).toBe(`/rank-emojis/${emoji.codePoint}.png`);
    }
  });

  test('ne resout rien hors catalogue', () => {
    expect(rankCardEmojiCodePoint('🍕')).toBeNull();
    expect(rankCardEmojiImageUrl('🍕')).toBeNull();
  });

  test('la police par defaut existe et n a aucun fichier a charger', () => {
    const defaut = getRankCardFont(DEFAULT_RANK_CARD_CUSTOMIZATION.fontId);
    expect(defaut.id).toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.fontId);
    expect(defaut.family).toBeNull();
  });

  test('les identifiants de police sont uniques', () => {
    const ids = RANK_CARD_FONTS.map((font) => font.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('getRankCardFont retombe sur le defaut hors catalogue', () => {
    expect(getRankCardFont('inconnue').id).toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.fontId);
    expect(getRankCardFont(null).id).toBe(DEFAULT_RANK_CARD_CUSTOMIZATION.fontId);
  });

  test('toute pile de familles se termine par le repli', () => {
    // Le repli rattrape les caracteres que les familles latines ne couvrent
    // pas : une pile qui s en passerait afficherait des tofus.
    for (const font of RANK_CARD_FONTS) {
      expect(rankCardFontStack(font)).toContain('sans-serif');
      if (font.family) expect(rankCardFontStack(font)).toStartWith(`"${font.family}"`);
    }
  });

  test('chaque police non systeme a son fichier dans les deux applications', () => {
    const ttfDir = fileURLToPath(new URL('../../../assets/rank-fonts/', import.meta.url));
    const woffDir = fileURLToPath(new URL('../../../../dashboard/public/rank-fonts/', import.meta.url));
    const manquants: string[] = [];
    for (const font of RANK_CARD_FONTS) {
      if (!font.family) continue;
      if (!existsSync(`${ttfDir}${font.id}.ttf`)) manquants.push(`bot/${font.id}.ttf`);
      if (!existsSync(`${woffDir}${font.id}.woff2`)) manquants.push(`dashboard/${font.id}.woff2`);
    }
    expect(manquants).toEqual([]);
  });

  test('chaque emoji du catalogue a son asset sur disque', () => {
    // Le rendu ignore silencieusement un asset manquant : sans ce test, ajouter
    // une entree au catalogue sans deposer le PNG passerait inapercu.
    const dir = fileURLToPath(new URL('../../../assets/rank-emojis/', import.meta.url));
    const manquants = RANK_CARD_EMOJIS
      .map((emoji) => `${emoji.codePoint}.png`)
      .filter((fichier) => !existsSync(`${dir}${fichier}`));
    expect(manquants).toEqual([]);
  });
});

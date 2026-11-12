import { describe, expect, test } from 'bun:test';
import { getModuleDefinition } from '@kotbo/contracts';
import {
  DROP_ACTIVITY_DISABLED,
  DROP_ACTIVITY_MESSAGES_RANGE,
  DROP_ACTIVITY_WINDOW_MINUTES_RANGE,
  DROP_AMOUNT_RANGE,
  DROP_DELETE_AFTER_DISABLED,
  DROP_INTERVAL_MINUTES_RANGE,
  DROP_MIN_OPEN_MINUTES,
  DROP_MIN_PUBLISH_GAP_MINUTES,
  DROP_ITEM_POOL_MAX,
  DROP_ITEM_QUANTITY_RANGE,
  DROP_ITEM_WEIGHT_TOTAL,
  DROP_TYPES,
  DROP_TYPE_MODULE,
  dropItemsTotalWeight,
  normalizeDropItems,
  pickWeightedDropItem,
  defaultDropTypeSettings,
  drawDropAmount,
  dropExpiresAt,
  dropMaxClaims,
  dropMessageDeleteAt,
  dropActivityVerdict,
  dropTypeBlocker,
  enabledDropModes,
  nextAllowedPublicationAt,
  normalizeDropGlobalSettings,
  normalizeDropTypeSettings,
  pickDropMode,
  planNextDropAt,
  type DropTypeSettings,
} from '@kotbo/shared';

const MINUTE_MS = 60 * 1000;
const since = new Date('2026-08-23T00:00:00.000Z');

/** Générateur déterministe : chaque appel consomme la valeur suivante, puis boucle. */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length];
}

function settings(overrides: Partial<DropTypeSettings> = {}): DropTypeSettings {
  return normalizeDropTypeSettings('XP', { ...defaultDropTypeSettings('XP'), ...overrides });
}

describe('planification des drops', () => {
  test("l'apparition tombe entre la moitié et une fois et demie l'intervalle", () => {
    const earliest = planNextDropAt(since, 360, () => 0);
    const latest = planNextDropAt(since, 360, () => 1);

    expect(earliest.getTime()).toBe(since.getTime() + 180 * MINUTE_MS);
    expect(latest.getTime()).toBe(since.getTime() + 540 * MINUTE_MS);
  });

  test('le tirage ne descend jamais sous l’écart minimal entre deux publications', () => {
    // Au réglage le plus serré, la moitié de l'intervalle tomberait sous la
    // cadence voulue : c'est le cas que le plancher doit rattraper.
    const soonest = planNextDropAt(since, DROP_INTERVAL_MINUTES_RANGE.min, () => 0);

    expect(soonest.getTime()).toBe(since.getTime() + DROP_MIN_PUBLISH_GAP_MINUTES * MINUTE_MS);
  });

  test('un serveur ne peut pas republier avant l’écart minimal', () => {
    const lastPublished = new Date('2026-08-23T10:00:00.000Z');

    expect(nextAllowedPublicationAt(lastPublished)?.getTime())
      .toBe(lastPublished.getTime() + DROP_MIN_PUBLISH_GAP_MINUTES * MINUTE_MS);
    // Aucun drop encore publié : rien à attendre.
    expect(nextAllowedPublicationAt(null)).toBeNull();
  });

  test('un intervalle hors bornes est ramené dans la plage autorisée', () => {
    const tooShort = planNextDropAt(since, 0, () => 0);
    const tooLong = planNextDropAt(since, 999_999, () => 0);

    // La borne basse repasse sous l'écart minimal, qui reprend la main.
    expect(tooShort.getTime()).toBe(since.getTime() + DROP_MIN_PUBLISH_GAP_MINUTES * MINUTE_MS);
    expect(tooLong.getTime()).toBe(since.getTime() + (DROP_INTERVAL_MINUTES_RANGE.max / 2) * MINUTE_MS);
  });
});

describe('choix du mode de ramassage', () => {
  test('seuls les modes activés sont tirables', () => {
    const config = settings({
      first: { enabled: false, minAmount: 10, maxAmount: 20 },
      race: { enabled: true, winnerCount: 3, minAmount: 10, maxAmount: 20 },
      window: { enabled: true, durationMinutes: 10, minAmount: 5, maxAmount: 10 },
    });

    expect(enabledDropModes(config)).toEqual(['RACE', 'WINDOW']);
    expect(pickDropMode(config, () => 0)).toBe('RACE');
    expect(pickDropMode(config, () => 0.99)).toBe('WINDOW');
  });

  test('aucun mode activé ne produit aucun drop', () => {
    const config = settings({
      first: { enabled: false, minAmount: 10, maxAmount: 20 },
      race: { enabled: false, winnerCount: 3, minAmount: 10, maxAmount: 20 },
      window: { enabled: false, durationMinutes: 10, minAmount: 5, maxAmount: 10 },
    });

    expect(pickDropMode(config, () => 0)).toBeNull();
  });
});

describe('montant tiré', () => {
  test('le tirage reste dans la fourchette du mode', () => {
    const config = settings({ first: { enabled: true, minAmount: 100, maxAmount: 200 } });

    expect(drawDropAmount(config, 'FIRST', () => 0)).toBe(100);
    expect(drawDropAmount(config, 'FIRST', () => 0.999999)).toBe(200);
  });

  test('chaque mode garde son propre barème', () => {
    const config = settings({
      first: { enabled: true, minAmount: 500, maxAmount: 500 },
      window: { enabled: true, durationMinutes: 10, minAmount: 20, maxAmount: 20 },
    });

    expect(drawDropAmount(config, 'FIRST', sequence([0.5]))).toBe(500);
    expect(drawDropAmount(config, 'WINDOW', sequence([0.5]))).toBe(20);
  });

  test('une fourchette saisie à l’envers est remise à l’endroit', () => {
    const config = normalizeDropTypeSettings('COINS', {
      first: { enabled: true, minAmount: 900, maxAmount: 100 },
    });

    expect(config.first.minAmount).toBe(100);
    expect(config.first.maxAmount).toBe(900);
  });

  test('un montant hors bornes est ramené dans la plage autorisée', () => {
    const config = normalizeDropTypeSettings('XP', {
      first: { enabled: true, minAmount: 0, maxAmount: 99_999_999 },
    });

    expect(config.first.minAmount).toBe(DROP_AMOUNT_RANGE.min);
    expect(config.first.maxAmount).toBe(DROP_AMOUNT_RANGE.max);
  });
});

describe('fermeture d’un drop', () => {
  test('un drop reste ramassable au moins cinq minutes, quel que soit le mode', () => {
    // Le plancher tient même sur une config qui contiendrait moins : il est
    // appliqué au calcul de l'échéance, pas seulement à l'enregistrement.
    const config = normalizeDropTypeSettings('XP', {
      window: { enabled: true, durationMinutes: 1, minAmount: 5, maxAmount: 10 },
    });

    expect(config.window.durationMinutes).toBe(DROP_MIN_OPEN_MINUTES);
    expect(normalizeDropGlobalSettings({ dropLifetimeMinutes: 1 }).dropLifetimeMinutes).toBe(DROP_MIN_OPEN_MINUTES);
    expect(dropExpiresAt(since, config, 'WINDOW', 1).getTime())
      .toBe(since.getTime() + DROP_MIN_OPEN_MINUTES * MINUTE_MS);
    expect(dropExpiresAt(since, config, 'FIRST', 1).getTime())
      .toBe(since.getTime() + DROP_MIN_OPEN_MINUTES * MINUTE_MS);
  });

  test('le mode fenêtre ferme sur sa propre durée, les autres sur la durée de vie globale', () => {
    const config = settings({ window: { enabled: true, durationMinutes: 15, minAmount: 5, maxAmount: 10 } });

    expect(dropExpiresAt(since, config, 'WINDOW', 60).getTime()).toBe(since.getTime() + 15 * MINUTE_MS);
    expect(dropExpiresAt(since, config, 'FIRST', 60).getTime()).toBe(since.getTime() + 60 * MINUTE_MS);
  });

  test('le nombre de ramassages dépend du mode', () => {
    const config = settings({ race: { enabled: true, winnerCount: 7, minAmount: 10, maxAmount: 20 } });

    expect(dropMaxClaims(config, 'FIRST')).toBe(1);
    expect(dropMaxClaims(config, 'RACE')).toBe(7);
    // 0 = sans limite : c'est le temps qui ferme une fenêtre, pas un compteur.
    expect(dropMaxClaims(config, 'WINDOW')).toBe(0);
  });
});

describe('réglages globaux', () => {
  test('les valeurs absentes retombent sur les défauts et les bornes sont appliquées', () => {
    const normalized = normalizeDropGlobalSettings({ dropLifetimeMinutes: 100_000 });

    expect(normalized.dropsEnabled).toBe(false);
    expect(normalized.dropChannelId).toBeNull();
    expect(normalized.dropLifetimeMinutes).toBe(1_440);
    expect(normalized.dropDeleteAfterMinutes).toBe(DROP_DELETE_AFTER_DISABLED);
  });

  test('la suppression automatique est éteinte tant que le délai n’est pas un nombre de minutes valide', () => {
    const closedAt = new Date('2026-01-01T12:00:00Z');

    expect(normalizeDropGlobalSettings({ dropDeleteAfterMinutes: -5 }).dropDeleteAfterMinutes)
      .toBe(DROP_DELETE_AFTER_DISABLED);
    expect(normalizeDropGlobalSettings({ dropDeleteAfterMinutes: 100_000 }).dropDeleteAfterMinutes).toBe(1_440);
    expect(dropMessageDeleteAt(closedAt, DROP_DELETE_AFTER_DISABLED)).toBeNull();
    expect(dropMessageDeleteAt(closedAt, 30)?.getTime()).toBe(closedAt.getTime() + 30 * MINUTE_MS);
  });
});

describe('drop d’objet RPG', () => {
  test('les montants sont des exemplaires, pas des points', () => {
    const config = normalizeDropTypeSettings('RPG_ITEM', {
      first: { enabled: true, minAmount: 1, maxAmount: 5000 },
    });

    // La fourchette du million appartient aux ressources ; une épée se compte à l'unité.
    expect(config.first.maxAmount).toBe(DROP_ITEM_QUANTITY_RANGE.max);
    expect(DROP_ITEM_QUANTITY_RANGE.max).toBeLessThan(DROP_AMOUNT_RANGE.max);
  });

  test('les autres types gardent leur fourchette', () => {
    const config = normalizeDropTypeSettings('COINS', {
      first: { enabled: true, minAmount: 1, maxAmount: 5000 },
    });

    expect(config.first.maxAmount).toBe(5000);
  });

  // Le tirage lit la liste telle quelle : un identifiant répété doublerait ses chances
  // sans que personne ne l'ait demandé.
  test('la liste d’objets est dédoublonnée et bornée', () => {
    const config = normalizeDropTypeSettings('RPG_ITEM', {
      items: [{ itemId: 'epee', weight: 30 }, { itemId: 'epee', weight: 60 }, { itemId: 'potion', weight: 70 }],
    });
    expect(config.items).toEqual([{ itemId: 'epee', weight: 30 }, { itemId: 'potion', weight: 70 }]);

    const flooded = normalizeDropItems(
      Array.from({ length: DROP_ITEM_POOL_MAX + 10 }, (_, i) => ({ itemId: `item-${i}`, weight: 1 })),
    );
    expect(flooded).toHaveLength(DROP_ITEM_POOL_MAX);
  });

  test('une liste absente ou salie ne casse rien', () => {
    expect(normalizeDropTypeSettings('RPG_ITEM', {}).items).toEqual([]);
    expect(normalizeDropItems('pas un tableau')).toEqual([]);
    expect(normalizeDropItems([{ itemId: '', weight: 50 }, { itemId: 'ok', weight: 50 }]))
      .toEqual([{ itemId: 'ok', weight: 50 }]);
  });

  test('un taux aberrant est ramené dans ses bornes', () => {
    expect(normalizeDropItems([{ itemId: 'a', weight: 0 }])).toEqual([{ itemId: 'a', weight: 1 }]);
    expect(normalizeDropItems([{ itemId: 'a', weight: 900 }])).toEqual([{ itemId: 'a', weight: 100 }]);
  });

  test('un drop d’objet part sans liste par défaut, donc ne publie rien', () => {
    expect(defaultDropTypeSettings('RPG_ITEM').items).toEqual([]);
    expect(defaultDropTypeSettings('RPG_ITEM').enabled).toBe(false);
  });
});

describe('tirage pondéré d’un objet', () => {
  const POOL = [
    { itemId: 'rare', weight: 1 },
    { itemId: 'commun', weight: 49 },
    { itemId: 'banal', weight: 50 },
  ];

  test('la somme des taux fait bien cent', () => {
    expect(dropItemsTotalWeight(POOL)).toBe(DROP_ITEM_WEIGHT_TOTAL);
  });

  // Le tirage lit un ticket entre zéro et la somme : chaque objet occupe la tranche que
  // son taux lui donne, dans l'ordre de la liste.
  test('chaque objet occupe la tranche de son taux', () => {
    expect(pickWeightedDropItem(POOL, () => 0)).toBe('rare');
    expect(pickWeightedDropItem(POOL, () => 0.005)).toBe('rare');
    expect(pickWeightedDropItem(POOL, () => 0.02)).toBe('commun');
    expect(pickWeightedDropItem(POOL, () => 0.9)).toBe('banal');
  });

  // C'est tout l'intérêt d'un tirage proportionnel : écarter un objet devenu inéligible
  // ne décale pas les rapports entre ceux qui restent.
  test('une liste dont la somme a dérivé tire quand même juste', () => {
    const reduced = [{ itemId: 'commun', weight: 49 }, { itemId: 'banal', weight: 50 }];
    expect(pickWeightedDropItem(reduced, () => 0)).toBe('commun');
    expect(pickWeightedDropItem(reduced, () => 0.99)).toBe('banal');
  });

  test('un arrondi en bout de course ne rend jamais rien', () => {
    expect(pickWeightedDropItem(POOL, () => 0.999999999)).toBe('banal');
  });

  test('une liste vide ou sans poids ne tire rien', () => {
    expect(pickWeightedDropItem([])).toBeNull();
    expect(pickWeightedDropItem([{ itemId: 'a', weight: 0 }])).toBeNull();
  });
});

describe('module qui verse la récompense d\'un drop', () => {
  test('chaque type de drop est rattaché à un module du registre', () => {
    for (const type of DROP_TYPES) {
      expect(getModuleDefinition(DROP_TYPE_MODULE[type])).toBeDefined();
    }
  });

  test('l\'XP de niveau dépend du leveling, les points de clan des clans, le reste de l\'économie', () => {
    expect(DROP_TYPE_MODULE).toEqual({
      XP: 'leveling',
      RPG_XP: 'economy',
      CLAN_POINTS: 'clans',
      COINS: 'economy',
      RPG_ITEM: 'economy',
    });
  });
});

describe('ce qui empêche un type de drop de tomber', () => {
  const pret = { defaultChannelId: 'salon-defaut', resourceModuleActive: true, rpgEnabled: true };

  test('un type complet n\'est pas bloqué', () => {
    expect(dropTypeBlocker('XP', defaultDropTypeSettings('XP'), pret)).toBeNull();
  });

  test('module de la ressource éteint', () => {
    expect(dropTypeBlocker('COINS', defaultDropTypeSettings('COINS'), { ...pret, resourceModuleActive: false }))
      .toBe('MODULE_OFF');
  });

  test('aucun salon, ni propre ni par défaut', () => {
    expect(dropTypeBlocker('XP', defaultDropTypeSettings('XP'), { ...pret, defaultChannelId: null })).toBe('NO_CHANNEL');
    expect(dropTypeBlocker('XP', { ...defaultDropTypeSettings('XP'), channelId: 'salon-xp' }, { ...pret, defaultChannelId: null }))
      .toBeNull();
  });

  test('aucun mode de ramassage', () => {
    const settings = defaultDropTypeSettings('XP');
    expect(dropTypeBlocker('XP', { ...settings, first: { ...settings.first, enabled: false } }, pret)).toBe('NO_MODE');
  });

  test('drop d\'objet : RPG éteint, puis liste vide', () => {
    const settings = { ...defaultDropTypeSettings('RPG_ITEM'), items: [{ itemId: 'epee', weight: 100 }] };
    expect(dropTypeBlocker('RPG_ITEM', settings, { ...pret, rpgEnabled: false })).toBe('RPG_OFF');
    expect(dropTypeBlocker('RPG_ITEM', { ...settings, items: [] }, pret)).toBe('NO_ITEMS');
    expect(dropTypeBlocker('RPG_ITEM', settings, pret)).toBeNull();
  });

  test('le RPG éteint ne bloque que le drop d\'objet', () => {
    expect(dropTypeBlocker('COINS', defaultDropTypeSettings('COINS'), { ...pret, rpgEnabled: false })).toBeNull();
  });
});

describe('attente d\'activité dans le salon', () => {
  const dueAt = since;
  const activity = { minMessages: 5, windowMinutes: 15 };

  test('éteinte par défaut, et bornée à la normalisation', () => {
    expect(defaultDropTypeSettings('XP').activity.minMessages).toBe(DROP_ACTIVITY_DISABLED);

    const normalized = normalizeDropTypeSettings('XP', { activity: { minMessages: 10_000, windowMinutes: 1 } });
    expect(normalized.activity.minMessages).toBe(DROP_ACTIVITY_MESSAGES_RANGE.max);
    expect(normalized.activity.windowMinutes).toBe(DROP_ACTIVITY_WINDOW_MINUTES_RANGE.min);
    expect(normalizeDropTypeSettings('XP', { activity: { minMessages: -3, windowMinutes: 15 } }).activity.minMessages)
      .toBe(DROP_ACTIVITY_DISABLED);
  });

  test('éteinte : le drop part sans rien compter', () => {
    expect(dropActivityVerdict({
      dueAt, now: dueAt, intervalMinutes: 60, activity: { minMessages: DROP_ACTIVITY_DISABLED, windowMinutes: 15 }, recentMessages: 0,
    })).toBe('publish');
  });

  test('assez de messages : le drop part', () => {
    expect(dropActivityVerdict({ dueAt, now: dueAt, intervalMinutes: 60, activity, recentMessages: 5 })).toBe('publish');
  });

  test('salon calme : le drop attend', () => {
    expect(dropActivityVerdict({ dueAt, now: new Date(dueAt.getTime() + 30 * MINUTE_MS), intervalMinutes: 60, activity, recentMessages: 4 }))
      .toBe('wait');
  });

  test('salon calme depuis un intervalle entier : le drop part quand même', () => {
    expect(dropActivityVerdict({ dueAt, now: new Date(dueAt.getTime() + 60 * MINUTE_MS), intervalMinutes: 60, activity, recentMessages: 0 }))
      .toBe('publish');
  });
});

import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { RpgItem } from '@prisma/client';
import type { ItemCatalogEntry } from '../../services/features/rpg/rpgItemCatalogService.js';

// Le module charge la base au démarrage : ces tests n'en ont pas besoin.
for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: {}, prisma: {}, prismaRead: {}, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { isUnavailableItem, isUniqueItem, matchesSourceFilter } = await import('../../services/features/rpg/rpgItemCatalogService.js');

function entry(overrides: Partial<ItemCatalogEntry>): ItemCatalogEntry {
  return {
    item: { name: 'Lame du Premier' } as RpgItem,
    shop: false,
    monsters: [],
    bosses: [],
    crafted: false,
    firstKill: [],
    firstKillClaimed: [],
    campaign: false,
    ...overrides,
  };
}

describe('objets uniques du catalogue', () => {
  test('une prime de premier vainqueur encore à gagner est unique', () => {
    const weapon = entry({ firstKill: ['Dragon'] });
    expect(isUniqueItem(weapon)).toBe(true);
    expect(matchesSourceFilter(weapon, 'unique')).toBe(true);
  });

  test('reste unique et visible une fois remportée', () => {
    const weapon = entry({ firstKillClaimed: ['Dragon'] });
    expect(isUniqueItem(weapon)).toBe(true);
    expect(isUnavailableItem(weapon)).toBe(false);
    expect(matchesSourceFilter(weapon, 'unique')).toBe(true);
  });

  test('un objet sans aucune source reste indisponible', () => {
    expect(isUnavailableItem(entry({}))).toBe(true);
    expect(isUniqueItem(entry({}))).toBe(false);
  });
});

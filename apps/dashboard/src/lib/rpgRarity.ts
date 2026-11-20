/** Libellé d'une rareté d'objet RPG ; une rareté inconnue s'affiche telle quelle. */
import { m } from './i18n';

const RARITY_LABELS: Record<string, () => string> = {
  COMMON: () => m.eco_rarity_common(),
  UNCOMMON: () => m.eco_rarity_uncommon(),
  RARE: () => m.eco_rarity_rare(),
  EPIC: () => m.eco_rarity_epic(),
  LEGENDARY: () => m.eco_rarity_legendary(),
};

export function rpgRarityLabel(rarity: string): string {
  return RARITY_LABELS[rarity]?.() ?? rarity;
}

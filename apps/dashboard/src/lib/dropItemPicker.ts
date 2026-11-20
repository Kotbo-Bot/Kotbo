/**
 * Choix des objets d'un drop d'objet RPG : tri par rareté et recherche par nom.
 * Un serveur au gros catalogue ne doit pas avoir à parcourir des dizaines de pastilles
 * dans l'ordre de création pour retrouver la pièce qu'il veut faire tomber.
 */
import { RPG_ITEM_RARITIES } from '@kotbo/contracts';

export interface PickableItem {
  id: string;
  name: string;
  emoji: string;
  rarity: string;
}

/** Une rareté inconnue est rangée avec les communes : elle ne se perd pas en bas. */
function rarityRank(rarity: string): number {
  return Math.max(0, (RPG_ITEM_RARITIES as readonly string[]).indexOf(rarity));
}

export function sortItemsByRarity<T extends PickableItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || a.name.localeCompare(b.name));
}

/** Texte comparable : sans accents ni majuscules. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

export function matchesItemQuery(item: PickableItem, query: string): boolean {
  const wanted = fold(query);
  return wanted === '' || fold(item.name).includes(wanted);
}

/**
 * Administration d'un profil RPG : statistiques et inventaire.
 *
 * Partagée par le dashboard et les outils MCP, pour qu'aucun des deux n'écrive une valeur
 * que l'autre refuserait.
 */

import prisma from '../../../utils/db.js';
import { adminRemoveItem, adminSpawnItem } from '../economyService.js';
import { slotHoldingItem } from './rpgEquipment.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

/**
 * Bornes des valeurs qu'un administrateur peut fixer sur un profil. Le niveau part de un :
 * à zéro, la formule d'XP renverrait un palier nul et le personnage monterait sans fin.
 */
export const PLAYER_STAT_RANGES = {
  balance: { min: 0, max: 1_000_000_000 },
  level: { min: 1, max: 1_000 },
  xp: { min: 0, max: 100_000_000 },
  health: { min: 0, max: 1_000_000 },
  maxHealth: { min: 1, max: 1_000_000 },
  // L'énergie max d'un joueur peut monter de 2 millions au-dessus de celle du serveur
  // (boutique de la Tour) : l'admin doit pouvoir la remplir.
  energy: { min: 0, max: 2_100_000 },
  attack: { min: 0, max: 100_000 },
  defense: { min: 0, max: 100_000 },
  speed: { min: 0, max: 100_000 },
  statPoints: { min: 0, max: 100_000 },
  skillPoints: { min: 0, max: 100_000 },
} as const;

export type PlayerStatField = keyof typeof PLAYER_STAT_RANGES;
export type PlayerStatsInput = Partial<Record<PlayerStatField, number | null>>;

/** Plus gros don d'objets en une fois. */
export const INVENTORY_GRANT_MAX = 999;

export class PlayerAdminError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PlayerAdminError';
  }
}

async function findProfile(guildId: string, userId: string) {
  const profile = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } } });
  if (!profile) throw new PlayerAdminError('Profil RPG introuvable pour cet utilisateur.', 404);
  return profile;
}

/**
 * Fixe des statistiques de base. Un champ omis ou nul n'est pas touché.
 *
 * Aucune valeur n'était vérifiée : un solde négatif ou un niveau à zéro passaient, et le
 * jeu les lisait ensuite sans s'y attendre.
 */
export async function adminUpdatePlayerStats(guildId: string, userId: string, input: PlayerStatsInput) {
  const data: Partial<Record<PlayerStatField, number>> = {};
  for (const [field, range] of Object.entries(PLAYER_STAT_RANGES) as [PlayerStatField, { min: number; max: number }][]) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      throw new PlayerAdminError(`« ${field} » doit être un entier entre ${range.min} et ${range.max}.`, 400);
    }
    data[field] = value;
  }
  if (Object.keys(data).length === 0) throw new PlayerAdminError('Rien à modifier.', 400);

  const profile = await findProfile(guildId, userId);
  return prisma.rpgProfile.update({ where: { id: profile.id }, data });
}

/** Inventaire d'un joueur, avec ce qu'il porte et le niveau de forge de chaque objet. */
export async function getPlayerInventory(guildId: string, userId: string) {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    include: {
      inventory: {
        where: { quantity: { gt: 0 } },
        include: { item: true },
        orderBy: { item: { name: 'asc' } },
      },
    },
  });
  if (!profile) throw new PlayerAdminError('Profil RPG introuvable pour cet utilisateur.', 404);

  const instances = await prisma.rpgItemInstance.findMany({
    where: { rpgProfileId: profile.id },
    orderBy: { upgrade: 'desc' },
  });
  const upgradesByItem = new Map<string, number[]>();
  for (const instance of instances) {
    upgradesByItem.set(instance.itemId, [...(upgradesByItem.get(instance.itemId) ?? []), instance.upgrade]);
  }

  return profile.inventory.map((entry) => {
    const upgrades = upgradesByItem.get(entry.itemId) ?? [];
    return {
      itemId: entry.itemId,
      quantity: entry.quantity,
      item: entry.item,
      equipped: slotHoldingItem(profile, entry.itemId) !== null,
      // Le meilleur exemplaire : chaque exemplaire forgé a désormais sa propre progression.
      upgrade: upgrades[0] ?? 0,
      /** Niveaux de forge des exemplaires individualisés, du plus forgé au moins forgé. */
      forgedCopies: upgrades,
    };
  });
}

/** Donne des exemplaires d'un objet de ce serveur ou du catalogue livré. */
export async function adminGrantItem(guildId: string, userId: string, itemId: string, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > INVENTORY_GRANT_MAX) {
    throw new PlayerAdminError(`La quantité doit être un entier entre 1 et ${INVENTORY_GRANT_MAX}.`, 400);
  }
  await findProfile(guildId, userId);

  // Un objet d'un autre serveur n'a rien à faire ici : sans ce contrôle, un identifiant
  // forgé glissait dans l'inventaire un objet que ce serveur ne voit pas.
  const item = await prisma.rpgItem.findUnique({ where: { id: itemId } });
  if (!item || (item.guildId !== null && item.guildId !== guildId)) {
    throw new PlayerAdminError('Objet introuvable.', 404);
  }

  await adminSpawnItem(guildId, userId, item.id, quantity);
  return { itemName: item.name, quantity };
}

/** Retire des exemplaires. Retirer le dernier le déséquipe et efface sa progression. */
export async function adminTakeItem(guildId: string, userId: string, itemId: string, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new PlayerAdminError('Quantité invalide.', 400);
  }
  const profile = await findProfile(guildId, userId);

  const owned = await prisma.rpgInventoryItem.findUnique({
    where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId } },
    select: { quantity: true },
  });
  if (!owned || owned.quantity <= 0) {
    throw new PlayerAdminError('Ce joueur ne possède pas cet objet.', 404);
  }

  return adminRemoveItem(guildId, userId, itemId, quantity);
}

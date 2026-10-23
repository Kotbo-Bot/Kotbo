/**
 * Enregistrement d'un objet de la boutique d'un serveur.
 *
 * Le dashboard et les outils MCP écrivent tous deux dans le catalogue : la validation vit
 * ici pour qu'ils refusent exactement les mêmes objets. L'outil MCP en avait une copie
 * appauvrie, qui acceptait un bonus négatif et oubliait la rareté, le niveau requis et le
 * suivi des butins et recettes au renommage.
 */

import {
  RPG_ENCHANTMENTS,
  RPG_ITEM_RARITIES,
  RPG_ITEM_TYPES,
  getEnchantment,
  isRpgItemRarity,
  isRpgItemType,
  type RpgItemPayload,
} from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import {
  CLAN_POINTS_REWARD_RANGE,
  hasModuleReward,
  LEVEL_XP_REWARD_RANGE,
  RAID_ASSAULT_BONUS_RANGE,
} from '../economyPolicy.js';
import { clampInt } from './rpgBlackMarketPolicy.js';
import { slotForItemType } from './rpgEquipment.js';
import { syncDropReferences } from './rpgBestiaryService.js';
import { syncRecipeReferences } from './rpgRecipeService.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

/** Bornes des statistiques d'un objet : de quoi équilibrer, pas de quoi casser le combat. */
export const ITEM_STAT_RANGE = { min: 0, max: 10_000 };
export const ITEM_LEVEL_RANGE = { min: 0, max: 1_000 };

export class ShopItemError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ShopItemError';
  }
}

/**
 * Crée ou modifie un objet propre au serveur.
 *
 * `body.id` désigne l'objet à modifier. `createWithId` permet à l'appelant de fixer
 * l'identifiant d'un objet créé (l'outil MCP accepte des identifiants lisibles) : il vaut
 * modification si l'objet existe déjà sur ce serveur.
 */
export async function saveGuildShopItem(
  guildId: string,
  body: RpgItemPayload,
  options: { createWithId?: string } = {},
) {
  if (!body || !body.name?.trim() || !body.type || body.price === undefined || body.price === null) {
    throw new ShopItemError('Champs obligatoires manquants.', 400);
  }
  // Une faute de frappe posait un type que rien ne savait équiper, vendre ni afficher.
  if (!isRpgItemType(body.type)) {
    throw new ShopItemError(`Type d'objet inconnu : « ${body.type} ». Valeurs acceptées : ${RPG_ITEM_TYPES.join(', ')}.`, 400);
  }
  // Discord refuse une option de menu sans description : un objet qui en manque
  // rendait la boutique entière inaccessible côté bot.
  if (!body.description?.trim()) {
    throw new ShopItemError("La description de l'objet est obligatoire : elle s'affiche dans la boutique.", 400);
  }
  if (body.rarity !== undefined && !isRpgItemRarity(body.rarity)) {
    throw new ShopItemError(`Rareté inconnue : « ${body.rarity} ». Valeurs acceptées : ${RPG_ITEM_RARITIES.join(', ')}.`, 400);
  }

  // Un prix négatif faisait gagner de l'argent à l'achat et en coûter à la revente.
  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0) {
    throw new ShopItemError('Le prix doit être un nombre positif ou nul.', 400);
  }

  // Un parchemin sans enchantement ne fait rien : on refuse plutôt que de laisser passer
  // un objet inerte.
  if (body.type === 'SCROLL' && !body.enchantId) {
    throw new ShopItemError("Un parchemin doit désigner l'enchantement qu'il pose.", 400);
  }
  const enchantment = body.enchantId ? getEnchantment(body.enchantId) : null;
  if (body.enchantId && !enchantment) {
    throw new ShopItemError(`Enchantement inconnu : « ${body.enchantId} ». Valeurs acceptées : ${RPG_ENCHANTMENTS.map((e) => e.id).join(', ')}.`, 400);
  }

  // Seuls les consommables sont bus : une récompense de module posée sur une arme ne
  // serait jamais versée, mais suffirait à retirer l'arme de la boutique.
  const moduleRewards = body.type === 'POTION'
    ? {
      levelXpReward: clampInt(body.levelXpReward ?? 0, LEVEL_XP_REWARD_RANGE, 0),
      clanPointsReward: clampInt(body.clanPointsReward ?? 0, CLAN_POINTS_REWARD_RANGE, 0),
      raidAssaultBonus: clampInt(body.raidAssaultBonus ?? 0, RAID_ASSAULT_BONUS_RANGE, 0),
    }
    : { levelXpReward: 0, clanPointsReward: 0, raidAssaultBonus: 0 };

  // Le marché noir brade de 20 à 50 % : un objet qui vend de l'XP ou des points de
  // clan en sort par défaut, le prix fixé étant justement l'équilibrage. Le choix
  // explicite du client prime, dans les deux sens.
  const blackMarketEligible = body.blackMarketEligible ?? !hasModuleReward(moduleRewards);

  // Un bonus négatif retirait des statistiques, un bonus démesuré rendait un personnage
  // invincible. Un équipement ne soigne pas et une potion ne s'équipe pas : les champs de
  // l'autre famille valent zéro.
  const equippable = slotForItemType(body.type) !== null;
  const stat = (value: number | undefined, applies: boolean) => (applies ? clampInt(value ?? 0, ITEM_STAT_RANGE, 0) : 0);

  // Rareté et niveau requis omis valent « ne change pas » : les appelants qui ne les
  // envoient pas gardent le comportement qu'ils avaient.
  const data = {
    name: body.name.trim(),
    description: body.description.trim(),
    emoji: body.emoji?.trim() || '📦',
    type: body.type,
    atkBonus: stat(body.atkBonus, equippable),
    defBonus: stat(body.defBonus, equippable),
    spdBonus: stat(body.spdBonus, equippable),
    hpBonus: stat(body.hpBonus, equippable),
    hpRestore: stat(body.hpRestore, body.type === 'POTION'),
    energyRestore: stat(body.energyRestore, body.type === 'POTION'),
    ...moduleRewards,
    ...(body.rarity !== undefined ? { rarity: body.rarity } : {}),
    ...(body.levelRequired !== undefined ? { levelRequired: clampInt(body.levelRequired, ITEM_LEVEL_RANGE, 0) } : {}),
    // Le palier est borné par le catalogue : au-delà, l'agrégation des effets rendrait
    // des valeurs que la fiche de personnage n'annonce nulle part.
    ...(enchantment
      ? { enchantId: enchantment.id, enchantTier: Math.min(Math.max(1, Math.trunc(body.enchantTier ?? 1)), enchantment.maxTier) }
      : {}),
    price: Math.trunc(price),
    purchasable: body.purchasable ?? true,
    blackMarketEligible,
    ...(typeof body.salvageable === 'boolean' ? { salvageable: body.salvageable } : {}),
  };

  const targetId = body.id ?? options.createWithId;
  const existing = targetId
    ? await prisma.rpgItem.findUnique({ where: { id: targetId }, select: { guildId: true, name: true } })
    : null;

  if (body.id && !existing) {
    throw new ShopItemError('Objet introuvable.', 404);
  }
  // Le catalogue global est partagé par tous les serveurs : sans ce contrôle, une requête
  // forgée modifiait l'objet de tout le monde.
  if (existing && existing.guildId !== guildId) {
    throw new ShopItemError('Vous ne pouvez modifier que les objets spécifiques à votre serveur.', 403);
  }

  if (!existing) {
    const item = await prisma.rpgItem.create({
      data: { ...data, guildId, ...(options.createWithId ? { id: options.createWithId } : {}) },
    });
    return { item, created: true };
  }

  const item = await prisma.rpgItem.update({ where: { id: targetId! }, data });

  // Butins et recettes désignent leur objet par son nom : le renommage doit les suivre.
  // L'objet est déjà renommé : un incident ici est journalisé, il ne rend pas
  // l'enregistrement fautif.
  if (existing.name !== item.name) {
    await syncDropReferences(guildId, existing.name, item.name).catch((err) => {
      logger.error('RpgShop', `Butins non mis à jour après le renommage de ${existing.name}:`, err);
    });
    await syncRecipeReferences(guildId, existing.name, item.name).catch((err) => {
      logger.error('RpgShop', `Recettes non mises à jour après le renommage de ${existing.name}:`, err);
    });
  }

  return { item, created: false };
}

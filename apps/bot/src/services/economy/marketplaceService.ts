import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { publishGuildSignal } from '../site/siteLive.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { equippedItemIds } from '../features/rpg/rpgEquipment.js';
import type { MarketplaceListing, Prisma, RpgItem } from '@prisma/client';
import {
  LISTING_PRICE_RANGE,
  marketplaceTax,
  SUGGESTED_PRICE_WINDOW_DAYS,
  suggestedUnitPrice,
  type SuggestedPrice,
} from './marketplacePolicy.js';
import { parseEnchants } from '../features/rpg/rpgEnchantments.js';
import {
  addInventoryQuantity,
  addItemInstance,
  freePlainCopies,
  lockRpgProfile,
  takeInventoryQuantity,
  takeItemInstance,
} from '../features/rpg/rpgInventoryWrites.js';

class MarketplacePurchaseError extends Error {}

/** Durées proposées à la mise en vente, en heures. */
export const LISTING_DURATION_RANGE = { min: 1, max: 168 } as const;

/**
 * Remet à un joueur ce que contenait une annonce : un exemplaire forgé garde sa progression,
 * des exemplaires ordinaires rejoignent sa pile.
 */
async function deliverListing(
  tx: Prisma.TransactionClient,
  rpgProfileId: string,
  listing: { itemId: string; quantity: number; upgrade?: number | null; enchants?: unknown },
): Promise<void> {
  const progression = { upgrade: listing.upgrade ?? 0, enchants: parseEnchants(listing.enchants) };
  if (progression.upgrade > 0 || progression.enchants.length > 0) {
    for (let copy = 0; copy < listing.quantity; copy++) {
      await addItemInstance(tx, rpgProfileId, listing.itemId, progression);
    }
    return;
  }
  await addInventoryQuantity(tx, rpgProfileId, listing.itemId, listing.quantity);
}

async function attachItemsToListings<T extends { itemId: string }>(listings: T[]) {
  const itemIds = [...new Set(listings.map((listing) => listing.itemId))];
  const items = itemIds.length > 0
    ? await prismaRead.rpgItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, name: true, emoji: true },
      })
    : [];
  const itemsById = new Map(items.map((item) => [item.id, item]));

  return listings.map((listing) => ({
    ...listing,
    item: itemsById.get(listing.itemId) ?? null,
  }));
}

/**
 * Met en vente des exemplaires ordinaires, ou UN exemplaire forgé désigné par `instanceId`.
 * L'exemplaire forgé part avec sa progression, que l'acheteur reçoit telle quelle.
 */
export async function createListing(guildId: string, sellerId: string, data: {
  itemId: string;
  instanceId?: string;
  quantity: number;
  price: number;
  type: 'FIXED_PRICE' | 'AUCTION';
  durationHours?: number;
}): Promise<{ success: boolean; error?: string; listing?: any }> {
  const quantity = data.instanceId ? 1 : Math.trunc(Number(data.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { success: false, error: 'La quantité doit être d\'au moins un.' };
  }
  if (!Number.isSafeInteger(data.price) || data.price < LISTING_PRICE_RANGE.min || data.price > LISTING_PRICE_RANGE.max) {
    return { success: false, error: `Le prix doit être un entier entre ${LISTING_PRICE_RANGE.min} et ${LISTING_PRICE_RANGE.max}.` };
  }

  const hours = Math.min(LISTING_DURATION_RANGE.max, Math.max(LISTING_DURATION_RANGE.min, Math.trunc(data.durationHours ?? 24)));
  const durationMs = hours * 3600000;
  const expiresAt = new Date(Date.now() + durationMs);

  try {
    const listing = await prisma.$transaction(async (tx) => {
      const found = await tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId, userId: sellerId } },
        select: { id: true },
      });
      if (!found) throw new MarketplacePurchaseError('Profil RPG introuvable.');

      // Sous verrou : l'objet a pu être équipé depuis une autre fenêtre entre-temps.
      await lockRpgProfile(tx, found.id);
      const profile = await tx.rpgProfile.findUniqueOrThrow({ where: { id: found.id } });

      let progression = { upgrade: 0, enchants: [] as ReturnType<typeof parseEnchants> };
      if (data.instanceId) {
        // Un exemplaire forgé se vend seul et désigné : l'exemplaire porté est refusé.
        const copy = await takeItemInstance(tx, profile.id, data.instanceId).catch((error: Error) => {
          throw new MarketplacePurchaseError(error.message);
        });
        if (!copy || copy.item.id !== data.itemId) throw new MarketplacePurchaseError('Cet exemplaire n\'est plus dans votre inventaire.');
        progression = { upgrade: copy.upgrade, enchants: copy.enchants };
      } else {
        // Seuls des exemplaires ordinaires que le vendeur ne porte pas partent en vente : un
        // exemplaire forgé garde sa progression et ne se confond pas avec la pile.
        if ((await freePlainCopies(tx, profile.id, data.itemId)) < quantity) {
          throw new MarketplacePurchaseError(equippedItemIds(profile).includes(data.itemId)
            ? "Cet objet est équipé : déséquipez-le d'abord, ou mettez en vente un exemplaire de moins."
            : 'Vous n\'avez pas assez d\'exemplaires ordinaires de cet objet.');
        }
        const taken = await takeInventoryQuantity(tx, profile.id, data.itemId, quantity);
        if (!taken) throw new MarketplacePurchaseError('Vous n\'avez pas assez de cet objet.');
      }

      return tx.marketplaceListing.create({
        data: {
          guildId,
          sellerId,
          itemId: data.itemId,
          quantity,
          price: data.price,
          type: data.type,
          expiresAt,
          upgrade: progression.upgrade,
          enchants: progression.enchants,
        },
      });
    });

    return { success: true, listing };
  } catch (error) {
    if (error instanceof MarketplacePurchaseError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Taux de la taxe du marché sur ce serveur, lu dans la transaction de la vente : un taux changé
 * depuis le dashboard s'applique à la vente suivante, jamais à moitié d'une vente en cours.
 */
async function readTaxPercent(tx: Prisma.TransactionClient, guildId: string): Promise<number> {
  const config = await tx.economyConfig.findUnique({ where: { guildId }, select: { marketplaceTaxPercent: true } });
  return config?.marketplaceTaxPercent ?? 0;
}

export async function buyListing(
  guildId: string,
  buyerId: string,
  listingId: string,
): Promise<{
  success: boolean;
  error?: string;
  /** Details de l'annonce achetee, utilises pour le message de confirmation. */
  listing?: { itemId: string; quantity: number; price: number; sellerId: string; tax: number };
}> {
  try {
    const purchased = await prisma.$transaction(async (tx) => {
      const listing = await tx.marketplaceListing.findFirst({
        where: { id: listingId, guildId, status: 'ACTIVE', type: 'FIXED_PRICE' },
      });

      if (!listing) throw new MarketplacePurchaseError('Annonce introuvable ou déjà vendue.');
      if (listing.sellerId === buyerId) {
        throw new MarketplacePurchaseError('Vous ne pouvez pas acheter votre propre annonce.');
      }
      if (listing.expiresAt < new Date()) {
        throw new MarketplacePurchaseError('Cette annonce a expiré.');
      }

      const buyerProfile = await tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId, userId: buyerId } },
        select: { id: true },
      });
      if (!buyerProfile) throw new MarketplacePurchaseError('Fonds insuffisants.');

      const claimed = await tx.marketplaceListing.updateMany({
        where: { id: listingId, guildId, status: 'ACTIVE', type: 'FIXED_PRICE' },
        data: { status: 'SOLD' },
      });
      if (claimed.count === 0) {
        throw new MarketplacePurchaseError('Annonce introuvable ou déjà vendue.');
      }

      const debited = await tx.rpgProfile.updateMany({
        where: { id: buyerProfile.id, balance: { gte: listing.price } },
        data: { balance: { decrement: listing.price } },
      });
      if (debited.count === 0) throw new MarketplacePurchaseError('Fonds insuffisants.');

      // L'acheteur paie le prix affiché ; le vendeur touche ce prix moins la taxe du marché.
      const tax = marketplaceTax(listing.price, await readTaxPercent(tx, guildId));
      await tx.rpgProfile.update({
        where: { guildId_userId: { guildId, userId: listing.sellerId } },
        data: { balance: { increment: listing.price - tax } },
      });
      await deliverListing(tx, buyerProfile.id, listing);
      await tx.marketplaceTransaction.create({
        data: {
          guildId,
          listingId,
          sellerId: listing.sellerId,
          buyerId,
          itemId: listing.itemId,
          quantity: listing.quantity,
          price: listing.price,
          upgrade: listing.upgrade ?? 0,
        },
      });

      return {
        itemId: listing.itemId,
        quantity: listing.quantity,
        price: listing.price,
        sellerId: listing.sellerId,
        tax,
      };
    });

    publishGuildSignal(guildId, 'module:marketplace');
    return { success: true, listing: purchased };
  } catch (error) {
    if (error instanceof MarketplacePurchaseError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Pose une enchère : débite le nouvel enchérisseur et rend sa mise au précédent.
 *
 * Tout tient dans une transaction, sur le même patron que l'achat à prix fixe juste
 * au-dessus. Le remboursement du précédent se faisait auparavant dehors et *avant* le
 * débit : un incident entre les deux lui rendait sa mise sans lui retirer sa place, et
 * l'enchère suivante le remboursait une seconde fois.
 *
 * La lecture passe par la base primaire et non la réplique : c'est une décision d'écriture,
 * et une réplique en retard ferait accepter une enchère déjà dépassée.
 */
export async function placeBid(
  guildId: string,
  bidderId: string,
  listingId: string,
  amount: number,
): Promise<{ success: boolean; error?: string; listing?: { itemId: string } }> {
  try {
    const listing = await prisma.$transaction(async (tx) => {
      const current = await tx.marketplaceListing.findFirst({
        where: { id: listingId, guildId, status: 'ACTIVE', type: 'AUCTION' },
      });

      if (!current) throw new MarketplacePurchaseError('Enchère introuvable.');
      if (current.sellerId === bidderId) {
        throw new MarketplacePurchaseError('Vous ne pouvez pas enchérir sur votre propre annonce.');
      }
      if (current.expiresAt < new Date()) throw new MarketplacePurchaseError('Cette enchère a expiré.');

      const minBid = (current.currentBid ?? current.price) + 1;
      if (amount < minBid) {
        throw new MarketplacePurchaseError(`L'enchère minimum est de ${minBid} coins.`);
      }

      // L'annonce doit être restée dans l'état qui a servi à décider. Sans cette
      // condition, deux enchères simultanées passent le contrôle ensemble, se débitent
      // toutes les deux, et la seconde écrase la première - dont la mise n'est alors
      // rendue par personne.
      const claimed = await tx.marketplaceListing.updateMany({
        where: {
          id: listingId,
          status: 'ACTIVE',
          currentBid: current.currentBid,
          bidderId: current.bidderId,
        },
        data: { currentBid: amount, bidderId },
      });
      if (claimed.count === 0) {
        throw new MarketplacePurchaseError('Quelqu\'un vient de surenchérir : reprenez au montant affiché.');
      }

      // Débit conditionnel, comme à l'achat : un solde lu puis décrémenté sans garde peut
      // passer sous zéro entre les deux.
      const debited = await tx.rpgProfile.updateMany({
        where: { guildId, userId: bidderId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (debited.count === 0) throw new MarketplacePurchaseError('Fonds insuffisants.');

      if (current.bidderId && current.currentBid) {
        await tx.rpgProfile.updateMany({
          where: { guildId, userId: current.bidderId },
          data: { balance: { increment: current.currentBid } },
        });
      }

      return { itemId: current.itemId };
    });

    return { success: true, listing };
  } catch (error) {
    if (error instanceof MarketplacePurchaseError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Retire une annonce : l'objet revient au vendeur, la mise en cours à l'enchérisseur.
 *
 * L'annonce est réclamée avant tout mouvement. Sans ça, deux clics sur « annuler » -
 * l'annonce n'étant fermée qu'à la fin - rendaient l'objet deux fois et remboursaient
 * l'enchérisseur deux fois : une duplication d'objet à la portée d'un double-clic.
 */
export async function cancelListing(
  guildId: string,
  userId: string,
  listingId: string,
): Promise<{ success: boolean; error?: string; listing?: { itemId: string } }> {
  try {
    const cancelled = await prisma.$transaction(async (tx) => {
      const listing = await tx.marketplaceListing.findFirst({
        where: { id: listingId, guildId, sellerId: userId, status: 'ACTIVE' },
      });
      if (!listing) throw new MarketplacePurchaseError('Annonce introuvable.');

      const claimed = await tx.marketplaceListing.updateMany({
        where: { id: listingId, status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      });
      if (claimed.count === 0) throw new MarketplacePurchaseError('Annonce introuvable.');

      if (listing.bidderId && listing.currentBid) {
        await tx.rpgProfile.updateMany({
          where: { guildId, userId: listing.bidderId },
          data: { balance: { increment: listing.currentBid } },
        });
      }

      const seller = await tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
        select: { id: true },
      });
      if (seller) await deliverListing(tx, seller.id, listing);

      return { itemId: listing.itemId };
    });

    return { success: true, listing: cancelled };
  } catch (error) {
    if (error instanceof MarketplacePurchaseError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

type ExpiredListing = {
  id: string;
  guildId: string;
  sellerId: string;
  bidderId: string | null;
  currentBid: number | null;
  itemId: string;
  quantity: number;
  upgrade?: number | null;
  enchants?: unknown;
};

/**
 * Solde une enchère remportée : le vendeur touche la mise moins la taxe du marché, l'acheteur reçoit l'objet.
 *
 * Le tout dans une transaction, réclamation de l'annonce comprise : un simple `update` du
 * statut laissait deux passages du cycle payer le vendeur deux fois, et la remise de
 * l'objet, faite après coup, pouvait échouer sur un acheteur qui avait déjà payé.
 */
async function settleAuction(listing: ExpiredListing & { bidderId: string; currentBid: number }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.marketplaceListing.updateMany({
      where: { id: listing.id, status: 'ACTIVE' },
      data: { status: 'SOLD' },
    });
    if (claimed.count === 0) return;

    const [seller, buyer] = await Promise.all([
      tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId: listing.guildId, userId: listing.sellerId } },
        select: { id: true },
      }),
      tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId: listing.guildId, userId: listing.bidderId } },
        select: { id: true },
      }),
    ]);

    // Vendeur disparu : la vente ne peut pas se conclure. La mise revient à
    // l'enchérisseur plutôt que de rester gelée, et l'annonce se ferme au lieu d'être
    // reprise en échec à chaque tour du cycle.
    if (!seller) {
      if (buyer) {
        await tx.rpgProfile.update({
          where: { id: buyer.id },
          data: { balance: { increment: listing.currentBid } },
        });
      }
      await tx.marketplaceListing.updateMany({ where: { id: listing.id }, data: { status: 'EXPIRED' } });
      logger.warn('Marketplace', `Vendeur introuvable pour l'enchère ${listing.id} : mise rendue.`);
      return;
    }

    const tax = marketplaceTax(listing.currentBid, await readTaxPercent(tx, listing.guildId));
    await tx.rpgProfile.update({
      where: { id: seller.id },
      data: { balance: { increment: listing.currentBid - tax } },
    });

    if (buyer) {
      await deliverListing(tx, buyer.id, listing);
    } else {
      // L'acheteur a payé au moment d'enchérir : sans profil, l'objet n'a nulle part où
      // aller, mais la vente reste due au vendeur.
      logger.warn('Marketplace', `Acheteur introuvable pour l'enchère ${listing.id} : objet non remis.`);
    }

    await tx.marketplaceTransaction.create({
      data: {
        guildId: listing.guildId,
        listingId: listing.id,
        sellerId: listing.sellerId,
        buyerId: listing.bidderId,
        itemId: listing.itemId,
        quantity: listing.quantity,
        price: listing.currentBid,
        upgrade: listing.upgrade ?? 0,
      },
    });
  });
}

/** Rend l'objet à son vendeur : annonce non vendue, ou enchère sans le moindre pari. */
async function returnListingToSeller(listing: ExpiredListing): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.marketplaceListing.updateMany({
      where: { id: listing.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    if (claimed.count === 0) return;

    const seller = await tx.rpgProfile.findUnique({
      where: { guildId_userId: { guildId: listing.guildId, userId: listing.sellerId } },
      select: { id: true },
    });
    if (!seller) {
      logger.warn('Marketplace', `Vendeur introuvable pour l'annonce ${listing.id} : objet non rendu.`);
      return;
    }

    await deliverListing(tx, seller.id, listing);
  });
}

export async function processExpiredListings(guildId?: string): Promise<void> {
  const expired = await prisma.marketplaceListing.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { lt: new Date() },
      ...(guildId ? { guildId } : {}),
    },
  });

  for (const listing of expired) {
    try {
      // Une enchère qui se clôture toute seule déplacerait de la monnaie sur un
      // serveur qui a coupé le marché.
      if (!(await isModuleEnabled(listing.guildId, 'marketplace'))) continue;

      if (listing.type === 'AUCTION' && listing.bidderId && listing.currentBid) {
        await settleAuction({ ...listing, bidderId: listing.bidderId, currentBid: listing.currentBid });
      } else {
        await returnListingToSeller(listing);
      }
    } catch (error) {
      logger.error('Marketplace', `Erreur traitement expiration listing ${listing.id}:`, error);
    }
  }
}

export async function getActiveListings(guildId: string, page = 0, limit = 20) {
  const [rawListings, total] = await Promise.all([
    prismaRead.marketplaceListing.findMany({
      where: { guildId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      skip: page * limit,
      take: limit,
    }),
    prismaRead.marketplaceListing.count({
      where: { guildId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    }),
  ]);
  const listings = await attachItemsToListings(rawListings);

  return { listings, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getTransactionHistory(guildId: string, userId?: string, limit = 30) {
  const where: any = { guildId };
  if (userId) where.OR = [{ sellerId: userId }, { buyerId: userId }];

  return prismaRead.marketplaceTransaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function getMarketplaceDashboardData(guildId: string) {
  const [active, recent, totalTransactions, totalVolume] = await Promise.all([
    getActiveListings(guildId, 0, 50),
    getTransactionHistory(guildId, undefined, 30),
    prismaRead.marketplaceTransaction.count({ where: { guildId } }),
    prismaRead.marketplaceTransaction.aggregate({
      where: { guildId },
      _sum: { price: true },
    }),
  ]);

  return {
    activeListings: active.listings,
    recentTransactions: await attachItemsToListings(recent),
    totalTransactions,
    totalVolume: totalVolume._sum.price ?? 0,
  };
}

/** Prix unitaire proposé à la mise en vente d'un objet, au niveau de forge donné. */
export async function getSuggestedPrice(guildId: string, itemId: string, upgrade: number): Promise<SuggestedPrice> {
  const since = new Date(Date.now() - SUGGESTED_PRICE_WINDOW_DAYS * 24 * 3600000);
  const [samples, item] = await Promise.all([
    prismaRead.marketplaceTransaction.findMany({
      where: { guildId, itemId, upgrade, createdAt: { gte: since } },
      select: { price: true, quantity: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prismaRead.rpgItem.findUnique({ where: { id: itemId }, select: { price: true } }),
  ]);
  return suggestedUnitPrice(samples, item?.price ?? 0, upgrade);
}

export type MarketListing = {
  id: string;
  sellerId: string;
  itemId: string;
  quantity: number;
  type: 'FIXED_PRICE' | 'AUCTION';
  price: number;
  currentBid: number | null;
  bidderId: string | null;
  expiresAt: Date;
  upgrade: number;
  enchants: ReturnType<typeof parseEnchants>;
  item: RpgItem | null;
};

async function withFullItems(listings: MarketplaceListing[]): Promise<MarketListing[]> {
  const itemIds = [...new Set(listings.map((listing) => listing.itemId))];
  const items = itemIds.length > 0 ? await prismaRead.rpgItem.findMany({ where: { id: { in: itemIds } } }) : [];
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return listings.map((listing) => ({
    id: listing.id,
    sellerId: listing.sellerId,
    itemId: listing.itemId,
    quantity: listing.quantity,
    type: listing.type,
    price: listing.price,
    currentBid: listing.currentBid,
    bidderId: listing.bidderId,
    expiresAt: listing.expiresAt,
    upgrade: listing.upgrade,
    enchants: parseEnchants(listing.enchants),
    item: itemsById.get(listing.itemId) ?? null,
  }));
}

/**
 * Annonces actives du panneau `/market`, d'un type (boutique ou enchères), filtrées par
 * famille d'objet. Les plus récentes d'abord ; `sellerId` réduit aux annonces d'un joueur.
 */
export async function getMarketListings(guildId: string, options: {
  type?: 'FIXED_PRICE' | 'AUCTION';
  itemType?: string;
  sellerId?: string;
  page: number;
  pageSize: number;
}): Promise<{ listings: MarketListing[]; total: number }> {
  const where: Prisma.MarketplaceListingWhereInput = {
    guildId,
    status: 'ACTIVE',
    expiresAt: { gt: new Date() },
    ...(options.type ? { type: options.type } : {}),
    ...(options.sellerId ? { sellerId: options.sellerId } : {}),
  };
  // Le type d'objet vit sur `RpgItem`, sans relation depuis l'annonce : on passe par les
  // identifiants des objets de ce type.
  if (options.itemType) {
    const ids = await prismaRead.rpgItem.findMany({ where: { type: options.itemType }, select: { id: true } });
    where.itemId = { in: ids.map((item) => item.id) };
  }

  // Base primaire : l'étal se réaffiche juste après un achat ou un retrait, qu'une réplique
  // en retard montrerait encore.
  const [rows, total] = await Promise.all([
    prisma.marketplaceListing.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: options.page * options.pageSize,
      take: options.pageSize,
    }),
    prisma.marketplaceListing.count({ where }),
  ]);
  return { listings: await withFullItems(rows), total };
}

/** Annonce encore ouverte : une annonce vendue, retirée ou expirée ne se montre plus. */
export async function getMarketListing(guildId: string, listingId: string): Promise<MarketListing | null> {
  // Base primaire : juste après une enchère ou un achat, une réplique en retard montrerait
  // encore l'état d'avant.
  const row = await prisma.marketplaceListing.findFirst({ where: { id: listingId, guildId, status: 'ACTIVE' } });
  if (!row) return null;
  return (await withFullItems([row]))[0] ?? null;
}

/** Dernières ventes conclues par un joueur, en tant que vendeur. */
export async function getRecentSales(guildId: string, sellerId: string, limit = 5) {
  const sales = await prismaRead.marketplaceTransaction.findMany({
    where: { guildId, sellerId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return attachItemsToListings(sales);
}

export type SellableCopy = {
  item: RpgItem;
  /** `null` pour des exemplaires ordinaires, sinon l'exemplaire forgé désigné. */
  instanceId: string | null;
  upgrade: number;
  enchants: ReturnType<typeof parseEnchants>;
  /** Exemplaires disponibles : ordinaires non portés, ou 1 pour un exemplaire forgé. */
  available: number;
};

/**
 * Ce qu'un joueur peut mettre en vente : ses exemplaires ordinaires non portés, et chacun de
 * ses exemplaires forgés qu'il ne porte pas. Les plus précieux d'abord.
 */
export async function getMarketSellableCopies(guildId: string, userId: string): Promise<SellableCopy[]> {
  // Base primaire : la liste se relit juste après une vente ou un équipement.
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    include: { inventory: { where: { quantity: { gt: 0 } }, include: { item: true } } },
  });
  if (!profile) return [];

  const instances = await prisma.rpgItemInstance.findMany({ where: { rpgProfileId: profile.id } });
  const worn = new Set(equippedItemIds(profile));
  const copies: SellableCopy[] = [];

  for (const entry of profile.inventory) {
    const forged = instances.filter((instance) => instance.itemId === entry.itemId);
    const wornForged = worn.has(entry.itemId) && forged.some((instance) => instance.equipped);
    const plainFree = entry.quantity - forged.length - (worn.has(entry.itemId) && !wornForged ? 1 : 0);
    if (plainFree > 0) {
      copies.push({ item: entry.item, instanceId: null, upgrade: 0, enchants: [], available: plainFree });
    }
    for (const instance of forged) {
      if (worn.has(entry.itemId) && instance.equipped) continue;
      copies.push({
        item: entry.item,
        instanceId: instance.id,
        upgrade: instance.upgrade,
        enchants: parseEnchants(instance.enchants),
        available: 1,
      });
    }
  }

  return copies.sort((a, b) =>
    b.item.price * (1 + b.upgrade) - a.item.price * (1 + a.upgrade)
    || a.item.name.localeCompare(b.item.name));
}

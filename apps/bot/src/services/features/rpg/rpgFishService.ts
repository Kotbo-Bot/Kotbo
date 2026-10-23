/**
 * Espèces de poisson d'un serveur : lecture du catalogue effectif et édition.
 *
 * Toute lecture côté jeu passe par `getGuildFishCatalog` : les espèces livrées vivent dans
 * le code, et seule la fusion avec les lignes du serveur dit ce qui se pêche vraiment ici.
 *
 * Le nom d'une espèce est la clé de ses prises (`RpgFishCatch.fishName`). Il est donc
 * verrouillé sur une espèce livrée, et renommer une création du serveur renomme aussi ses
 * prises : sans ça, les joueurs perdraient la ligne du carnet qu'ils avaient remplie.
 */

import type { RpgFish } from '@prisma/client';
import prisma from '../../../utils/db.js';
import {
  DEFAULT_FISH,
  FISH_GUILD_CREATED_MAX,
  isDefaultFishName,
  normalizeFishInput,
  resolveFishCatalog,
  type FishInput,
  type FishRarity,
  type ResolvedFish,
} from './rpgFishCatalog.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

export class FishCatalogError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'FishCatalogError';
  }
}

const DEFAULT_KEY_PREFIX = 'default:';

/**
 * Clé d'une espèce pour le dashboard et MCP : l'identifiant de sa ligne, ou `default:<nom>`
 * pour une espèce livrée que le serveur n'a jamais touchée et qui n'a donc pas de ligne.
 */
export function fishKey(fish: Pick<ResolvedFish, 'id' | 'name'>): string {
  return fish.id ?? `${DEFAULT_KEY_PREFIX}${fish.name}`;
}

function toRow(row: RpgFish) {
  return { ...row, rarity: row.rarity as FishRarity };
}

/** Catalogue du serveur, espèces désactivées comprises. */
export async function getGuildFishCatalog(guildId: string): Promise<ResolvedFish[]> {
  const rows = await prisma.rpgFish.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } });
  return resolveFishCatalog(rows.map(toRow));
}

/** Espèces qui se pêchent réellement sur le serveur. */
export async function listActiveFish(guildId: string): Promise<ResolvedFish[]> {
  return (await getGuildFishCatalog(guildId)).filter((fish) => fish.enabled);
}

type Target = { row: RpgFish | null; defaultName: string | null };

async function findTarget(guildId: string, key: string): Promise<Target> {
  if (key.startsWith(DEFAULT_KEY_PREFIX)) {
    const name = key.slice(DEFAULT_KEY_PREFIX.length);
    if (!isDefaultFishName(name)) throw new FishCatalogError('Poisson introuvable.', 404);
    const row = await prisma.rpgFish.findUnique({ where: { guildId_name: { guildId, name } } });
    return { row, defaultName: name };
  }

  const row = await prisma.rpgFish.findUnique({ where: { id: key } });
  if (!row) throw new FishCatalogError('Poisson introuvable.', 404);
  if (row.guildId !== guildId) throw new FishCatalogError('Ce poisson appartient à un autre serveur.', 403);
  return { row, defaultName: isDefaultFishName(row.name) ? row.name : null };
}

async function assertNameIsFree(guildId: string, name: string, exceptId?: string): Promise<void> {
  if (isDefaultFishName(name)) {
    throw new FishCatalogError(`Une espèce livrée de base se nomme déjà « ${name} » : personnalisez-la au lieu d'en créer une seconde.`, 409);
  }
  const twin = await prisma.rpgFish.findUnique({ where: { guildId_name: { guildId, name } }, select: { id: true } });
  if (twin && twin.id !== exceptId) throw new FishCatalogError(`Un poisson de ce serveur se nomme déjà « ${name} ».`, 409);
}

/**
 * Crée une espèce (sans `key`) ou modifie celle que `key` désigne.
 *
 * Modifier une espèce livrée dépose une ligne du serveur à son nom, qui la remplace.
 */
export async function saveGuildFish(guildId: string, input: FishInput, key?: string): Promise<{ fish: RpgFish; created: boolean }> {
  const normalized = normalizeFishInput(input);
  if (!normalized.ok) throw new FishCatalogError(normalized.error, 400);
  const data = normalized.value;

  if (!key) {
    await assertNameIsFree(guildId, data.name);
    const created = await prisma.rpgFish.count({ where: { guildId, name: { notIn: DEFAULT_FISH.map((fish) => fish.name) } } });
    if (created >= FISH_GUILD_CREATED_MAX) {
      throw new FishCatalogError(`Un serveur ne peut pas créer plus de ${FISH_GUILD_CREATED_MAX} espèces : désactivez ou supprimez-en une d'abord.`, 400);
    }
    const fish = await prisma.rpgFish.create({ data: { guildId, ...data } });
    return { fish, created: true };
  }

  const target = await findTarget(guildId, key);

  if (target.defaultName) {
    if (data.name !== target.defaultName) {
      throw new FishCatalogError("Le nom d'une espèce livrée de base ne peut pas être changé : les prises des joueurs y sont rattachées.", 400);
    }
    const fish = await prisma.rpgFish.upsert({
      where: { guildId_name: { guildId, name: target.defaultName } },
      create: { guildId, ...data },
      update: data,
    });
    return { fish, created: false };
  }

  const row = target.row!;
  if (data.name === row.name) {
    const fish = await prisma.rpgFish.update({ where: { id: row.id }, data });
    return { fish, created: false };
  }

  await assertNameIsFree(guildId, data.name, row.id);
  const fish = await prisma.$transaction(async (tx) => {
    await tx.rpgFishCatch.updateMany({
      where: { guildId, fishName: row.name },
      data: { fishName: data.name, fishEmoji: data.emoji },
    });
    return tx.rpgFish.update({ where: { id: row.id }, data });
  });
  return { fish, created: false };
}

export async function setGuildFishEnabled(guildId: string, key: string, enabled: boolean): Promise<RpgFish> {
  const target = await findTarget(guildId, key);
  if (target.row) return prisma.rpgFish.update({ where: { id: target.row.id }, data: { enabled } });

  const base = DEFAULT_FISH.find((fish) => fish.name === target.defaultName)!;
  return prisma.rpgFish.create({ data: { guildId, ...base, enabled } });
}

/**
 * Supprime une ligne du serveur. Sur une espèce livrée, cela rend l'original ; sur une
 * création, l'espèce quitte le carnet mais ses prises restent comptées dans le total.
 */
export async function deleteGuildFish(guildId: string, key: string): Promise<{ fish: RpgFish; restoredDefault: boolean }> {
  const target = await findTarget(guildId, key);
  if (!target.row) {
    throw new FishCatalogError("Une espèce livrée de base ne peut pas être supprimée : désactivez-la pour la retirer de ce serveur.", 403);
  }
  await prisma.rpgFish.delete({ where: { id: target.row.id } });
  return { fish: target.row, restoredDefault: target.defaultName !== null };
}

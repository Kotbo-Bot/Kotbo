/**
 * Titres du RPG : catalogue du serveur, collection des joueurs, titre porté.
 */

import type { Prisma, RpgTitle } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { NO_PERMANENT_BONUSES, type PermanentBonuses } from './rpgStats.js';
import { normalizeTitleInput, type TitleInput } from './rpgTitlePolicy.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

export class TitleError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TitleError';
  }
}

/** Titres du serveur, avec le nombre de joueurs qui possèdent chacun. */
export async function listGuildTitles(guildId: string) {
  const titles = await prisma.rpgTitle.findMany({
    where: { guildId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { owners: true } } },
  });
  return titles.map(({ _count, ...title }) => ({ ...title, ownerCount: _count.owners }));
}

async function assertTitleNameIsFree(guildId: string, name: string, exceptId?: string): Promise<void> {
  const twin = await prisma.rpgTitle.findFirst({
    where: { guildId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (twin) throw new TitleError(`Un titre se nomme déjà « ${name} ».`, 409);
}

export async function saveGuildTitle(
  guildId: string,
  input: TitleInput,
  titleId?: string,
): Promise<{ title: RpgTitle; created: boolean }> {
  const normalized = normalizeTitleInput(input);
  if (!normalized.ok) throw new TitleError(normalized.error, 400);
  const data = normalized.value;

  if (!titleId) {
    await assertTitleNameIsFree(guildId, data.name);
    const title = await prisma.rpgTitle.create({ data: { guildId, ...data } });
    return { title, created: true };
  }

  const existing = await prisma.rpgTitle.findUnique({ where: { id: titleId }, select: { guildId: true } });
  if (!existing || existing.guildId !== guildId) throw new TitleError('Titre introuvable.', 404);
  await assertTitleNameIsFree(guildId, data.name, titleId);

  const title = await prisma.rpgTitle.update({ where: { id: titleId }, data });
  return { title, created: false };
}

/**
 * Supprime un titre.
 *
 * Les joueurs le perdent de leur collection, ceux qui le portaient n'en portent plus, et
 * les créatures qui l'offraient n'offrent plus rien : les clés étrangères s'en chargent.
 * Les choix d'aventure, eux, vivent dans une colonne JSON sans clé étrangère : on les
 * nettoie à la main, sans quoi l'aventure ne pourrait plus être enregistrée au dashboard.
 */
export async function deleteGuildTitle(guildId: string, titleId: string): Promise<RpgTitle> {
  const existing = await prisma.rpgTitle.findUnique({ where: { id: titleId } });
  if (!existing || existing.guildId !== guildId) throw new TitleError('Titre introuvable.', 404);

  const cleanup = await adventureTitleCleanup(guildId, new Set([titleId]));
  await prisma.$transaction([...cleanup, prisma.rpgTitle.delete({ where: { id: titleId } })]);
  return existing;
}

/** Tous les titres du serveur, pour la remise à zéro complète de l'économie. */
export async function deleteAllGuildTitles(guildId: string): Promise<void> {
  const titles = await prisma.rpgTitle.findMany({ where: { guildId }, select: { id: true } });
  if (titles.length === 0) return;

  const cleanup = await adventureTitleCleanup(guildId, new Set(titles.map((title) => title.id)));
  await prisma.$transaction([...cleanup, prisma.rpgTitle.deleteMany({ where: { guildId } })]);
}

/** Écritures qui retirent ces titres des choix d'aventure du serveur. */
async function adventureTitleCleanup(guildId: string, titleIds: Set<string>) {
  const events = await prisma.rpgAdventureEvent.findMany({ where: { guildId }, select: { id: true, choices: true } });
  const removed = (choice: Record<string, unknown>) => typeof choice?.titleId === 'string' && titleIds.has(choice.titleId);

  return events.flatMap((event) => {
    if (!Array.isArray(event.choices)) return [];
    const choices = event.choices as Record<string, unknown>[];
    if (!choices.some(removed)) return [];
    const cleaned = choices.map((choice) => (removed(choice) ? { ...choice, titleId: null } : choice));
    return [prisma.rpgAdventureEvent.update({ where: { id: event.id }, data: { choices: cleaned as Prisma.InputJsonValue } })];
  });
}

/** Le titre appartient-il à ce serveur ? Sert à valider une récompense de créature. */
export async function assertGuildTitle(guildId: string, titleId: string | null | undefined): Promise<void> {
  if (!titleId) return;
  const title = await prisma.rpgTitle.findUnique({ where: { id: titleId }, select: { guildId: true } });
  if (!title || title.guildId !== guildId) throw new TitleError('Ce titre n\'existe pas sur ce serveur.', 400);
}

/**
 * Ajoute un titre à la collection d'un joueur.
 *
 * Renvoie le titre s'il vient d'être obtenu, `null` s'il l'avait déjà ou s'il n'existe plus.
 * Le premier titre obtenu est porté d'office : sans ça, le joueur ne verrait rien changer
 * sur sa carte et ne saurait pas qu'il existe un écran pour le choisir.
 */
export async function grantTitle(profileId: string, titleId: string): Promise<RpgTitle | null> {
  const title = await prisma.rpgTitle.findUnique({ where: { id: titleId } });
  if (!title) return null;

  // `skipDuplicates` : un titre de victoire est proposé à chaque combat gagné, et un refus
  // d'unicité rattrapé finirait quand même dans les journaux, où Prisma consigne ses erreurs.
  const inserted = await prisma.rpgProfileTitle.createMany({ data: [{ profileId, titleId }], skipDuplicates: true });
  if (inserted.count === 0) return null;

  await prisma.rpgProfile.updateMany({
    where: { id: profileId, activeTitleId: null },
    data: { activeTitleId: titleId },
  });
  return title;
}

export async function revokeTitle(profileId: string, titleId: string): Promise<boolean> {
  const removed = await prisma.rpgProfileTitle.deleteMany({ where: { profileId, titleId } });
  if (removed.count === 0) return false;
  await prisma.rpgProfile.updateMany({ where: { id: profileId, activeTitleId: titleId }, data: { activeTitleId: null } });
  return true;
}

/** Titre gagné en battant une créature : ajouté à la collection s'il n'y était pas encore. */
export async function grantWinTitle(guildId: string, userId: string, titleId: string | null): Promise<RpgTitle | null> {
  if (!titleId) return null;
  const profile = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { id: true } });
  return profile ? grantTitle(profile.id, titleId) : null;
}

/** Titres possédés par un joueur, du plus récent au plus ancien. */
export async function listOwnedTitles(profileId: string) {
  const rows = await prisma.rpgProfileTitle.findMany({
    where: { profileId },
    orderBy: { obtainedAt: 'desc' },
    include: { title: true },
  });
  return rows.map((row) => ({ ...row.title, obtainedAt: row.obtainedAt }));
}

/** Porte un titre possédé, ou n'en porte plus aucun avec `null`. */
export async function setActiveTitle(profileId: string, titleId: string | null): Promise<RpgTitle | null> {
  if (titleId === null) {
    await prisma.rpgProfile.update({ where: { id: profileId }, data: { activeTitleId: null } });
    return null;
  }

  const owned = await prisma.rpgProfileTitle.findUnique({
    where: { profileId_titleId: { profileId, titleId } },
    include: { title: true },
  });
  if (!owned) throw new TitleError('Vous ne possédez pas ce titre.', 400);

  await prisma.rpgProfile.update({ where: { id: profileId }, data: { activeTitleId: titleId } });
  return owned.title;
}

/** Bonus permanents du titre porté, prêts à s'ajouter à ceux de l'arbre et du village. */
export async function loadActiveTitleBonuses(activeTitleId: string | null | undefined): Promise<PermanentBonuses> {
  if (!activeTitleId) return NO_PERMANENT_BONUSES;
  const title = await prisma.rpgTitle.findUnique({ where: { id: activeTitleId } });
  if (!title) return NO_PERMANENT_BONUSES;

  return {
    ...NO_PERMANENT_BONUSES,
    attackFlat: title.attackBonus,
    defenseFlat: title.defenseBonus,
    speedFlat: title.speedBonus,
    maxHealthFlat: title.healthBonus,
    critChance: title.critBonus / 100,
  };
}

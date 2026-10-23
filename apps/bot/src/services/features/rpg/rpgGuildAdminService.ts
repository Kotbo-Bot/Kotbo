/**
 * Administration des guildes RPG depuis le dashboard.
 *
 * Le jeu ne laisse agir que le chef, et seulement sur sa propre guilde : sans ces
 * fonctions, une guilde abandonnée par son chef, au nom injurieux ou au trésor corrompu ne
 * pouvait se corriger qu'en réinitialisant toutes les guildes du serveur.
 */

import prisma from '../../../utils/db.js';
import { guildMemberCapacity, prepareGuildEdit } from './rpgGuildDirectoryService.js';
import { currentTier, getGuildBuilding } from './rpgGuildBuildings.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

export const RPG_GUILD_TREASURY_RANGE = { min: 0, max: 100_000_000 };

export class RpgGuildAdminError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RpgGuildAdminError';
  }
}

async function findGuild(guildId: string, rpgGuildId: string) {
  const rpgGuild = await prisma.rpgGuild.findUnique({
    where: { id: rpgGuildId },
    include: { members: { select: { userId: true } } },
  });
  if (!rpgGuild || rpgGuild.guildId !== guildId) {
    throw new RpgGuildAdminError('Guilde introuvable.', 404);
  }
  return rpgGuild;
}

/** Guildes du serveur avec leurs membres et leur village, pour la page d'administration. */
export async function listRpgGuildsForAdmin(guildId: string) {
  const guilds = await prisma.rpgGuild.findMany({
    where: { guildId },
    orderBy: [{ level: 'desc' }, { xp: 'desc' }],
    include: {
      members: {
        select: { userId: true, level: true, xp: true },
        orderBy: [{ level: 'desc' }, { xp: 'desc' }],
      },
      buildings: { select: { buildingId: true, level: true } },
    },
  });

  return guilds.map((rpgGuild) => ({
    id: rpgGuild.id,
    name: rpgGuild.name,
    description: rpgGuild.description,
    emoji: rpgGuild.emoji,
    ownerId: rpgGuild.ownerId,
    level: rpgGuild.level,
    xp: rpgGuild.xp,
    treasury: rpgGuild.treasury,
    createdAt: rpgGuild.createdAt,
    capacity: guildMemberCapacity(rpgGuild.level),
    members: rpgGuild.members,
    // Un bâtiment retiré du catalogue laisse une ligne inerte : elle n'a rien à afficher.
    buildings: rpgGuild.buildings.flatMap((built) => {
      const building = getGuildBuilding(built.buildingId);
      if (!building) return [];
      return [{
        id: building.id,
        name: building.name,
        emoji: building.emoji,
        level: built.level,
        maxLevel: building.tiers.length,
        effect: currentTier(building, built.level)?.effect ?? null,
      }];
    }),
  }));
}

export type RpgGuildAdminEdit = {
  name?: string;
  description?: string;
  emoji?: string;
  treasury?: number;
  ownerId?: string;
};

/**
 * Modifie une guilde : fiche, trésor, chef.
 *
 * Le nouveau chef doit déjà en être membre : nommer quelqu'un d'extérieur lui donnerait
 * les droits d'une guilde dont il ne verrait même pas le panneau.
 */
export async function adminUpdateRpgGuild(guildId: string, rpgGuildId: string, edit: RpgGuildAdminEdit) {
  const rpgGuild = await findGuild(guildId, rpgGuildId);

  let data: Record<string, unknown>;
  try {
    data = await prepareGuildEdit(guildId, rpgGuild, {
      name: edit.name,
      description: edit.description,
      emoji: edit.emoji,
    });
  } catch (err) {
    throw new RpgGuildAdminError(err instanceof Error ? err.message : String(err), 400);
  }

  if (edit.treasury !== undefined) {
    const treasury = Number(edit.treasury);
    if (!Number.isInteger(treasury) || treasury < RPG_GUILD_TREASURY_RANGE.min || treasury > RPG_GUILD_TREASURY_RANGE.max) {
      throw new RpgGuildAdminError(`Le trésor doit être un entier entre ${RPG_GUILD_TREASURY_RANGE.min} et ${RPG_GUILD_TREASURY_RANGE.max}.`, 400);
    }
    data.treasury = treasury;
  }

  if (edit.ownerId !== undefined && edit.ownerId !== rpgGuild.ownerId) {
    if (!rpgGuild.members.some((member) => member.userId === edit.ownerId)) {
      throw new RpgGuildAdminError('Le nouveau chef doit être membre de la guilde.', 400);
    }
    data.ownerId = edit.ownerId;
  }

  if (Object.keys(data).length === 0) {
    throw new RpgGuildAdminError('Rien à modifier.', 400);
  }

  const updated = await prisma.rpgGuild.update({ where: { id: rpgGuild.id }, data });
  return { before: rpgGuild, after: updated };
}

/** Retire un membre de sa guilde. Le chef ne se retire pas : il faut d'abord en nommer un autre. */
export async function adminRemoveRpgGuildMember(guildId: string, rpgGuildId: string, userId: string) {
  const rpgGuild = await findGuild(guildId, rpgGuildId);
  if (rpgGuild.ownerId === userId) {
    throw new RpgGuildAdminError('Le chef ne peut pas être retiré : nommez d’abord un autre chef, ou dissolvez la guilde.', 400);
  }

  const removed = await prisma.rpgProfile.updateMany({
    where: { guildId, userId, rpgGuildId: rpgGuild.id },
    data: { rpgGuildId: null },
  });
  if (removed.count === 0) {
    throw new RpgGuildAdminError('Ce membre ne fait pas partie de la guilde.', 404);
  }

  return { guildName: rpgGuild.name };
}

/**
 * Dissout une guilde.
 *
 * Les membres sont détachés par la relation (`onDelete: SetNull`) et gardent tout le reste
 * de leur profil. Le trésor et le village disparaissent avec la guilde.
 */
export async function adminDissolveRpgGuild(guildId: string, rpgGuildId: string) {
  const rpgGuild = await findGuild(guildId, rpgGuildId);
  await prisma.rpgGuild.delete({ where: { id: rpgGuild.id } });
  return { name: rpgGuild.name, members: rpgGuild.members.length, treasury: rpgGuild.treasury };
}

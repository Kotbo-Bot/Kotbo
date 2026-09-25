/**
 * Premier vainqueur d'une créature sur un serveur.
 *
 * Le record s'écrit pour toute créature, prime ou non : c'est lui qui dit, dans le bestiaire
 * et au dashboard, qui a ouvert la voie. La prime et l'annonce n'en sont que des options.
 */

import { EmbedBuilder, type Client, type Guild, type Role } from 'discord.js';
import { roleGrantsAdministrator } from '../../../utils/adminLockPermissions.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { COLORS } from '../../../utils/embeds.js';
import { resolveGuildLocale, type BotLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';
import { checkLevelUp, getOrCreateEconomyConfig } from '../economyService.js';
import { hasFirstKillReward, shouldAnnounceFirstKill } from './rpgBestiaryPolicy.js';
import { awardRpgTeamPoints } from './rpgTeamRewards.js';
import { asRpgTeamMode } from './rpgTeamResolver.js';
import { grantTitle } from './rpgTitleService.js';

export type FirstKillMonster = {
  name: string;
  emoji: string;
  isBoss: boolean;
  firstKillCoinReward: number;
  firstKillXpReward: number;
  firstKillItemName: string | null;
  firstKillClanPoints: number;
  firstKillRoleId: string | null;
  firstKillTitleId: string | null;
};

export type FirstKillResult = {
  coins: number;
  xp: number;
  itemName: string | null;
  itemEmoji: string | null;
  /** Points réellement versés : zéro si le joueur n'a ni clan ni guilde. */
  teamPoints: number;
  toGuild: boolean;
  /** Rôle réellement attribué, `null` s'il n'y en avait pas ou s'il a été refusé. */
  roleId: string | null;
  /** Titre ajouté à la collection du joueur. */
  titleName: string | null;
};

export type FirstKillRecord = { userId: string; createdAt: Date };

/**
 * Inscrit le joueur comme premier vainqueur et lui verse la prime.
 *
 * Renvoie `null` si quelqu'un l'a devancé. L'unicité (serveur, nom) tranche entre deux
 * victoires simultanées : seule la première insertion passe, et donc seule elle paie.
 */
export async function claimFirstKill(
  client: Client,
  guildId: string,
  userId: string,
  monster: FirstKillMonster,
): Promise<FirstKillResult | null> {
  // Presque toutes les victoires portent sur une créature déjà battue : elles s'arrêtent
  // ici, sur une lecture, sans chercher l'objet ni ouvrir de transaction.
  const known = await prisma.rpgMonsterFirstKill.findUnique({
    where: { guildId_monsterName: { guildId, monsterName: monster.name } },
    select: { id: true },
  });
  if (known) return null;

  const result: FirstKillResult = { coins: 0, xp: 0, itemName: null, itemEmoji: null, teamPoints: 0, toGuild: false, roleId: null, titleName: null };

  // L'objet du serveur l'emporte sur le livré du même nom, comme pour les butins.
  const items = monster.firstKillItemName
    ? await prisma.rpgItem.findMany({
      where: { name: monster.firstKillItemName, OR: [{ guildId: null }, { guildId }] },
      select: { id: true, emoji: true, guildId: true },
    })
    : [];
  const item = items.find((candidate) => candidate.guildId !== null) ?? items[0] ?? null;

  // Le record et la prime s'écrivent ensemble : un record inscrit sans sa prime la ferait
  // perdre pour de bon, puisque plus personne ne pourrait la réclamer.
  //
  // `skipDuplicates` plutôt qu'une création dont on rattrape le refus : deux victoires
  // simultanées restent départagées par l'unicité (serveur, nom), mais la perdante
  // n'écrit plus d'erreur dans les journaux, où Prisma consigne même celles rattrapées.
  const claimed = await prisma.$transaction(async (tx) => {
    const inserted = await tx.rpgMonsterFirstKill.createMany({
      data: [{ guildId, monsterName: monster.name, userId }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return false;
    if (!hasFirstKillReward(monster)) return true;

    const profile = await tx.rpgProfile.update({
      where: { guildId_userId: { guildId, userId } },
      data: {
        balance: { increment: monster.firstKillCoinReward },
        xp: { increment: monster.firstKillXpReward },
      },
      select: { id: true },
    });
    if (item) {
      await tx.rpgInventoryItem.upsert({
        where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: item.id } },
        update: { quantity: { increment: 1 } },
        create: { rpgProfileId: profile.id, itemId: item.id, quantity: 1 },
      });
    }
    return true;
  });
  if (!claimed) return null;

  if (hasFirstKillReward(monster)) {
    result.coins = monster.firstKillCoinReward;
    result.xp = monster.firstKillXpReward;
    if (item) {
      result.itemName = monster.firstKillItemName;
      result.itemEmoji = item.emoji;
    }

    // Le record est déjà inscrit : chaque versement qui suit est isolé, pour qu'un incident
    // sur l'un ne prive pas le vainqueur des autres, qu'il ne pourra plus réclamer.
    const settle = <T>(step: string, run: () => Promise<T>): Promise<T | null> => run().catch((err) => {
      logger.warn('RpgFirstKill', `${step} du premier vainqueur en échec pour ${monster.name} :`, err);
      return null;
    });

    if (result.xp > 0) await settle('Passage de niveau', () => checkLevelUp(guildId, userId));

    if (monster.firstKillClanPoints > 0) {
      const team = await settle('Points de clan', () => awardRpgTeamPoints({
        client,
        guildId,
        userId,
        amount: monster.firstKillClanPoints,
        source: 'RPG_FIRST_KILL',
        reason: monster.name,
      }));
      result.teamPoints = team?.amount ?? 0;
      result.toGuild = team?.toGuild ?? false;
    }

    const titleId = monster.firstKillTitleId;
    if (titleId) {
      const title = await settle('Titre', async () => {
        const profile = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { id: true } });
        return profile ? grantTitle(profile.id, titleId) : null;
      });
      result.titleName = title?.name ?? null;
    }

    if (monster.firstKillRoleId) {
      result.roleId = await settle('Rôle', () => grantFirstKillRole(client, guildId, userId, monster));
    }
  }

  await announceFirstKill(client, guildId, userId, monster, result).catch((err) => {
    logger.error('RpgFirstKill', `Annonce du premier vainqueur impossible pour ${guildId}:`, err);
  });

  return result;
}

/**
 * Pourquoi un rôle ne peut pas être offert, ou `null` s'il peut l'être.
 *
 * Le rôle part vers un joueur quelconque, sans validation humaine au moment du versement :
 * un rôle qui donne la permission Administrateur est donc refusé d'office, et le verrou
 * d'administration n'a pas à entrer en jeu.
 */
export function firstKillRoleProblem(guild: Guild, role: Role | undefined | null): string | null {
  if (!role) return "Ce rôle n'existe pas sur le serveur.";
  if (role.id === guild.id) return 'Le rôle @everyone ne peut pas être offert.';
  if (role.managed) return 'Ce rôle est géré par une intégration et ne peut pas être attribué.';
  if (roleGrantsAdministrator(role.permissions.bitfield)) {
    return 'Un rôle qui donne la permission Administrateur ne peut pas être offert en récompense.';
  }
  if (!role.editable) return 'Le rôle du bot doit être placé au-dessus de ce rôle pour pouvoir le donner.';
  return null;
}

/** Contrôle d'un rôle au moment de régler la prime, depuis le dashboard ou MCP. */
export async function assertFirstKillRole(client: Client, guildId: string, roleId: string | null | undefined): Promise<void> {
  if (!roleId) return;
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error('Serveur introuvable.');
  const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
  const problem = firstKillRoleProblem(guild, role);
  if (problem) throw new Error(problem);
}

/**
 * Donne un rôle offert en récompense du RPG.
 *
 * Le contrôle est refait ici : entre le réglage et la victoire, le rôle a pu recevoir la
 * permission Administrateur, être supprimé ou passer au-dessus du bot.
 */
export async function grantRpgRewardRole(
  client: Client,
  guildId: string,
  userId: string,
  roleId: string,
  reason: string,
): Promise<string | null> {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
  const problem = firstKillRoleProblem(guild, role);
  if (problem || !role) {
    logger.warn('RpgFirstKill', `Rôle ${roleId} non offert (${reason}) sur ${guildId} : ${problem}`);
    return null;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  await member.roles.add(role, reason);
  return role.id;
}

async function grantFirstKillRole(client: Client, guildId: string, userId: string, monster: FirstKillMonster): Promise<string | null> {
  if (!monster.firstKillRoleId) return null;
  return grantRpgRewardRole(client, guildId, userId, monster.firstKillRoleId, `Premier vainqueur : ${monster.name}`);
}

async function announceFirstKill(
  client: Client,
  guildId: string,
  userId: string,
  monster: FirstKillMonster,
  result: FirstKillResult,
): Promise<void> {
  // Sans prime, le record s'inscrit sans bruit : annoncer chaque créature battue pour la
  // première fois inondait le salon sans rien à célébrer. Ce qui compte est ce qui a été
  // versé : une prime réduite à un objet retiré du catalogue ou à un rôle refusé se tait aussi.
  if (!hasFirstKillReward(monster)) return;

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.firstKillChannelId || !shouldAnnounceFirstKill(config.firstKillAnnounce, monster.isBoss)) return;

  const locale: BotLocale = await resolveGuildLocale(guildId);
  const reward = formatFirstKillReward(result, config.currencyEmoji, locale);
  if (!reward) return;

  const channel = await client.channels.fetch(config.firstKillChannelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('RpgFirstKill', `Salon d'annonce du premier vainqueur injoignable pour ${guildId}.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_first_kill_announce_title({}, { locale }))
    .setDescription(m.rpg_first_kill_announce_desc({ user: `<@${userId}>`, monster: `${monster.emoji} ${monster.name}` }, { locale }))
    .setColor(COLORS.warning)
    .addFields({ name: m.rpg_first_kill_field_reward({}, { locale }), value: reward });

  // Le vainqueur est nommé, pas notifié : une annonce ne doit sonner chez personne.
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

/** Prime lisible, ou chaîne vide s'il n'y en avait pas. */
export function formatFirstKillReward(
  reward: {
    coins: number;
    xp: number;
    itemName: string | null;
    itemEmoji?: string | null;
    teamPoints: number;
    toGuild: boolean;
    roleId: string | null;
    titleName: string | null;
  },
  currencyEmoji: string,
  locale: BotLocale,
): string {
  return [
    reward.coins > 0 ? `${currencyEmoji} +${reward.coins}` : null,
    reward.xp > 0 ? `+${reward.xp} XP` : null,
    reward.itemName ? `${reward.itemEmoji || '📦'} ${reward.itemName}` : null,
    reward.teamPoints > 0
      ? (reward.toGuild
        ? m.rpg_first_kill_guild_xp({ points: reward.teamPoints }, { locale })
        : m.rpg_first_kill_clan_points({ points: reward.teamPoints }, { locale }))
      : null,
    // Une mention de rôle dans un embed s'affiche sans notifier personne.
    reward.roleId ? m.rpg_first_kill_role({ role: `<@&${reward.roleId}>` }, { locale }) : null,
    reward.titleName ? m.rpg_first_kill_title({ title: reward.titleName }, { locale }) : null,
  ].filter((part): part is string => part !== null).join('  ·  ');
}

/**
 * Prime promise par une créature que personne n'a encore battue.
 *
 * Les points d'équipe vont à la guilde du jeu ou au clan selon le mode du serveur : c'est
 * ce mode qui décide du libellé, faute de vainqueur dont on connaîtrait l'équipe.
 */
export function formatFirstKillBounty(
  monster: FirstKillMonster,
  config: { currencyEmoji: string; raidTeamMode: string },
  locale: BotLocale,
  titleName: string | null = null,
): string {
  return formatFirstKillReward({
    coins: monster.firstKillCoinReward,
    xp: monster.firstKillXpReward,
    itemName: monster.firstKillItemName,
    teamPoints: monster.firstKillClanPoints,
    toGuild: asRpgTeamMode(config.raidTeamMode) === 'RPG_GUILD',
    roleId: monster.firstKillRoleId,
    titleName,
  }, config.currencyEmoji, locale);
}

/**
 * Efface le record d'une créature : son prochain vainqueur redevient le premier, et touche
 * la prime. Ce que l'ancien vainqueur a reçu lui reste acquis.
 */
export async function clearFirstKill(guildId: string, monsterName: string): Promise<FirstKillRecord | null> {
  const record = await getFirstKill(guildId, monsterName);
  if (!record) return null;
  await prisma.rpgMonsterFirstKill.deleteMany({ where: { guildId, monsterName } });
  return record;
}

export async function getFirstKill(guildId: string, monsterName: string): Promise<FirstKillRecord | null> {
  return prisma.rpgMonsterFirstKill.findUnique({
    where: { guildId_monsterName: { guildId, monsterName } },
    select: { userId: true, createdAt: true },
  });
}

/** Premiers vainqueurs du serveur, par nom de créature. */
export async function listFirstKills(guildId: string): Promise<Map<string, FirstKillRecord>> {
  const rows = await prisma.rpgMonsterFirstKill.findMany({
    where: { guildId },
    select: { monsterName: true, userId: true, createdAt: true },
  });
  return new Map(rows.map((row) => [row.monsterName, { userId: row.userId, createdAt: row.createdAt }]));
}

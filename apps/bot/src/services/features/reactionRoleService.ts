import type { Prisma } from '@prisma/client';
import { Client, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags, GuildMember, PermissionFlagsBits, type ButtonInteraction, type Guild, type Role } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveEmojiShortcodes } from '../../utils/emojis.js';
import { FALLBACK_LOCALE, getEffectiveLocale, resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { roleBlocker, shouldAlertStaff, type RoleBlocker } from './reactionRoleAccess.js';
import { rolesToSwapOut } from './reactionRoleExclusive.js';

// Discord n'accepte que 5 lignes de 5 boutons par message : au-delà, c'est le
// message entier qu'il refuse, et le panneau ne partirait jamais.
export const MAX_REACTION_ROLE_BUTTONS = 25;

export const REACTION_ROLE_BUTTON_MODES = ['toggle', 'add_only'] as const;

export type ReactionRoleButtonMode = (typeof REACTION_ROLE_BUTTON_MODES)[number];

export const REACTION_ROLE_BUTTON_STYLES = ['secondary', 'primary', 'success', 'danger'] as const;

export type ReactionRoleButtonStyle = (typeof REACTION_ROLE_BUTTON_STYLES)[number];

const DISCORD_BUTTON_STYLES: Record<ReactionRoleButtonStyle, ButtonStyle> = {
  secondary: ButtonStyle.Secondary,
  primary: ButtonStyle.Primary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export type ReactionRoleOption = {
  emoji?: string;
  label: string;
  roleId: string;
  mode?: ReactionRoleButtonMode | null;
  style?: ReactionRoleButtonStyle | null;
};

/** Le mode écrit sur un bouton, ou `null` s'il hérite de celui du menu. */
export function parseButtonMode(value: unknown): ReactionRoleButtonMode | null {
  return REACTION_ROLE_BUTTON_MODES.includes(value as ReactionRoleButtonMode)
    ? (value as ReactionRoleButtonMode)
    : null;
}

export function normalizeButtonMode(
  value: unknown,
  fallback: ReactionRoleButtonMode = 'toggle',
): ReactionRoleButtonMode {
  return parseButtonMode(value) ?? fallback;
}

/** La couleur écrite sur un bouton, ou `null` s'il garde la couleur par défaut. */
export function parseButtonStyle(value: unknown): ReactionRoleButtonStyle | null {
  return REACTION_ROLE_BUTTON_STYLES.includes(value as ReactionRoleButtonStyle)
    ? (value as ReactionRoleButtonStyle)
    : null;
}

export function normalizeButtonStyle(
  value: unknown,
  fallback: ReactionRoleButtonStyle = 'secondary',
): ReactionRoleButtonStyle {
  return parseButtonStyle(value) ?? fallback;
}

/**
 * Ne garde que les champs connus d'une option, et jette un mode ou une couleur
 * invalides plutôt que de les écrire en base : le bouton retombe alors sur le
 * mode du menu et sur la couleur par défaut, au lieu de figer un réglage que
 * personne n'a demandé.
 */
function sanitizeOptions(options: ReactionRoleOption[]): ReactionRoleOption[] {
  return options.map((option) => {
    const mode = parseButtonMode(option.mode);
    const style = parseButtonStyle(option.style);
    return {
      ...(option.emoji ? { emoji: option.emoji } : {}),
      label: option.label,
      roleId: option.roleId,
      ...(mode ? { mode } : {}),
      ...(style ? { style } : {}),
    };
  });
}

/**
 * Crée et envoie un menu de rôles avec boutons dans un canal Discord
 */
export async function createReactionRoleMenu(
  client: Client,
  guildId: string,
  channelId: string,
  title: string,
  options: ReactionRoleOption[],
  buttonMode: ReactionRoleButtonMode = 'toggle',
  exclusive = false,
) {
  // 1. Enregistrer dans la BDD
  const menu = await prisma.reactionRoleMenu.create({
    data: {
      guildId,
      channelId,
      title,
      buttonMode: normalizeButtonMode(buttonMode),
      exclusive,
      options: sanitizeOptions(options) as Prisma.InputJsonValue,
    },
  });

  // 2. Envoyer le message sur Discord
  await sendOrUpdateMenuMessage(client, menu.id);
  return menu;
}

/**
 * Retire le message d'un menu. Un échec est seulement consigné : la base fait
 * foi, et un message resté en place n'accorde plus aucun rôle une fois que le
 * menu qui le portait a disparu ou a changé de salon.
 */
async function deleteMenuMessage(
  client: Client,
  guildId: string,
  channelId: string,
  messageId: string,
  reason: string,
): Promise<void> {
  try {
    const discordGuild = client.guilds.cache.get(guildId)
      || await client.guilds.fetch(guildId).catch(() => null);
    const channel = discordGuild?.channels.cache.get(channelId)
      || await discordGuild?.channels.fetch(channelId).catch(() => null);

    if (!channel?.isTextBased()) {
      logger.warn(
        'ReactionRoleService',
        `Message ${messageId} non supprimé : salon ${channelId} introuvable ou non textuel.`
      );
      return;
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) {
      await message.delete();
    }
  } catch (err) {
    logger.warn('ReactionRoleService', `${reason} :`, err);
  }
}

/**
 * Supprime un menu en base puis tente de retirer son message Discord.
 * La suppression en base en premier invalide immédiatement les anciens boutons,
 * même si le bot ne peut plus accéder au message.
 */
export async function deleteReactionRoleMenu(
  client: Client,
  guildId: string,
  menuId: string
): Promise<boolean> {
  const menu = await prisma.reactionRoleMenu.findFirst({
    where: { id: menuId, guildId },
  });

  if (!menu) {
    return false;
  }

  await prisma.reactionRoleMenu.delete({
    where: { id: menu.id },
  });

  if (menu.messageId) {
    await deleteMenuMessage(
      client,
      guildId,
      menu.channelId,
      menu.messageId,
      `Le menu ${menu.id} est désactivé, mais son message Discord n'a pas pu être supprimé`,
    );
  }

  return true;
}

/**
 * Modifie un menu existant puis remet son message Discord à jour.
 *
 * Un changement de salon fait repartir le message ailleurs : l'ancien est
 * retiré et `messageId` remis à zéro, sinon deux panneaux vivants
 * distribueraient les mêmes rôles.
 */
export async function updateReactionRoleMenu(
  client: Client,
  guildId: string,
  menuId: string,
  changes: {
    title?: string;
    channelId?: string;
    options?: ReactionRoleOption[];
    buttonMode?: ReactionRoleButtonMode;
    exclusive?: boolean;
  },
) {
  const menu = await prisma.reactionRoleMenu.findFirst({
    where: { id: menuId, guildId },
  });

  if (!menu) {
    return null;
  }

  const movedTo = changes.channelId && changes.channelId !== menu.channelId
    ? changes.channelId
    : null;

  if (movedTo && menu.messageId) {
    await deleteMenuMessage(
      client,
      guildId,
      menu.channelId,
      menu.messageId,
      `Le menu ${menu.id} change de salon, mais son ancien message n'a pas pu être supprimé`,
    );
  }

  const updated = await prisma.reactionRoleMenu.update({
    where: { id: menu.id },
    data: {
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(movedTo ? { channelId: movedTo, messageId: null } : {}),
      ...(changes.options ? { options: sanitizeOptions(changes.options) as Prisma.InputJsonValue } : {}),
      ...(changes.buttonMode !== undefined ? { buttonMode: normalizeButtonMode(changes.buttonMode) } : {}),
      ...(changes.exclusive !== undefined ? { exclusive: changes.exclusive } : {}),
    },
  });

  // Republier peut attribuer un nouveau `messageId` : le menu est relu pour
  // que l'appelant reçoive celui qui vaut vraiment.
  await sendOrUpdateMenuMessage(client, menu.id);
  return await prisma.reactionRoleMenu.findUnique({ where: { id: menu.id } }) ?? updated;
}

/**
 * Annonce dans l'embed ce que font réellement les boutons : promettre un retrait
 * là où le rôle ne part plus ferait cliquer les membres pour rien.
 */
function describeMenuModes(
  options: ReactionRoleOption[],
  menuMode: ReactionRoleButtonMode,
  exclusive: boolean,
  locale: BotLocale,
): string {
  if (exclusive) return m.panel_reactionroles_description_exclusive({}, { locale });
  const modes = new Set(options.map((option) => normalizeButtonMode(option.mode, menuMode)));

  if (modes.size > 1) return m.panel_reactionroles_description_mixed({}, { locale });
  if (modes.has('add_only')) return m.panel_reactionroles_description_add_only({}, { locale });
  return m.panel_reactionroles_description({}, { locale });
}

/**
 * Envoie ou met à jour le message d'un menu de rôles
 */
export async function sendOrUpdateMenuMessage(client: Client, menuId: string) {
  try {
    const menu = await prisma.reactionRoleMenu.findUnique({
      where: { id: menuId },
    });
    if (!menu) return;

    const discordGuild = client.guilds.cache.get(menu.guildId) || await client.guilds.fetch(menu.guildId).catch(() => null);
    if (!discordGuild) return;

    // Le salon d'un menu déplacé n'est pas forcément en cache : sans ce repli,
    // le panneau ne repartirait jamais dans son nouveau salon.
    const channel = discordGuild.channels.cache.get(menu.channelId)
      || await discordGuild.channels.fetch(menu.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const options = Array.isArray(menu.options) ? menu.options as ReactionRoleOption[] : [];
    const locale = await resolveGuildLocale(menu.guildId, discordGuild.preferredLocale);
    const menuMode = normalizeButtonMode(menu.buttonMode);

    // Créer l'embed du menu
    const embed = new EmbedBuilder()
      .setTitle(resolveEmojiShortcodes(menu.title))
      .setDescription(describeMenuModes(options, menuMode, menu.exclusive, locale))
      .setColor('#5865F2')
      .setTimestamp();

    // Construire les boutons (maximum 5 boutons par ligne, maximum 25 boutons au total)
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let currentRow = new ActionRowBuilder<ButtonBuilder>();

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      // L'index suit le bouton dans son identifiant : deux boutons peuvent
      // viser le même rôle avec des modes différents, et Discord refuse deux
      // identifiants identiques dans un même message.
      const button = new ButtonBuilder()
        .setCustomId(`role_toggle:${opt.roleId}:${i}`)
        .setLabel(opt.label)
        .setStyle(DISCORD_BUTTON_STYLES[normalizeButtonStyle(opt.style)]);

      if (opt.emoji) {
        button.setEmoji(opt.emoji);
      }

      if (i > 0 && i % 5 === 0) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder<ButtonBuilder>();
      }

      currentRow.addComponents(button);
    }

    if (currentRow.components.length > 0) {
      rows.push(currentRow);
    }

    let messageSent;
    if (menu.messageId) {
      // Tenter de modifier le message existant
      const existingMsg = await channel.messages.fetch(menu.messageId).catch(() => null);
      if (existingMsg) {
        messageSent = await existingMsg.edit({ embeds: [embed], components: rows }).catch(() => null);
      }
    }

    if (!messageSent) {
      // Envoyer un nouveau message
      messageSent = await channel.send({ embeds: [embed], components: rows }).catch(() => null);
      if (messageSent) {
        await prisma.reactionRoleMenu.update({
          where: { id: menuId },
          data: { messageId: messageSent.id },
        });
      }
    }
  } catch (err) {
    logger.error('ReactionRoleService', `Erreur lors de l'envoi/mise à jour du menu ${menuId}:`, err);
  }
}

/**
 * Retrouve le bouton cliqué. L'index de l'identifiant est la source sûre, mais
 * les messages publiés avant son arrivée n'en portent pas : on retombe alors
 * sur le premier bouton qui vise ce rôle.
 */
function findClickedOption(
  options: ReactionRoleOption[],
  roleId: string,
  rawIndex: string | undefined,
): ReactionRoleOption | null {
  const index = rawIndex === undefined ? NaN : Number(rawIndex);
  const byIndex = Number.isInteger(index) ? options[index] : undefined;
  if (byIndex?.roleId === roleId) return byIndex;

  return options.find((option) => option.roleId === roleId) ?? null;
}

/**
 * Applique un clic sur un bouton de rôle. Le mode du bouton décide de ce que
 * fait un second clic : « toggle » retire le rôle, « add_only » le conserve.
 */
export async function handleRoleToggleInteraction(interaction: ButtonInteraction) {
  const locale = await getEffectiveLocale(interaction).catch(() => FALLBACK_LOCALE);

  try {
    const [, roleId, rawIndex] = interaction.customId.split(':');
    const guildId = interaction.guildId;
    const messageId = interaction.message.id;

    const activeMenu = guildId && roleId
      ? await prisma.reactionRoleMenu.findFirst({
        where: { guildId, messageId },
      })
      : null;
    const configuredRoles = Array.isArray(activeMenu?.options)
      ? activeMenu.options as ReactionRoleOption[]
      : [];
    const clicked = roleId ? findClickedOption(configuredRoles, roleId, rawIndex) : null;

    if (!activeMenu || !clicked) {
      return interaction.reply({
        content: m.reactionroles_panel_inactive({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
    }

    // `interaction.member` peut etre un GuildMember complet ou sa forme brute
    // APIInteractionGuildMember (hors cache), qui n'expose pas de gestionnaire
    // de roles : seul le premier permet d'ajouter ou retirer un role.
    const member = interaction.member;

    if (!(member instanceof GuildMember)) {
      return interaction.reply({
        content: m.reactionroles_member_missing({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
    }

    const mode = normalizeButtonMode(clicked.mode, normalizeButtonMode(activeMenu.buttonMode));
    const role = `<@&${roleId}>`;
    const hasRole = member.roles.cache.has(roleId);

    if (hasRole && mode === 'add_only') {
      return interaction.reply({
        content: m.reactionroles_role_kept({ role }, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
    }

    // Sans ce contrôle, Discord refuse l'ajout et le membre ne lit qu'« erreur ».
    const guild = member.guild;
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const clickedRole = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    const blocked = blockerOf(clickedRole, me);
    if (blocked) {
      void alertStaffRoleBlocked(guild, activeMenu.title, roleId, { reason: blocked, roleName: clickedRole?.name ?? null });
      return interaction.reply({
        content: m.reactionroles_role_unavailable({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
    }

    if (hasRole) {
      await member.roles.remove(roleId);
      return interaction.reply({
        content: m.reactionroles_role_removed({ role }, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
    }

    // Menu « un seul rôle » : les autres rôles du menu partent, sauf ceux que le
    // bot ne peut pas retirer (un seul refus ferait échouer tout le retrait).
    const swapOut = activeMenu.exclusive
      ? rolesToSwapOut(configuredRoles.map((option) => option.roleId), member.roles.cache.keys(), roleId)
        .filter((id) => !blockerOf(guild.roles.cache.get(id), me))
      : [];

    // Ajout d'abord : si le retrait échoue ensuite, le membre a deux rôles
    // plutôt qu'aucun.
    await member.roles.add(roleId);
    const swapped = swapOut.length > 0 && await member.roles.remove(swapOut).then(
      () => true,
      (err: unknown) => {
        logger.warn('ReactionRoleService', `Rôles précédents non retirés pour ${member.id} :`, err);
        return false;
      },
    );

    return interaction.reply({
      content: swapped
        ? m.reactionroles_role_swapped({ role, previous: swapOut.map((id) => `<@&${id}>`).join(', ') }, { locale })
        : m.reactionroles_role_added({ role }, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
  } catch (err) {
    logger.error('ReactionRoleService', 'Erreur lors de la bascule de rôle :', err);
    return interaction.reply({
      content: m.reactionroles_error({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
  }
}

function blockerOf(role: Role | null | undefined, me: GuildMember | null): RoleBlocker | null {
  return roleBlocker({
    exists: !!role,
    managed: role?.managed ?? false,
    botCanManageRoles: me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false,
    rolePosition: role?.position ?? 0,
    botTopPosition: me?.roles.highest.position ?? 0,
  });
}

/** Dernière alerte envoyée, par serveur et par rôle. */
const lastStaffAlerts = new Map<string, number>();

/**
 * Prévient le propriétaire du serveur qu'un bouton du menu ne marche plus, avec
 * la correction à faire. Jamais bloquant pour la réponse au membre.
 */
async function alertStaffRoleBlocked(
  guild: Guild,
  menuTitle: string,
  roleId: string,
  blocked: { reason: RoleBlocker; roleName: string | null },
): Promise<void> {
  const key = `${guild.id}:${roleId}`;
  const now = Date.now();
  if (!shouldAlertStaff(lastStaffAlerts.get(key), now)) return;
  lastStaffAlerts.set(key, now);

  try {
    // Import dynamique : le service de notifications tire l'API, qui importe ce fichier.
    const { notify, dashboardLink } = await import('../notifications/notifyService.js');
    const locale = await resolveGuildLocale(guild.id);
    const role = blocked.roleName ?? roleId;
    const reasons = {
      missing: m.ntf_reaction_role_missing,
      managed: m.ntf_reaction_role_managed,
      no_permission: m.ntf_reaction_role_no_permission,
      too_high: m.ntf_reaction_role_too_high,
    } as const;
    await notify({
      guildId: guild.id,
      userId: guild.ownerId,
      kind: 'system.reaction_role_blocked',
      title: m.ntf_reaction_role_blocked_title({ menu: menuTitle }, { locale }),
      message: reasons[blocked.reason]({ role }, { locale }),
      severity: 'WARNING',
      link: dashboardLink('/reaction-roles', guild.id),
      groupKey: `reaction-role-blocked:${roleId}`,
    });
  } catch (err) {
    logger.warn('ReactionRoleService', `Alerte de rôle bloqué non envoyée pour ${roleId} :`, err);
  }
}

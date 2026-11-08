import type { Prisma } from '@prisma/client';
import { Client, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags, GuildMember, PermissionFlagsBits, RESTJSONErrorCodes, type ButtonInteraction, type HexColorString, type Guild, type Role } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveEmojiShortcodes } from '../../utils/emojis.js';
import { FALLBACK_LOCALE, getEffectiveLocale, resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import {
  buttonLabelWithCount,
  normalizeMenuMode,
  parseButtonMode,
  resolveButtonMode,
  type BotRoleAccess,
  type ReactionRoleButtonMode,
  type ReactionRoleMenuMode,
} from '@kotbo/contracts';
import { roleBlocker, shouldAlertStaff, type RoleBlocker } from './reactionRoleAccess.js';
import { rolesToSwapOut } from './reactionRoleExclusive.js';
import { recordReactionRoleChange } from '../analytics/reactionRoleStatsService.js';

// Discord n'accepte que 5 lignes de 5 boutons par message : au-delà, c'est le
// message entier qu'il refuse, et le panneau ne partirait jamais.
export const MAX_REACTION_ROLE_BUTTONS = 25;

export { buttonLabelWithCount, normalizeMenuMode };
export type { ReactionRoleButtonMode, ReactionRoleMenuMode };

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

/** Réglages d'un nouveau menu ; seuls le salon, le titre et les boutons sont requis. */
export type NewReactionRoleMenu = {
  channelId: string;
  title: string;
  options: ReactionRoleOption[];
  buttonMode?: ReactionRoleMenuMode;
  /** Texte sous le titre ; absent, le bot explique ce que font les boutons. */
  description?: string | null;
  showCounts?: boolean;
  /** Couleur de la barre de l'embed ; absente, le bleu Discord. */
  embedColor?: string | null;
};

/**
 * Crée et envoie un menu de rôles avec boutons dans un canal Discord
 */
export async function createReactionRoleMenu(client: Client, guildId: string, settings: NewReactionRoleMenu) {
  const { channelId, title, options, buttonMode = 'toggle', description, showCounts, embedColor } = settings;
  // 1. Enregistrer dans la BDD
  const menu = await prisma.reactionRoleMenu.create({
    data: {
      guildId,
      channelId,
      title,
      buttonMode: normalizeMenuMode(buttonMode),
      ...(description ? { description } : {}),
      ...(showCounts ? { showCounts: true } : {}),
      ...(embedColor ? { embedColor } : {}),
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
    buttonMode?: ReactionRoleMenuMode;
    /** `null` remet le texte par défaut. */
    description?: string | null;
    showCounts?: boolean;
    /** `null` remet le bleu Discord. */
    embedColor?: string | null;
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

  const updated = await prisma.reactionRoleMenu.update({
    where: { id: menu.id },
    data: {
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(movedTo ? { channelId: movedTo, messageId: null } : {}),
      ...(changes.options ? { options: sanitizeOptions(changes.options) as Prisma.InputJsonValue } : {}),
      ...(changes.buttonMode !== undefined ? { buttonMode: normalizeMenuMode(changes.buttonMode) } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.showCounts !== undefined ? { showCounts: changes.showCounts } : {}),
      ...(changes.embedColor !== undefined ? { embedColor: changes.embedColor } : {}),
    },
  });

  // L'ancien message n'est retiré qu'une fois oublié en base : l'écouteur des
  // suppressions ne le prend alors pas pour un message effacé par le staff.
  if (movedTo && menu.messageId) {
    await deleteMenuMessage(
      client,
      guildId,
      menu.channelId,
      menu.messageId,
      `Le menu ${menu.id} change de salon, mais son ancien message n'a pas pu être supprimé`,
    );
  }

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
  menuMode: ReactionRoleMenuMode,
  locale: BotLocale,
): string {
  if (menuMode === 'exclusive') return m.panel_reactionroles_description_exclusive({}, { locale });
  const modes = new Set(options.map((option) => resolveButtonMode(option.mode, menuMode)));

  if (modes.size > 1) return m.panel_reactionroles_description_mixed({}, { locale });
  if (modes.has('add_only')) return m.panel_reactionroles_description_add_only({}, { locale });
  return m.panel_reactionroles_description({}, { locale });
}

/** Couleur de la barre de l'embed quand le staff n'en choisit pas. */
const DEFAULT_EMBED_COLOR: HexColorString = '#5865F2';

/** Couleur reçue du dashboard, ramenée à « #RRGGBB » ; invalide ou vide, `null` (couleur par défaut). */
export function normalizeEmbedColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

/** Longueur maximale du texte d'un menu, bien sous la limite d'un embed Discord. */
const MENU_DESCRIPTION_MAX_LENGTH = 1000;

/** Texte du message reçu du dashboard : vide ou invalide, il retombe sur le texte par défaut. */
export function normalizeMenuDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, MENU_DESCRIPTION_MAX_LENGTH);
  return text || null;
}

/** Le texte saisi par le staff, sinon celui qui explique ce que font les boutons. */
export function menuDescription(
  custom: string | null,
  options: ReactionRoleOption[],
  menuMode: ReactionRoleMenuMode,
  locale: BotLocale,
): string {
  return custom || describeMenuModes(options, menuMode, locale);
}

/** Erreur Discord qui dit que le message (ou son salon) n'existe plus. */
function isGoneError(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === RESTJSONErrorCodes.UnknownMessage || code === RESTJSONErrorCodes.UnknownChannel;
}

/**
 * Envoie ou met à jour le message d'un menu de rôles.
 *
 * Un nouveau message ne part que si l'ancien a vraiment disparu, et seulement
 * quand `repost` le permet : la mise à jour des nombres passe `false`, sinon
 * un panneau effacé par le staff reviendrait au premier rôle qui bouge. Une
 * modification refusée est consignée, pas doublée d'un second panneau.
 */
export async function sendOrUpdateMenuMessage(client: Client, menuId: string, { repost = true } = {}) {
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
    const menuMode = normalizeMenuMode(menu.buttonMode);

    // Créer l'embed du menu
    const embed = new EmbedBuilder()
      .setTitle(resolveEmojiShortcodes(menu.title))
      .setDescription(resolveEmojiShortcodes(menuDescription(menu.description, options, menuMode, locale)))
      .setColor((menu.embedColor ?? DEFAULT_EMBED_COLOR) as HexColorString);

    // Construire les boutons (maximum 5 boutons par ligne, maximum 25 boutons au total)
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let currentRow = new ActionRowBuilder<ButtonBuilder>();

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      // Le nombre affiché est celui des membres qui ont le rôle, pas des clics :
      // basculer dix fois ne le gonfle pas.
      const label = menu.showCounts
        ? buttonLabelWithCount(opt.label, discordGuild.roles.cache.get(opt.roleId)?.members.size)
        : opt.label;
      // L'index suit le bouton dans son identifiant : deux boutons peuvent
      // viser le même rôle avec des modes différents, et Discord refuse deux
      // identifiants identiques dans un même message.
      const button = new ButtonBuilder()
        .setCustomId(`role_toggle:${opt.roleId}:${i}`)
        .setLabel(label)
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

    // Une lecture refusée pour une autre raison qu'une suppression remonte au
    // `catch` : rien ne prouve que le panneau a disparu.
    const existingMsg = menu.messageId
      ? await channel.messages.fetch(menu.messageId).catch((err: unknown) => {
        if (isGoneError(err)) return null;
        throw err;
      })
      : null;

    if (existingMsg) {
      await existingMsg.edit({ embeds: [embed], components: rows });
      return;
    }
    if (!repost) return;

    const messageSent = await channel.send({ embeds: [embed], components: rows });
    await prisma.reactionRoleMenu.update({
      where: { id: menuId },
      data: { messageId: messageSent.id },
    });
  } catch (err) {
    logger.error('ReactionRoleService', `Erreur lors de l'envoi/mise à jour du menu ${menuId}:`, err);
  }
}

/**
 * Le message d'un menu est-il toujours sur Discord ? `missing` quand il a été
 * supprimé (lui ou son salon) ou jamais publié : les boutons n'existent plus
 * pour les membres. `unknown` pour toute autre erreur (permission, panne) : on
 * ne crie pas à la disparition sur une simple lecture refusée.
 */
export async function menuMessageStatus(
  guild: Guild,
  menu: { channelId: string; messageId: string | null },
): Promise<'ok' | 'missing' | 'unknown'> {
  if (!menu.messageId) return 'missing';
  try {
    const channel = await guild.channels.fetch(menu.channelId);
    if (!channel?.isTextBased()) return 'missing';
    await channel.messages.fetch(menu.messageId);
    return 'ok';
  } catch (err) {
    return isGoneError(err) ? 'missing' : 'unknown';
  }
}

/** Membres qui portent chaque rôle des menus, d'après le cache du serveur. */
export function roleMemberCounts(guild: Guild, roleIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const roleId of new Set(roleIds)) {
    const role = guild.roles.cache.get(roleId);
    if (role) counts[roleId] = role.members.size;
  }
  return counts;
}

/** Délai entre deux mises à jour des nombres d'un même menu. */
const COUNT_REFRESH_DELAY_MS = 5_000;
const pendingCountRefreshes = new Set<string>();

/**
 * Met à jour les nombres affichés sur les boutons quelques secondes après un
 * changement de rôle. Fenêtre fixe : les changements suivants rejoignent la
 * mise à jour déjà prévue au lieu de la repousser, si bien qu'un membre qui
 * bascule sans arrêt ne la bloque pas et ne provoque qu'une modification du
 * message par période.
 */
function scheduleCountRefresh(client: Client, menuId: string): void {
  if (pendingCountRefreshes.has(menuId)) return;
  pendingCountRefreshes.add(menuId);
  setTimeout(() => {
    pendingCountRefreshes.delete(menuId);
    void sendOrUpdateMenuMessage(client, menuId, { repost: false });
  }, COUNT_REFRESH_DELAY_MS);
}

/** Rôles gagnés ou perdus par un membre entre deux de ses états. */
export function changedRoleIds(before: Iterable<string>, after: Iterable<string>): string[] {
  const previous = new Set(before);
  const next = new Set(after);
  return [
    ...[...previous].filter((id) => !next.has(id)),
    ...[...next].filter((id) => !previous.has(id)),
  ];
}

/** Menus dont au moins un bouton vise l'un de ces rôles. */
export function menusUsingRoles<T extends { options: unknown }>(menus: T[], roleIds: Iterable<string>): T[] {
  const wanted = new Set(roleIds);
  return menus.filter((menu) => Array.isArray(menu.options)
    && (menu.options as Array<{ roleId?: unknown }>).some((option) => wanted.has(option?.roleId as string)));
}

/**
 * Un rôle de menu a changé de porteurs, depuis le panneau ou ailleurs (donné à
 * la main, par un autre bot, membre parti) : les nombres affichés sur les
 * boutons suivent. Les clics passent aussi par ici, via `GuildMemberUpdate`.
 */
export async function refreshCountsForRoles(client: Client, guildId: string, roleIds: string[]): Promise<void> {
  // Un pseudo ou un avatar changé ne touche aucun rôle : pas de lecture en base.
  if (roleIds.length === 0) return;
  const menus = await prisma.reactionRoleMenu.findMany({
    where: { guildId, showCounts: true, messageId: { not: null } },
    select: { id: true, options: true },
  });
  for (const menu of menusUsingRoles(menus, roleIds)) scheduleCountRefresh(client, menu.id);
}

/**
 * Un rôle porté par un menu vient d'être supprimé sur Discord : le staff est
 * prévenu tout de suite, plutôt qu'au premier membre qui clique pour rien.
 */
export async function handleMenuRoleDeleted(role: Role): Promise<void> {
  const menus = await prisma.reactionRoleMenu.findMany({
    where: { guildId: role.guild.id },
    select: { title: true, options: true },
  });
  const affected = menusUsingRoles(menus, [role.id]);
  if (affected.length === 0) return;
  await alertStaffRoleBlocked(
    role.guild,
    affected.map((menu) => menu.title).join(', '),
    role.id,
    { reason: 'missing', roleName: role.name },
  );
}

/**
 * Le message d'un menu a été effacé sur Discord : ses boutons ont disparu
 * avec lui. Le bot retire lui-même ses messages après les avoir oubliés en
 * base, si bien que seule une suppression faite par quelqu'un d'autre arrive ici.
 */
export async function handleMenuMessagesDeleted(guild: Guild, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const menus = await prisma.reactionRoleMenu.findMany({
    where: { guildId: guild.id, messageId: { in: messageIds } },
    select: { id: true, title: true },
  });
  for (const menu of menus) {
    await alertStaff(guild, {
      groupKey: `reaction-role-message-deleted:${menu.id}`,
      kind: 'system.reaction_role_message_deleted',
      build: (locale) => ({
        title: m.ntf_reaction_role_message_deleted_title({ menu: menu.title }, { locale }),
        message: m.ntf_reaction_role_message_deleted({}, { locale }),
      }),
    });
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
 * Dans un menu « exclusive », prendre un rôle retire les autres du menu.
 */
export async function handleRoleToggleInteraction(interaction: ButtonInteraction) {
  // Réponse différée avant toute lecture : base, ajout et retrait de rôles
  // peuvent dépasser les 3 s que Discord laisse, surtout quand il ralentit les
  // changements de rôles d'un gros serveur. Le membre verrait alors « échec »
  // alors que son rôle est bien arrivé.
  const deferred = await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).then(() => true, (err: unknown) => {
    logger.warn('ReactionRoleService', 'Réponse au clic non différée :', err);
    return false;
  });
  if (!deferred) return;

  const locale = await getEffectiveLocale(interaction).catch(() => FALLBACK_LOCALE);
  const answer = (content: string) => interaction.editReply({ content });

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
      return answer(m.reactionroles_panel_inactive({}, { locale }));
    }

    // `interaction.member` peut etre un GuildMember complet ou sa forme brute
    // APIInteractionGuildMember (hors cache), qui n'expose pas de gestionnaire
    // de roles : seul le premier permet d'ajouter ou retirer un role.
    const member = interaction.member;

    if (!(member instanceof GuildMember)) {
      return answer(m.reactionroles_member_missing({}, { locale }));
    }

    const menuMode = normalizeMenuMode(activeMenu.buttonMode);
    const mode = resolveButtonMode(clicked.mode, menuMode);
    const role = `<@&${roleId}>`;
    const hasRole = member.roles.cache.has(roleId);

    if (hasRole && mode === 'add_only') {
      return answer(m.reactionroles_role_kept({ role }, { locale }));
    }

    // Sans ce contrôle, Discord refuse l'ajout et le membre ne lit qu'« erreur ».
    const guild = member.guild;
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    const clickedRole = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    const blocked = blockerOf(clickedRole, me);
    if (blocked) {
      void alertStaffRoleBlocked(guild, activeMenu.title, roleId, { reason: blocked, roleName: clickedRole?.name ?? null });
      return answer(m.reactionroles_role_unavailable({}, { locale }));
    }

    // Le journal d'audit nomme le menu : les logs du serveur le reprennent, et
    // le staff sait d'où vient un rôle que le bot a donné.
    const reason = m.reactionroles_audit_reason({ menu: activeMenu.title }, { locale: await resolveGuildLocale(guild.id) });
    const count = (id: string, change: 'added' | 'removed') =>
      void recordReactionRoleChange({ guildId: guild.id, menuId: activeMenu.id, roleId: id, change });

    if (hasRole) {
      await member.roles.remove(roleId, reason);
      count(roleId, 'removed');
      return answer(m.reactionroles_role_removed({ role }, { locale }));
    }

    // Menu « un seul rôle » : les autres rôles du menu partent, sauf ceux que le
    // bot ne peut pas retirer (un seul refus ferait échouer tout le retrait).
    const swapOut = menuMode === 'exclusive'
      ? rolesToSwapOut(configuredRoles.map((option) => option.roleId), member.roles.cache.keys(), roleId)
        .filter((id) => !blockerOf(guild.roles.cache.get(id), me))
      : [];

    // Ajout d'abord : si le retrait échoue ensuite, le membre a deux rôles
    // plutôt qu'aucun.
    await member.roles.add(roleId, reason);
    count(roleId, 'added');
    const swapped = swapOut.length > 0 && await member.roles.remove(swapOut, reason).then(
      () => true,
      (err: unknown) => {
        logger.warn('ReactionRoleService', `Rôles précédents non retirés pour ${member.id} :`, err);
        return false;
      },
    );

    if (swapped) swapOut.forEach((id) => count(id, 'removed'));

    return answer(swapped
      ? m.reactionroles_role_swapped({ role, previous: swapOut.map((id) => `<@&${id}>`).join(', ') }, { locale })
      : m.reactionroles_role_added({ role }, { locale }));
  } catch (err) {
    logger.error('ReactionRoleService', 'Erreur lors de la bascule de rôle :', err);
    return answer(m.reactionroles_error({}, { locale }));
  }
}

function botRoleAccessOf(me: GuildMember | null): BotRoleAccess {
  return {
    canManageRoles: me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false,
    topPosition: me?.roles.highest.position ?? 0,
  };
}

/** Ce que le bot peut attribuer sur ce serveur : le dashboard en déduit les rôles bloqués. */
export async function getBotRoleAccess(guild: Guild): Promise<BotRoleAccess> {
  return botRoleAccessOf(guild.members.me ?? await guild.members.fetchMe().catch(() => null));
}

function blockerOf(role: Role | null | undefined, me: GuildMember | null): RoleBlocker | null {
  const access = botRoleAccessOf(me);
  return roleBlocker({
    exists: !!role,
    managed: role?.managed ?? false,
    botCanManageRoles: access.canManageRoles,
    rolePosition: role?.position ?? 0,
    botTopPosition: access.topPosition,
  });
}

/**
 * Prévient le propriétaire du serveur, au plus une fois par heure pour une même
 * clé. Jamais bloquant pour l'appelant : un échec est seulement consigné.
 */
async function alertStaff(
  guild: Guild,
  alert: {
    groupKey: string;
    kind: 'system.reaction_role_blocked' | 'system.reaction_role_message_deleted';
    build: (locale: BotLocale) => { title: string; message: string };
  },
): Promise<void> {
  try {
    // La dernière alerte se lit en base : le délai vaut pour toutes les
    // instances, survit aux redémarrages, et compte aussi une alerte déjà lue.
    const last = await prisma.notification.findFirst({
      where: { guildId: guild.id, userId: guild.ownerId, groupKey: alert.groupKey },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });
    if (!shouldAlertStaff(last?.updatedAt.getTime(), Date.now())) return;

    // Import dynamique : le service de notifications tire l'API, qui importe ce fichier.
    const { notify, dashboardLink } = await import('../notifications/notifyService.js');
    const locale = await resolveGuildLocale(guild.id);
    await notify({
      guildId: guild.id,
      userId: guild.ownerId,
      kind: alert.kind,
      ...alert.build(locale),
      severity: 'WARNING',
      link: dashboardLink('/reaction-roles', guild.id),
      groupKey: alert.groupKey,
    });
  } catch (err) {
    logger.warn('ReactionRoleService', `Alerte ${alert.groupKey} non envoyée :`, err);
  }
}

const BLOCKER_NOTIFICATIONS = {
  missing: m.ntf_reaction_role_missing,
  managed: m.ntf_reaction_role_managed,
  no_permission: m.ntf_reaction_role_no_permission,
  too_high: m.ntf_reaction_role_too_high,
} as const;

/** Prévient le staff qu'un bouton du menu ne marche plus, avec la correction à faire. */
function alertStaffRoleBlocked(
  guild: Guild,
  menuTitle: string,
  roleId: string,
  blocked: { reason: RoleBlocker; roleName: string | null },
): Promise<void> {
  const role = blocked.roleName ?? roleId;
  return alertStaff(guild, {
    groupKey: `reaction-role-blocked:${roleId}`,
    kind: 'system.reaction_role_blocked',
    build: (locale) => ({
      title: m.ntf_reaction_role_blocked_title({ menu: menuTitle }, { locale }),
      message: BLOCKER_NOTIFICATIONS[blocked.reason]({ role }, { locale }),
    }),
  });
}

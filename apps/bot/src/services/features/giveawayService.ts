import { kotboEventBus } from '@kotbo/core';
import { errorMessage } from '../../utils/errors.js';
import type { Prisma } from '@prisma/client';
import { getLocale, resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { Client, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags, type ButtonInteraction, type ColorResolvable, type Guild, type Message, type MessageMentionOptions } from 'discord.js';
import prisma from '../../utils/db.js';
import { publishGuildSignal } from '../site/siteLive.js';
import { upsertRetryingRace } from '../../utils/upsertRetry.js';
import { logger } from '../../utils/logger.js';
import { resolveEmojiShortcodes } from '../../utils/emojis.js';
import { isStaffServerGuild } from '../staff/staffServerService.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import {
  checkParticipation,
  deniedLinkedAccountText,
  getGiveawayConfig,
  hasParticipationRules,
  type GiveawayConfig,
} from './giveawayConfigService.js';
import { buildLinkedAccountFolder, getAllLinkedUserIds } from '../moderation/altAccountService.js';
import {
  buildBonusRolesBlock,
  resolveGiveawayBonuses,
  weightForRoles,
  type ResolvedBonus,
} from './giveawayBonusService.js';
import {
  applyAppearanceOverrides,
  generatedLabels,
  normalizeAppearancePatch,
  renderGiveawayText,
  resolveButtonStyle,
  resolveEmbedColor,
  type GiveawayAppearance,
  type GiveawayGeneratedLabels,
  type GiveawayTextContext,
} from './giveawayAppearance.js';

// Cooldown map to prevent spamming/double clicks on the join button
const joinCooldowns = new Map<string, number>();

/**
 * Mentions autorisées dans les messages d'un concours.
 *
 * Les rôles avantagés sont écrits en mention pour s'afficher avec leur couleur
 * et rester justes après un renommage, mais un concours n'a aucune raison de
 * notifier un rôle entier, encore moins tout le serveur. Les gagnants, eux,
 * doivent être prévenus : seules les mentions de membres passent.
 */
const GIVEAWAY_MENTIONS: MessageMentionOptions = { parse: ['users'] };

/**
 * Rôles du membre à l'origine d'une interaction.
 *
 * Sur une guilde non mise en cache, `interaction.member` arrive sous sa forme
 * brute où `roles` est déjà une liste d'identifiants : on évite ainsi un
 * `members.fetch()` à chaque clic.
 */
function memberRoleIds(interaction: ButtonInteraction): string[] {
  const member = interaction.member;
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...member.roles.cache.keys()];
}

/**
 * Arrivée du membre sur le serveur, `null` quand Discord ne la transmet pas.
 *
 * Sur une guilde non mise en cache, le membre brut porte `joined_at` sous
 * forme de chaîne ISO là où `GuildMember` expose `joinedAt`.
 */
function memberJoinedAt(interaction: ButtonInteraction): Date | null {
  const member = interaction.member;
  if (!member) return null;
  if ('joinedAt' in member && member.joinedAt) return member.joinedAt;
  const raw = (member as { joined_at?: string }).joined_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Données minimales d'un giveaway nécessaires pour reconstruire son embed.
 * On reconstruit toujours l'embed à partir de la BDD car les messages sont
 * envoyés en Components V2 (voir utils/patchV2.ts) : `message.embeds` est vide,
 * donc on ne peut pas relire l'embed d'origine sur le message pour l'éditer.
 */
interface GiveawayEmbedData {
  id: string;
  prize: string;
  description?: string | null;
  winnerCount: number;
  endsAt: Date;
  rpgXp?: number | null;
  rpgCoins?: number | null;
  rpgItemId?: string | null;
  needValidation?: boolean | null;
  createdById?: string | null;
  styleOverrides?: unknown;
  ignoreBonuses?: boolean | null;
}

/**
 * Apparence effective d'un concours : valeurs d'usine, puis réglages du
 * serveur, puis surcharges propres au concours.
 */
function appearanceOf(config: GiveawayConfig, giveaway: GiveawayEmbedData): GiveawayAppearance {
  return applyAppearanceOverrides(config, giveaway.styleOverrides);
}

/**
 * Tout ce qu'il faut pour redessiner un concours : ses réglages, son apparence
 * effective et les rôles avantagés au moment présent.
 */
async function loadStyle(guildId: string, giveaway: GiveawayEmbedData) {
  const config = await getGiveawayConfig(guildId);
  const bonus = await resolveGiveawayBonuses(guildId, config, {
    ignoreBonuses: giveaway.ignoreBonuses === true,
  });
  const itemLabel = await itemLabelFor(guildId, giveaway.rpgItemId);
  return { config, appearance: appearanceOf(config, giveaway), bonus, itemLabel };
}

/**
 * Nom lisible de l'objet mis en jeu, vide quand il n'y en a pas.
 *
 * L'annonce affichait l'identifiant stocké, un cuid que personne ne reconnaît.
 * Le nom est relu à chaque rendu plutôt que figé à la création : un objet
 * renommé dans le module suit alors dans les concours déjà publiés. Un objet
 * disparu ne rend rien, et la ligne s'efface : mieux vaut ne rien promettre que
 * promettre un lot que la remise ne trouvera pas.
 */
async function itemLabelFor(guildId: string, itemId?: string | null): Promise<string> {
  if (!itemId) return '';
  const item = await findGiveawayRpgItem(guildId, itemId);
  if (!item) return '';
  return item.emoji ? `${item.emoji} ${item.name}` : item.name;
}

function textContext(
  giveaway: GiveawayEmbedData,
  participantCount: number,
  locale: BotLocale,
  extra: { winners?: string; guildName?: string; bonusRolesBlock?: string; itemLabel?: string } = {},
): GiveawayTextContext {
  const labels = generatedLabels(locale);
  const { itemLabel, ...rest } = extra;
  const bonus = buildGiveawayBonusInfo(giveaway, labels, itemLabel);
  return {
    id: giveaway.id,
    prize: giveaway.prize,
    winnerCount: giveaway.winnerCount,
    participantCount,
    endsAt: giveaway.endsAt,
    host: giveaway.createdById ? `<@${giveaway.createdById}>` : '',
    descriptionBlock: giveaway.description ? `${giveaway.description}\n\n` : '',
    bonusBlock: bonus ? `\n**${labels.rewardsTitle}**${bonus}\n` : '',
    ...rest,
  };
}

function buildGiveawayBonusInfo(
  giveaway: GiveawayEmbedData,
  labels: GiveawayGeneratedLabels,
  itemLabel?: string,
): string {
  let info = '';
  if ((giveaway.rpgCoins ?? 0) > 0) info += `\n**${labels.coins}** +${giveaway.rpgCoins}`;
  if ((giveaway.rpgXp ?? 0) > 0) info += `\n**${labels.xp}** +${giveaway.rpgXp}`;
  if (itemLabel) info += `\n**${labels.item}** ${itemLabel}`;
  if (giveaway.needValidation) info += `\n*${labels.validation}*`;
  return info;
}

/** Embed d'un giveaway toujours en cours (création + inscriptions). */
function buildActiveGiveawayEmbed(
  giveaway: GiveawayEmbedData,
  participantCount: number,
  appearance: GiveawayAppearance,
  locale: BotLocale,
  extra: { bonusRolesBlock?: string; itemLabel?: string } = {},
): EmbedBuilder {
  const { bonusRolesBlock = '', itemLabel } = extra;
  const template = appearance.descriptionTemplate;
  let description = renderGiveawayText(
    template,
    textContext(giveaway, participantCount, locale, { bonusRolesBlock, itemLabel }),
  );

  // Le serveur a demandé d'annoncer les rôles avantagés, mais son corps
  // d'annonce ne réserve aucune place à la variable : un gabarit écrit avant
  // qu'elle existe, ou remanié à la main. Le bloc part à la suite plutôt que
  // d'être avalé en silence, sans quoi le réglage passerait pour inopérant.
  if (bonusRolesBlock && !template.includes('{bonusRoles}')) {
    description += `\n${bonusRolesBlock}`;
  }

  return buildGiveawayEmbed(giveaway, description, resolveEmbedColor(appearance.embedColorActive), appearance, participantCount, locale, { itemLabel });
}

/**
 * Rôles avantagés à annoncer, vide quand le serveur préfère ne pas les montrer.
 */
function bonusRolesBlockFor(config: GiveawayConfig, bonus: ResolvedBonus): string {
  return config.showBonusRoles ? buildBonusRolesBlock(bonus, config.locale) : '';
}

/**
 * Ligne du bouton « Rejoindre » d'un giveaway actif.
 * En Components V2, les boutons vivent dans `components` au même titre que
 * l'embed : toute édition qui ne les repasse pas les efface. Il faut donc les
 * réinjecter à chaque `message.edit`.
 */
function buildGiveawayJoinRow(
  giveawayId: string,
  appearance: GiveawayAppearance,
): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(`giveaway_join:${giveawayId}`)
    .setLabel(appearance.joinButtonLabel)
    .setStyle(resolveButtonStyle(appearance.joinButtonStyle));

  // Un emoji refusé par Discord ferait échouer l'envoi complet du concours :
  // mieux vaut un bouton sans emoji qu'un giveaway jamais publié.
  try {
    if (appearance.joinButtonEmoji) button.setEmoji(resolveEmojiShortcodes(appearance.joinButtonEmoji));
  } catch {
    // Emoji invalide, on garde le bouton nu.
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/**
 * Bouton grisé d'un concours clos. Il reprend l'emoji du bouton de
 * participation pour que le message garde son identité une fois terminé.
 */
function buildEndedButton(
  giveawayId: string,
  appearance: GiveawayAppearance,
  label: string,
): ButtonBuilder {
  const button = new ButtonBuilder()
    .setCustomId(`giveaway_ended:${giveawayId}`)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  try {
    if (appearance.joinButtonEmoji) button.setEmoji(resolveEmojiShortcodes(appearance.joinButtonEmoji));
  } catch {
    // Emoji invalide, on garde le bouton nu.
  }

  return button;
}

/**
 * Libellé en gras, suivi de ses deux-points.
 *
 * Les traductions portent le seul mot, sans ponctuation. Celle-ci était écrite
 * en dur à la française, espace comprise, et l'embed anglais affichait
 * « Winners : ».
 */
function boldLabel(label: string, locale: BotLocale): string {
  return locale === 'fr' ? `**${label} :**` : `**${label}:**`;
}

/**
 * Corps d'un embed clos : la description du concours, les gagnants annoncés et
 * le nombre de participants. Assemblé ici plutôt que sur place pour que les
 * cinq états parlent la même langue et la même ponctuation.
 */
function buildClosedDescription(
  giveaway: GiveawayEmbedData,
  winnersLabel: string,
  winners: string,
  participantCount: number,
  locale: BotLocale,
): string {
  const intro = giveaway.description ? `${giveaway.description}\n\n` : '';
  const participants = m.gvw_label_participants({}, { locale });
  return `${intro}${boldLabel(winnersLabel, locale)} ${winners}\n${boldLabel(participants, locale)} ${participantCount}`;
}

/** Embed d'un giveaway dans un état terminé/validé (description & couleur fournies). */
function buildGiveawayEmbed(
  giveaway: GiveawayEmbedData,
  description: string,
  color: ColorResolvable,
  appearance: GiveawayAppearance,
  participantCount: number,
  locale: BotLocale,
  extra: { winners?: string; itemLabel?: string } = {},
): EmbedBuilder {
  const ctx = textContext(giveaway, participantCount, locale, extra);
  // Le gabarit est court, mais un lot long le rallonge : Discord refuse tout
  // titre au-delà de 256 caractères et rejetterait l'embed entier.
  const title = resolveEmojiShortcodes(renderGiveawayText(appearance.titleTemplate, ctx)).slice(0, 256);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(resolveEmojiShortcodes(description).slice(0, 4096))
    .setColor(color)
    .setFooter({ text: renderGiveawayText(appearance.footerTemplate, ctx).slice(0, 2048) })
    .setTimestamp();

  if (appearance.thumbnailUrl) embed.setThumbnail(appearance.thumbnailUrl);
  if (appearance.imageUrl) embed.setImage(appearance.imageUrl);

  return embed;
}

/**
 * Crée un nouveau giveaway sur Discord et en BDD
 */
export async function createGiveaway(
  client: Client,
  guildId: string,
  channelId: string,
  prize: string,
  winnerCount: number,
  durationMinutes: number,
  description?: string,
  rpgXp = 0,
  rpgCoins = 0,
  rpgItemId: string | null = null,
  needValidation = false,
  createdById: string | null = null,
  styleOverrides: Partial<GiveawayAppearance> = {},
  ignoreBonuses = false
) {
  const locale = await resolveGuildLocale(guildId);

  if (await isStaffServerGuild(guildId)) {
    throw new Error(m.gvw_err_staff_server({}, { locale }));
  }
  // La tâche de clôture, elle, vérifie l'activation : un concours lancé module
  // éteint ne se fermait donc jamais. Le contrôle se pose ici, seul passage
  // commun au dashboard, à la commande Discord et aux clés MCP.
  if (!(await isModuleEnabled(guildId, 'giveaways'))) {
    throw new Error(m.gvw_err_module_off({}, { locale }));
  }

  const cleanPrize = prize.trim();
  const cleanDescription = description?.trim() || undefined;
  // La commande Discord passe la saisie brute : sans ce nettoyage, une espace
  // en trop ferait échouer la recherche de l'objet puis sa remise.
  const cleanItemId = rpgItemId?.trim() || null;
  if (!cleanPrize || cleanPrize.length > 200) {
    throw new Error(m.gvw_err_prize({}, { locale }));
  }
  if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 20) {
    throw new Error(m.gvw_err_winner_count({}, { locale }));
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 525_600) {
    throw new Error(m.gvw_err_duration({}, { locale }));
  }
  if (cleanDescription && cleanDescription.length > 2_000) {
    throw new Error(m.gvw_err_description({}, { locale }));
  }
  // L'objet se désigne par son identifiant, saisi à la main : sans ce contrôle,
  // l'annonce promettrait un lot que la remise ne trouverait pas.
  if (cleanItemId && !(await findGiveawayRpgItem(guildId, cleanItemId))) {
    throw new Error(m.gvw_err_item({}, { locale }));
  }

  const discordGuild = client.guilds.cache.get(guildId)
    || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) {
    throw new Error(m.gvw_err_guild({}, { locale }));
  }

  const channel = discordGuild.channels.cache.get(channelId)
    || await discordGuild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    throw new Error(m.gvw_err_channel({}, { locale }));
  }

  const cleanOverrides = normalizeAppearancePatch(styleOverrides);
  const endsAt = new Date(Date.now() + durationMinutes * 60 * 1000);

  // 1. Sauvegarder dans la BDD pour générer l'ID
  const giveaway = await prisma.giveaway.create({
    data: {
      guildId,
      channelId,
      prize: cleanPrize,
      winnerCount,
      endsAt,
      description: cleanDescription,
      rpgXp,
      rpgCoins,
      rpgItemId: cleanItemId,
      needValidation,
      validationStatus: needValidation ? 'PENDING' : 'APPROVED',
      createdById,
      styleOverrides: (Object.keys(cleanOverrides).length > 0 ? cleanOverrides : undefined) as Prisma.InputJsonValue | undefined,
      ignoreBonuses,
    },
  });

  // 2. Créer l'embed et le message Discord
  const { config, appearance, bonus, itemLabel } = await loadStyle(guildId, giveaway);
  const embed = buildActiveGiveawayEmbed(giveaway, 0, appearance, config.locale, {
    bonusRolesBlock: bonusRolesBlockFor(config, bonus),
    itemLabel,
  });
  const row = buildGiveawayJoinRow(giveaway.id, appearance);

  let publishedMessage: Message | null = null;
  try {
    publishedMessage = await channel.send({ embeds: [embed], components: [row], allowedMentions: GIVEAWAY_MENTIONS });
    // Mettre à jour avec le messageId
    await prisma.giveaway.update({
      where: { id: giveaway.id },
      data: { messageId: publishedMessage.id },
    });
  } catch (error) {
    // Ne pas conserver un concours impossible à rejoindre dans le dashboard.
    await publishedMessage?.delete().catch(() => undefined);
    await prisma.giveaway.delete({ where: { id: giveaway.id } }).catch(() => undefined);
    throw new Error(m.gvw_err_publish({ reason: errorMessage(error) }, { locale }));
  }

  return giveaway;
}

/**
 * Gère l'action de clic sur le bouton d'inscription d'un giveaway
 */
/** Qui demande à entrer dans un concours, et d'où l'on sait ce qu'il est. */
export type GiveawayParticipant = {
  userId: string;
  roleIds: string[];
  accountCreatedAt: Date | null;
  joinedAt: Date | null;
  guildName: string;
};

export type GiveawayToggleResult =
  | { ok: true; joined: boolean; message: string }
  | { ok: false; reason: 'cooldown' | 'denied' | 'linked' | 'ended' | 'error'; message: string };

/**
 * Entrée ou retrait d'un concours, quelle que soit la porte : bouton Discord
 * ou site communautaire. Toutes les règles vivent ici (délai anti double clic,
 * filtre de participation, comptes liés, verrou de la ligne), ainsi que la
 * mise à jour de l'annonce et l'événement « nouveau participant ».
 */
export async function toggleGiveawayParticipation(
  client: Client,
  guildId: string,
  giveawayId: string,
  participant: GiveawayParticipant,
): Promise<GiveawayToggleResult> {
  const { userId } = participant;

  // Anti-double-clic / Anti-spam : Cooldown de 2 secondes par utilisateur et par giveaway
  const cooldownKey = `${userId}:${giveawayId}`;
  const now = Date.now();
  const lastClick = joinCooldowns.get(cooldownKey);

  if (lastClick && now - lastClick < 2000) {
    return { ok: false, reason: 'cooldown', message: m.gvw_cooldown({}, { locale: await resolveGuildLocale(guildId) }) };
  }
  joinCooldowns.set(cooldownKey, now);

  // Nettoyage automatique du cooldown après 2 secondes
  setTimeout(() => {
    if (joinCooldowns.get(cooldownKey) === now) {
      joinCooldowns.delete(cooldownKey);
    }
  }, 2000);

  // Filtre de participation (onglet Configuration du dashboard). Vérifié avant
  // la transaction : un membre exclu ne doit pas apparaître une seconde dans la
  // liste des participants.
  const config = await getGiveawayConfig(guildId);
  if (hasParticipationRules(config)) {
    const check = await checkParticipation(guildId, {
      userId,
      roleIds: participant.roleIds,
      accountCreatedAt: participant.accountCreatedAt,
      joinedAt: participant.joinedAt,
      guildName: participant.guildName,
    }, config);
    if (!check.allowed) {
      return { ok: false, reason: 'denied', message: resolveEmojiShortcodes(check.reason).slice(0, 2000) };
    }
  }

  /**
   * Comptes déclarés comme appartenant à la même personne. Lus avant la
   * transaction : la comparaison avec la liste des participants se fait ensuite
   * en mémoire, sans allonger le verrou de la ligne.
   */
  const linkedUserIds = config.blockLinkedAccounts
    ? await getAllLinkedUserIds(guildId, userId).catch(() => [userId])
    : [];

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Verrouiller la ligne du giveaway pour bloquer les écritures/lectures concurrentes
      await tx.$queryRaw`SELECT 1 FROM giveaways WHERE id = ${giveawayId} FOR UPDATE`;

      // 2. Récupérer les données verrouillées et fraîches
      const giveaway = await tx.giveaway.findUnique({
        where: { id: giveawayId },
      });

      // Le serveur est revérifié : le site désigne le concours par son seul identifiant.
      if (!giveaway || giveaway.ended || giveaway.guildId !== guildId) {
        throw new Error('ENDED_OR_NOT_FOUND');
      }

      const isParticipant = giveaway.participants.includes(userId);

      // Une personne, une entrée : un second compte n'entre pas, mais chacun
      // reste libre de retirer sa propre participation.
      if (!isParticipant && linkedUserIds.some((id) => id !== userId && giveaway.participants.includes(id))) {
        throw new Error('LINKED_ACCOUNT');
      }

      let updatedParticipants = [...giveaway.participants];
      let responseText = '';

      const appearance = applyAppearanceOverrides(config, giveaway.styleOverrides);
      const renderReply = (template: string) => renderGiveawayText(template, {
        id: giveaway.id,
        prize: giveaway.prize,
        winnerCount: giveaway.winnerCount,
        participantCount: updatedParticipants.length,
        endsAt: giveaway.endsAt,
        host: giveaway.createdById ? `<@${giveaway.createdById}>` : '',
        guildName: participant.guildName,
      });

      if (isParticipant) {
        // Se désinscrire
        updatedParticipants = updatedParticipants.filter(id => id !== userId);
        responseText = renderReply(appearance.leaveReplyTemplate);
      } else {
        // S'inscrire
        updatedParticipants.push(userId);
        responseText = renderReply(appearance.joinReplyTemplate);
      }

      await tx.giveaway.update({
        where: { id: giveawayId },
        data: { participants: updatedParticipants },
      });

      return {
        responseText,
        updatedParticipants,
        giveaway,
        appearance,
        // `isParticipant` valait l'état d'avant : on ressort le geste, pas lui.
        joined: !isParticipant,
      };
    });

    const { responseText, updatedParticipants, giveaway, appearance, joined } = result;

    // 4. Mettre à jour l'embed Discord en temps réel
    if (giveaway.messageId) {
      const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
        if (message) {
          // Les rôles avantagés figurent dans l'embed : sans les résoudre ici,
          // l'édition les effacerait au premier clic d'un participant.
          const bonus = await resolveGiveawayBonuses(giveaway.guildId, config, {
            ignoreBonuses: giveaway.ignoreBonuses,
          });
          const bonusRolesBlock = bonusRolesBlockFor(config, bonus);
          const updatedEmbed = buildActiveGiveawayEmbed(giveaway, updatedParticipants.length, appearance, config.locale, {
            bonusRolesBlock,
            itemLabel: await itemLabelFor(giveaway.guildId, giveaway.rpgItemId),
          });
          // On repasse le bouton « Rejoindre » : en Components V2 une édition qui
          // ne fournit pas `components` efface les boutons du message.
          await message.edit({
            embeds: [updatedEmbed],
            components: [buildGiveawayJoinRow(giveaway.id, appearance)],
            allowedMentions: GIVEAWAY_MENTIONS,
          }).catch(() => null);
        }
      }
    }

    // Une entrée seulement : le retrait n'a pas de déclencheur, et republier
    // dessus ferait tourner un workflow « nouveau participant » à l'envers.
    if (joined) {
      kotboEventBus.publish('giveaway:entry', {
        guildId,
        giveawayId,
        userId,
        prize: giveaway.prize,
        channelId: giveaway.channelId,
        participantCount: updatedParticipants.length,
        timestamp: Date.now(),
      });
    }

    publishGuildSignal(guildId, 'module:giveaways');
    return { ok: true, joined, message: resolveEmojiShortcodes(responseText).slice(0, 2000) };
  } catch (err: unknown) {
    if (errorMessage(err) === 'LINKED_ACCOUNT') {
      return {
        ok: false,
        reason: 'linked',
        message: resolveEmojiShortcodes(deniedLinkedAccountText(config, participant.guildName)).slice(0, 2000),
      };
    }
    if (errorMessage(err) === 'ENDED_OR_NOT_FOUND') {
      return { ok: false, reason: 'ended', message: m.gvw_join_ended({}, { locale: config.locale }) };
    }
    logger.error('GiveawayService', 'Erreur lors de toggleGiveawayParticipation :', err);
    return { ok: false, reason: 'error', message: m.gvw_join_error({}, { locale: config.locale }) };
  }
}

export async function handleGiveawayJoin(interaction: ButtonInteraction) {
  const giveawayId = interaction.customId.split(':')[1];
  const guildId = interaction.guildId;

  // Un concours vit dans un salon de serveur : hors serveur, ni les réglages ni
  // les rôles du membre ne sont lisibles, et le tirage n'a plus de sens.
  if (!guildId) {
    return interaction.reply({
      // Hors serveur, la seule langue connue est celle du client Discord.
      content: m.gvw_guild_only({}, { locale: getLocale(interaction) }),
      flags: [MessageFlags.Ephemeral],
    });
  }

  const result = await toggleGiveawayParticipation(interaction.client, guildId, giveawayId, {
    userId: interaction.user.id,
    roleIds: memberRoleIds(interaction),
    accountCreatedAt: interaction.user.createdAt ?? null,
    joinedAt: memberJoinedAt(interaction),
    guildName: interaction.guild?.name ?? '',
  });

  return interaction.reply({
    content: result.message,
    flags: [MessageFlags.Ephemeral],
  });
}

/**
 * Redessine les annonces des concours encore ouverts d'un serveur.
 *
 * Un embed n'est réécrit qu'au clic d'un participant ou à la clôture : changer
 * la couleur, le libellé du bouton ou les rôles avantagés ne se voyait donc
 * nulle part avant qu'un membre ne clique, ce qui faisait passer le réglage
 * pour inopérant. La page de configuration appelle ceci après un
 * enregistrement.
 *
 * Best-effort : un message supprimé ou un salon devenu inaccessible est passé,
 * les autres sont mis à jour.
 */
export async function refreshActiveGiveaways(client: Client, guildId: string): Promise<number> {
  const active = await prisma.giveaway.findMany({
    where: { guildId, ended: false, messageId: { not: null } },
  });
  if (active.length === 0) return 0;

  const config = await getGiveawayConfig(guildId);
  let refreshed = 0;

  for (const giveaway of active) {
    try {
      const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
      if (!channel?.isTextBased()) continue;

      const message = await channel.messages.fetch(giveaway.messageId as string).catch(() => null);
      if (!message) continue;

      const appearance = applyAppearanceOverrides(config, giveaway.styleOverrides);
      const bonus = await resolveGiveawayBonuses(guildId, config, {
        ignoreBonuses: giveaway.ignoreBonuses,
      });

      await message.edit({
        embeds: [buildActiveGiveawayEmbed(
          giveaway,
          giveaway.participants.length,
          appearance,
          config.locale,
          {
            bonusRolesBlock: bonusRolesBlockFor(config, bonus),
            itemLabel: await itemLabelFor(guildId, giveaway.rpgItemId),
          },
        )],
        // En Components V2, une édition sans `components` efface les boutons.
        components: [buildGiveawayJoinRow(giveaway.id, appearance)],
        allowedMentions: GIVEAWAY_MENTIONS,
      });
      refreshed += 1;
    } catch (err) {
      logger.error('GiveawayService', `Annonce du giveaway ${giveaway.id} non rafraîchie :`, err);
    }
  }

  return refreshed;
}

/**
 * Retire un membre de tous les giveaways en cours d'un serveur.
 *
 * Appele quand il quitte le serveur : sans cela il reste dans le tirage et
 * peut gagner un lot qu'il ne pourra pas recevoir, au detriment des membres
 * encore presents.
 *
 * Le verrou de ligne reprend celui de `handleGiveawayJoin` : une inscription
 * simultanee ne doit pas ecraser le retrait, ni l'inverse.
 */
export async function removeMemberFromActiveGiveaways(
  client: Client,
  guildId: string,
  userId: string,
): Promise<number> {
  const affected = await prisma.giveaway.findMany({
    where: { guildId, ended: false, participants: { has: userId } },
    select: { id: true },
  });
  if (affected.length === 0) return 0;

  let removedCount = 0;

  for (const { id } of affected) {
    try {
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM giveaways WHERE id = ${id} FOR UPDATE`;

        const giveaway = await tx.giveaway.findUnique({ where: { id } });
        // Le giveaway a pu se terminer, ou le membre en sortir, entre la
        // selection et la prise du verrou.
        if (!giveaway || giveaway.ended || !giveaway.participants.includes(userId)) return null;

        const participants = giveaway.participants.filter((participantId) => participantId !== userId);
        await tx.giveaway.update({ where: { id }, data: { participants } });

        return { giveaway, participants };
      });

      if (!updated) continue;
      removedCount += 1;

      // L'embed affiche le nombre de participants : le laisser tel quel
      // afficherait un compteur faux jusqu'au prochain clic.
      const { giveaway, participants } = updated;
      if (!giveaway.messageId) continue;

      const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
      if (!channel?.isTextBased()) continue;

      const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
      if (!message) continue;

      const { config, appearance, bonus, itemLabel } = await loadStyle(guildId, giveaway);
      await message.edit({
        embeds: [buildActiveGiveawayEmbed(giveaway, participants.length, appearance, config.locale, {
          bonusRolesBlock: bonusRolesBlockFor(config, bonus),
          itemLabel,
        })],
        // En Components V2, une edition sans `components` efface les boutons.
        components: [buildGiveawayJoinRow(giveaway.id, appearance)],
        allowedMentions: GIVEAWAY_MENTIONS,
      }).catch(() => null);
    } catch (err) {
      logger.error(
        'GiveawayService',
        `Impossible de retirer ${userId} du giveaway ${id} :`,
        err,
      );
    }
  }

  return removedCount;
}

/**
 * Annonce la clôture d'un concours, gagnants ou non.
 *
 * Publié dans les deux cas, y compris quand le tirage attend la validation du
 * staff : le concours est bel et bien fermé, et un workflow qui range le salon
 * ou remercie les participants n'a pas à attendre ce feu vert.
 */
function publishGiveawayEnded(
  giveaway: { id: string; guildId: string; channelId: string; prize: string; participants: string[] },
  winnerCount: number,
): void {
  kotboEventBus.publish('giveaway:ended', {
    guildId: giveaway.guildId,
    giveawayId: giveaway.id,
    prize: giveaway.prize,
    channelId: giveaway.channelId,
    participantCount: giveaway.participants.length,
    winnerCount,
    timestamp: Date.now(),
  });
}

/**
 * Termine un giveaway actif et tire les gagnants
 */
export async function endGiveaway(client: Client, giveawayId: string, expectedGuildId?: string) {
  const giveaway = await prisma.giveaway.findFirst({
    where: { id: giveawayId, ...(expectedGuildId ? { guildId: expectedGuildId } : {}) },
  });

  if (!giveaway && expectedGuildId) {
    throw new Error('Giveaway introuvable sur ce serveur.');
  }
  if (!giveaway || giveaway.ended) return;

  const discordGuild = client.guilds.cache.get(giveaway.guildId) || await client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (!discordGuild) return;

  /**
   * Salon d'annonce, nul quand il a disparu ou s'est fermé au bot.
   *
   * Son absence n'interrompt plus la clôture. Elle le faisait, et la tâche
   * reprenait alors le concours chaque minute sans jamais aboutir : il restait
   * ouvert indéfiniment, ses gagnants jamais tirés ni servis. Le tirage, la
   * remise et la transition d'état n'ont pas besoin du salon ; seuls les
   * messages en dépendent, et eux seuls sont sautés.
   */
  const announceChannel = discordGuild.channels.cache.get(giveaway.channelId)
    || await discordGuild.channels.fetch(giveaway.channelId).catch(() => null);
  const channel = announceChannel?.isTextBased() ? announceChannel : null;

  const { config, appearance, bonus, itemLabel } = await loadStyle(giveaway.guildId, giveaway);

  // Tirer les gagnants en appliquant les chances supplémentaires
  const candidates = await foldLinkedCandidates(giveaway.guildId, giveaway.participants, config);
  const winners = await drawWinnersWeighted(candidates, giveaway.winnerCount, discordGuild, bonus);

  const winnersMentions = winners.length > 0
    ? winners.map(w => `<@${w}>`).join(', ')
    : m.gvw_no_entrant({}, { locale: config.locale });
  const renderAnnounce = (template: string) => renderGiveawayText(template, {
    id: giveaway.id,
    prize: giveaway.prize,
    winnerCount: giveaway.winnerCount,
    participantCount: giveaway.participants.length,
    endsAt: giveaway.endsAt,
    winners: winnersMentions,
    host: giveaway.createdById ? `<@${giveaway.createdById}>` : '',
    guildName: discordGuild.name,
  });

  if (giveaway.needValidation) {
    // On marque le giveaway comme terminé AVANT toute opération Discord : la
    // transition d'état doit avoir lieu même si le message n'est plus
    // récupérable, sinon le cron le reclôturerait en boucle chaque minute.
    await prisma.giveaway.update({
      where: { id: giveawayId },
      data: {
        ended: true,
        validationStatus: 'PENDING',
        pendingWinners: winners,
      },
    });

    // Mise à jour du message d'origine (best-effort)
    if (channel && giveaway.messageId) {
      const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
      if (message) {
        const endedEmbed = buildGiveawayEmbed(
          giveaway,
          buildClosedDescription(
            giveaway,
            m.gvw_label_winners_pending({}, { locale: config.locale }),
            winnersMentions,
            giveaway.participants.length,
            config.locale,
          ),
          resolveEmbedColor(appearance.embedColorPending),
          appearance,
          giveaway.participants.length,
          config.locale,
          { winners: winnersMentions, itemLabel },
        );

        const approveBtn = new ButtonBuilder()
          .setCustomId(`giveaway_val_approve:${giveaway.id}`)
          .setLabel(m.gvw_btn_approve_many({}, { locale: config.locale }))
          .setStyle(ButtonStyle.Success);

        const rerollBtn = new ButtonBuilder()
          .setCustomId(`giveaway_val_reroll:${giveaway.id}`)
          .setLabel(m.gvw_btn_reroll({}, { locale: config.locale }))
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, rerollBtn);
        await message.edit({ embeds: [endedEmbed], components: [row], allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
      }
    }

    await channel?.send({
      content: m.gvw_announce_pending(
        { prize: giveaway.prize, winners: winnersMentions },
        { locale: config.locale },
      ),
      allowedMentions: GIVEAWAY_MENTIONS,
    }).catch(() => null);
    publishGiveawayEnded(giveaway, winners.length);
    return;
  }

  // Pas de validation requise, gain direct : on fige l'état et on distribue
  // exactement une fois, indépendamment de la disponibilité du message.
  await prisma.giveaway.update({
    where: { id: giveawayId },
    data: {
      ended: true,
      validationStatus: 'APPROVED',
      winners,
    },
  });

  await distributeGiveawayPrizes(giveaway, winners).catch((err) => {
    logger.error('GiveawayService', 'Error distributing prizes in endGiveaway:', err);
  });

  // Mise à jour du message d'origine (best-effort)
  if (channel && giveaway.messageId) {
    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (message) {
      const endedEmbed = buildGiveawayEmbed(
        giveaway,
        buildClosedDescription(
          giveaway,
          m.gvw_label_winners({}, { locale: config.locale }),
          winnersMentions,
          giveaway.participants.length,
          config.locale,
        ),
        resolveEmbedColor(appearance.embedColorEnded),
        appearance,
        giveaway.participants.length,
        config.locale,
        { winners: winnersMentions, itemLabel },
      );

      const disabledButton = buildEndedButton(giveaway.id, appearance, m.gvw_btn_ended({}, { locale: config.locale }));
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton);

      await message.edit({ embeds: [endedEmbed], components: [row], allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
    }
  }

  publishGiveawayEnded(giveaway, winners.length);

  // Annoncer le résultat direct
  const announcement = winners.length > 0
    ? renderAnnounce(appearance.announceWinnersTemplate)
    : renderAnnounce(appearance.announceNoWinnerTemplate);
  if (channel && announcement.trim()) {
    // Un gabarit long plus vingt mentions de gagnants peuvent franchir la
    // limite d'un message Discord, qui rejetterait alors toute l'annonce.
    await channel.send({
      content: resolveEmojiShortcodes(announcement).slice(0, 2000),
      allowedMentions: GIVEAWAY_MENTIONS,
    }).catch(() => null);
  }
}

/**
 * Supprime un concours et l'annonce qui le porte.
 *
 * Effacer la seule ligne laissait le message Discord en place, compte à rebours
 * et bouton compris. Un membre cliquait sur un concours que plus rien ne
 * clôturerait, et s'entendait répondre qu'il était terminé sans que rien à
 * l'écran ne le dise. Le message part donc avec, au mieux de ce que Discord
 * permet : un message déjà effacé à la main ne fait pas échouer la suppression.
 */
export async function deleteGiveaway(
  client: Client,
  giveawayId: string,
  guildId: string,
): Promise<boolean> {
  const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId } });
  if (!giveaway) return false;

  if (giveaway.messageId) {
    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
      await message?.delete().catch(() => undefined);
    }
  }

  await prisma.giveaway.delete({ where: { id: giveawayId } });
  return true;
}

/**
 * Sélectionne un nouveau gagnant (Reroll).
 *
 * Répond si un gagnant a bien été tiré. Le geste échouait en silence quand il
 * ne restait personne à tirer, ou quand le salon avait disparu : le bouton de
 * validation comme le dashboard annonçaient tout de même une relance réussie,
 * alors que rien n'avait changé.
 */
export async function rerollGiveaway(
  client: Client,
  giveawayId: string,
  expectedGuildId?: string,
): Promise<boolean> {
  const giveaway = await prisma.giveaway.findFirst({
    where: { id: giveawayId, ...(expectedGuildId ? { guildId: expectedGuildId } : {}) },
  });

  if (!giveaway && expectedGuildId) {
    throw new Error('Giveaway introuvable sur ce serveur.');
  }
  if (!giveaway || !giveaway.ended) return false;

  const discordGuild = client.guilds.cache.get(giveaway.guildId) || await client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (!discordGuild) return false;

  const channel = discordGuild.channels.cache.get(giveaway.channelId)
    || await discordGuild.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const { config, appearance, bonus, itemLabel } = await loadStyle(giveaway.guildId, giveaway);

  // Filtrer les participants qui ne sont pas déjà gagnants validés
  const remaining = giveaway.participants.filter(id => !giveaway.winners.includes(id));
  const candidates = await foldLinkedCandidates(giveaway.guildId, remaining, config);
  if (candidates.length === 0) {
    await channel.send({ content: m.gvw_reroll_no_candidate({ prize: giveaway.prize }, { locale: config.locale }), allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
    return false;
  }

  const newWinners = await drawWinnersWeighted(candidates, 1, discordGuild, bonus);
  const newWinner = newWinners[0];
  // Le tirage écarte les participants qui ont quitté le serveur : la liste peut
  // donc revenir vide alors que des candidats existaient en base. Sans ce
  // garde-fou, `undefined` partait en base et le salon annonçait « <@undefined> ».
  if (!newWinner) {
    await channel.send({ content: m.gvw_reroll_no_candidate({ prize: giveaway.prize }, { locale: config.locale }), allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
    return false;
  }

  if (giveaway.needValidation) {
    // Si validation requise, on met à jour en tant que gagnant en attente
    await prisma.giveaway.update({
      where: { id: giveawayId },
      data: {
        validationStatus: 'PENDING',
        pendingWinners: [newWinner],
      },
    });

    if (giveaway.messageId) {
      const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
      if (message) {
        const endedEmbed = buildGiveawayEmbed(
          giveaway,
          buildClosedDescription(
            giveaway,
            m.gvw_label_winner_reroll_pending({}, { locale: config.locale }),
            `<@${newWinner}>`,
            giveaway.participants.length,
            config.locale,
          ),
          resolveEmbedColor(appearance.embedColorPending),
          appearance,
          giveaway.participants.length,
          config.locale,
          { winners: `<@${newWinner}>`, itemLabel },
        );

        const approveBtn = new ButtonBuilder()
          .setCustomId(`giveaway_val_approve:${giveaway.id}`)
          .setLabel(m.gvw_btn_approve_one({}, { locale: config.locale }))
          .setStyle(ButtonStyle.Success);

        const rerollBtn = new ButtonBuilder()
          .setCustomId(`giveaway_val_reroll:${giveaway.id}`)
          .setLabel(m.gvw_btn_reroll({}, { locale: config.locale }))
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, rerollBtn);
        await message.edit({ embeds: [endedEmbed], components: [row], allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
      }
    }

    await channel.send({ content: m.gvw_reroll_pending({ winner: `<@${newWinner}>` }, { locale: config.locale }), allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
  } else {
    // Pas de validation requise, gain immédiat
    const updatedWinners = [...giveaway.winners, newWinner];

    await prisma.giveaway.update({
      where: { id: giveawayId },
      data: {
        winners: updatedWinners,
        validationStatus: 'APPROVED'
      },
    });

    await distributeGiveawayPrizes(giveaway, [newWinner]).catch((err) => {
      logger.error('GiveawayService', 'Error distributing reroll prizes:', err);
    });

    if (giveaway.messageId) {
      const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
      if (message) {
        const winnersMentions = updatedWinners.map(w => `<@${w}>`).join(', ');
        const endedEmbed = buildGiveawayEmbed(
          giveaway,
          buildClosedDescription(
            giveaway,
            m.gvw_label_winners_reroll({}, { locale: config.locale }),
            winnersMentions,
            giveaway.participants.length,
            config.locale,
          ),
          resolveEmbedColor(appearance.embedColorEnded),
          appearance,
          giveaway.participants.length,
          config.locale,
          { winners: winnersMentions, itemLabel },
        );

        const disabledButton = buildEndedButton(giveaway.id, appearance, m.gvw_btn_ended({}, { locale: config.locale }));
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton);

        await message.edit({ embeds: [endedEmbed], components: [row], allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
      }
    }

    await channel.send({ content: m.gvw_reroll_announce({ winner: `<@${newWinner}>`, prize: giveaway.prize }, { locale: config.locale }), allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
  }

  return true;
}

/**
 * Valide les gagnants en attente et distribue les prix.
 */
export async function approveGiveawayWinners(client: Client, giveawayId: string) {
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
  });

  if (!giveaway || !giveaway.ended || giveaway.validationStatus !== 'PENDING') return;

  const winners = giveaway.pendingWinners;

  // Mettre à jour en BDD
  await prisma.giveaway.update({
    where: { id: giveawayId },
    data: {
      validationStatus: 'APPROVED',
      winners,
      pendingWinners: [],
    },
  });

  // Distribuer les prix
  await distributeGiveawayPrizes(giveaway, winners).catch((err) => {
    logger.error('GiveawayService', 'Error distributing prizes on approval:', err);
  });

  const { config, appearance, itemLabel } = await loadStyle(giveaway.guildId, giveaway);

  // Mettre à jour le message d'origine
  const discordGuild = client.guilds.cache.get(giveaway.guildId) || await client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (!discordGuild) return;
  const channel = discordGuild.channels.cache.get(giveaway.channelId)
    || await discordGuild.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  if (giveaway.messageId) {
    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (message) {
      const winnersMentions = winners.length > 0
        ? winners.map((w: string) => `<@${w}>`).join(', ')
        : m.gvw_none({}, { locale: config.locale });
      const endedEmbed = buildGiveawayEmbed(
        giveaway,
        buildClosedDescription(
          giveaway,
          m.gvw_label_winners_validated({}, { locale: config.locale }),
          winnersMentions,
          giveaway.participants.length,
          config.locale,
        ),
        resolveEmbedColor(appearance.embedColorValidated),
        appearance,
        giveaway.participants.length,
        config.locale,
        { winners: winnersMentions, itemLabel },
      );

      const disabledButton = buildEndedButton(giveaway.id, appearance, m.gvw_btn_ended_validated({}, { locale: config.locale }));
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton);

      await message.edit({ embeds: [endedEmbed], components: [row], allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
    }
  }

  // Annoncer le résultat final
  if (winners.length > 0) {
    const mentions = winners.map((w: string) => `<@${w}>`).join(', ');
    await channel.send({ content: m.gvw_validated_announce({ winners: mentions, prize: giveaway.prize }, { locale: config.locale }), allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
  } else {
    await channel.send({ content: m.gvw_validated_none({ prize: giveaway.prize }, { locale: config.locale }), allowedMentions: GIVEAWAY_MENTIONS }).catch(() => null);
  }
}

/**
 * Objet RPG remettable sur un serveur : l'un des siens, ou un objet livré de
 * base avec le bot.
 *
 * Une recherche par le seul identifiant acceptait l'objet d'un autre serveur,
 * que le gagnant aurait reçu sans pouvoir s'en servir.
 */
async function findGiveawayRpgItem(guildId: string, itemId: string) {
  return prisma.rpgItem.findFirst({
    where: { id: itemId, OR: [{ guildId: null }, { guildId }] },
  });
}

/**
 * Objets qu'un concours de ce serveur peut remettre, pour l'autocomplétion de
 * la commande et le sélecteur du dashboard.
 */
export async function listGiveawayRpgItems(guildId: string) {
  return prisma.rpgItem.findMany({
    where: { OR: [{ guildId: null }, { guildId }] },
    select: { id: true, name: true, emoji: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * Distribue les récompenses d'un giveaway aux profils des gagnants.
 */
async function distributeGiveawayPrizes(giveaway: {
  id: string;
  guildId: string;
  channelId: string;
  prize: string;
  rpgXp?: unknown;
  rpgCoins?: unknown;
  rpgItemId?: unknown;
}, winners: string[]) {
  if (winners.length === 0) return;

  const rpgXp = (giveaway.rpgXp as number) || 0;
  const rpgCoins = (giveaway.rpgCoins as number) || 0;
  const rpgItemId = (giveaway.rpgItemId as string | null) || null;

  const { checkLevelUp } = await import('./economyService.js');

  for (const userId of winners) {
    // 1. KotboCoins
    if (rpgCoins > 0) {
      await prisma.rpgProfile.upsert({
        where: { guildId_userId: { guildId: giveaway.guildId, userId } },
        update: { balance: { increment: rpgCoins } },
        create: {
          guildId: giveaway.guildId,
          userId,
          balance: rpgCoins,
          level: 1,
          xp: 0,
          health: 100,
          maxHealth: 100,
          energy: 100,
          attack: 10,
          defense: 10,
          speed: 10
        }
      });
    }

    // 2. XP RPG
    if (rpgXp > 0) {
      await prisma.rpgProfile.upsert({
        where: { guildId_userId: { guildId: giveaway.guildId, userId } },
        update: { xp: { increment: rpgXp } },
        create: {
          guildId: giveaway.guildId,
          userId,
          balance: 0,
          level: 1,
          xp: rpgXp,
          health: 100,
          maxHealth: 100,
          energy: 100,
          attack: 10,
          defense: 10,
          speed: 10
        }
      });
      await checkLevelUp(giveaway.guildId, userId).catch(() => null);
    }

    // 3. Objet RPG
    if (rpgItemId) {
      const item = await findGiveawayRpgItem(giveaway.guildId, rpgItemId);
      // L'identifiant se saisit à la main : sans cette trace, un objet supprimé
      // depuis laisserait le gagnant sans son lot et personne n'en saurait rien.
      if (!item) {
        logger.error(
          'GiveawayService',
          `Objet ${rpgItemId} introuvable sur ${giveaway.guildId} : lot du concours « ${giveaway.prize} » non remis à ${userId}.`,
        );
      } else {
        const profile = await upsertRetryingRace(() => prisma.rpgProfile.upsert({
          where: { guildId_userId: { guildId: giveaway.guildId, userId } },
          update: {},
          create: {
            guildId: giveaway.guildId,
            userId,
            balance: 0,
            level: 1,
            xp: 0,
            health: 100,
            maxHealth: 100,
            energy: 100,
            attack: 10,
            defense: 10,
            speed: 10
          }
        }));

        await prisma.rpgInventoryItem.upsert({
          where: {
            rpgProfileId_itemId: {
              rpgProfileId: profile.id,
              itemId: item.id
            }
          },
          update: { quantity: { increment: 1 } },
          create: {
            rpgProfileId: profile.id,
            itemId: item.id,
            quantity: 1
          }
        });
      }
    }

    // Le gain est acquis : ce tour est traversé par tout gagnant confirmé, que
    // la clôture directe, la relance ou la validation du staff l'ait désigné, et
    // qu'il y ait ou non des récompenses du module RPG à lui verser. Publié en
    // fin de tour pour qu'un workflow qui lit son profil y trouve ce qu'on
    // vient d'y mettre.
    kotboEventBus.publish('giveaway:winner', {
      guildId: giveaway.guildId,
      giveawayId: giveaway.id,
      userId,
      prize: giveaway.prize,
      channelId: giveaway.channelId,
      timestamp: Date.now(),
    });
  }
}

/**
 * Vérifie toutes les minutes les concours expirés et les clôture.
 *
 * Un module éteint ne dispense plus de clôturer. La tâche sautait ces serveurs,
 * et un concours publié puis privé de son module restait ouvert pour toujours :
 * son compte à rebours dépassé, son bouton toujours actif, des membres qui
 * continuaient de s'inscrire à un tirage que rien n'allait faire. Éteindre le
 * module empêche d'en lancer un nouveau, c'est le contrôle de `createGiveaway` ;
 * il n'annule pas une promesse déjà faite au salon.
 */
export async function checkExpiredGiveaways(client: Client) {
  try {
    const expired = await prisma.giveaway.findMany({
      where: {
        ended: false,
        endsAt: { lte: new Date() },
      },
    });

    for (const giveaway of expired) {
      await endGiveaway(client, giveaway.id);
    }
  } catch (err) {
    logger.error('GiveawayService', 'Erreur lors de la vérification des giveaways expirés :', err);
  }
}

/**
 * Presence et roles des candidats, resolus par la meme requete.
 *
 * Les roles se lisaient ensuite dans le cache des membres, que cette
 * recuperation venait de remplir. Quand elle echouait, la liste repartait
 * intacte mais le cache restait vide : chaque candidat pesait 1, et les chances
 * supplementaires ne s'appliquaient pas sans que rien ne le signale. Les roles
 * sortent donc d'ici, et leur absence se dit.
 *
 * Toute panne de resolution rend la liste inchangee : mieux vaut un tirage
 * parmi des candidats non verifies qu'un giveaway sans gagnant parce que
 * Discord n'a pas repondu.
 */
interface ResolvedCandidates {
  present: string[];
  /** Vide quand Discord n'a pas repondu : le tirage est alors egalitaire. */
  rolesByUser: Map<string, string[]>;
}

async function resolveCandidates(
  discordGuild: Guild | null | undefined,
  candidates: string[],
): Promise<ResolvedCandidates> {
  const rolesByUser = new Map<string, string[]>();
  if (!discordGuild || candidates.length === 0) return { present: candidates, rolesByUser };

  try {
    const fetched = await discordGuild.members.fetch({ user: candidates });
    for (const [userId, member] of fetched) {
      rolesByUser.set(userId, [...member.roles.cache.keys()]);
    }
    // Zero membre resolu ressemble davantage a un echec de recuperation qu'a
    // un depart general : on ne vide pas le tirage sur ce seul signal.
    if (fetched.size === 0) return { present: candidates, rolesByUser };
    return { present: candidates.filter((userId) => fetched.has(userId)), rolesByUser };
  } catch (err) {
    logger.error('GiveawayService', 'Impossible de verifier la presence des participants :', err);
    return { present: candidates, rolesByUser };
  }
}

/**
 * Ne garde qu'un candidat par personne quand le serveur replie les comptes liés.
 *
 * Le refus au clic ne suffit pas : un lien validé après les inscriptions
 * laisserait deux comptes de la même personne dans le tirage. Le premier
 * inscrit est retenu, choix stable d'une clôture à l'autre.
 */
async function foldLinkedCandidates(
  guildId: string,
  candidates: string[],
  config: GiveawayConfig,
): Promise<string[]> {
  if (!config.blockLinkedAccounts || candidates.length < 2) return candidates;

  try {
    const rootOf = await buildLinkedAccountFolder(guildId);
    const seen = new Set<string>();
    return candidates.filter((userId) => {
      const root = rootOf(userId);
      if (seen.has(root)) return false;
      seen.add(root);
      return true;
    });
  } catch (err) {
    // Un repli impossible ne doit pas annuler le tirage : mieux vaut un doublon
    // qu'un concours sans gagnant.
    logger.error('GiveawayService', `Comptes liés illisibles sur ${guildId} :`, err);
    return candidates;
  }
}

/**
 * Choisit `count` gagnants parmi les candidats, en appliquant les chances
 * supplémentaires déjà résolues par `resolveGiveawayBonuses`.
 *
 * Exporté pour les tests : c'est le seul endroit où se décide l'équité d'un
 * tirage, et l'atteindre par `endGiveaway` demanderait un serveur, un salon et
 * une remise de lots pour n'observer qu'un nom.
 */
export async function drawWinnersWeighted(
  candidates: string[],
  count: number,
  discordGuild: Guild | null,
  bonus: ResolvedBonus
): Promise<string[]> {
  if (candidates.length === 0 || count <= 0) return [];

  // Filet de sécurité : l'écouteur de départ retire les participants qui
  // quittent le serveur, mais il ne voit rien quand le bot est hors ligne.
  // On revérifie donc la présence au moment du tirage, seul endroit traversé
  // par la clôture comme par le reroll.
  const { present, rolesByUser } = await resolveCandidates(discordGuild, candidates);
  if (present.length === 0) return [];

  const winners: string[] = [];
  const pool = [...present];

  // Des rôles avantagés réglés mais aucun rôle lu : le tirage qui suit sera
  // égalitaire alors que l'annonce a promis le contraire. Personne ne peut le
  // deviner du résultat, on le dit donc ici.
  if (bonus.entries.length > 0 && rolesByUser.size === 0) {
    logger.error(
      'GiveawayService',
      'Roles des participants illisibles : tirage egalitaire malgre les chances supplementaires annoncees.',
    );
  }

  // Sans rôle avantagé, ou sans rôle lisible, tirage uniforme.
  if (bonus.entries.length === 0 || rolesByUser.size === 0) {
    const actualCount = Math.min(count, pool.length);
    for (let i = 0; i < actualCount; i++) {
      const randIndex = Math.floor(Math.random() * pool.length);
      winners.push(pool[randIndex]);
      pool.splice(randIndex, 1);
    }
    return winners;
  }

  // Tirage pondéré
  const actualCount = Math.min(count, pool.length);
  for (let i = 0; i < actualCount; i++) {
    // Calculer les poids de chaque candidat restant
    const weights: number[] = [];
    let totalWeight = 0;

    for (const userId of pool) {
      const weight = weightForRoles(rolesByUser.get(userId) ?? [], bonus);
      weights.push(weight);
      totalWeight += weight;
    }

    // Sélection aléatoire pondérée
    let randomVal = Math.random() * totalWeight;
    let selectedIndex = 0;

    for (let j = 0; j < pool.length; j++) {
      randomVal -= weights[j];
      if (randomVal <= 0) {
        selectedIndex = j;
        break;
      }
    }

    winners.push(pool[selectedIndex]);
    pool.splice(selectedIndex, 1);
  }

  return winners;
}

/**
 * Boutique sur Discord (`/boutique`) : un panneau éphémère, l'offre choisie
 * dans un menu, puis acheter, offrir (choix du membre) ou commander avec un
 * code promo et un message au staff (fenêtre modale).
 *
 * `customId` : `shop:<action>[:<offre>]`. Le panneau est éphémère : seul le
 * membre qui l'a ouvert peut s'en servir.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type Client,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type { ShopOffer } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { siteUrl } from '../site/siteNotifyService.js';
import { formatShopPrice, getShopSettings, listShopOffers, purchaseShopOffer, ShopError } from './shopService.js';
import { shopErrorMessage } from './shopMessages.js';

type Locale = 'fr' | 'en';
type ShopView = { embeds: EmbedBuilder[]; components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<UserSelectMenuBuilder>> };

const ACCENT = 0x5865f2;

async function localeOf(interaction: Parameters<typeof getEffectiveLocale>[0]): Promise<Locale> {
  return (await getEffectiveLocale(interaction)) === 'en' ? 'en' : 'fr';
}

function roleName(guild: Guild | null, roleId: string | null): string {
  return (roleId && guild?.roles.cache.get(roleId)?.name) || roleId || '';
}

async function summary(guild: Guild | null, offer: ShopOffer, o: { locale: Locale }): Promise<string> {
  switch (offer.kind) {
    case 'ROLE':
      return offer.durationDays
        ? m.site_shop_kind_role_timed({ role: roleName(guild, offer.roleId), days: offer.durationDays }, o)
        : m.site_shop_kind_role({ role: roleName(guild, offer.roleId) }, o);
    case 'SUBSCRIPTION':
      return m.site_shop_kind_subscription({ role: roleName(guild, offer.roleId), days: offer.durationDays ?? 30 }, o);
    case 'ITEM': {
      const item = offer.itemId ? await prisma.rpgItem.findUnique({ where: { id: offer.itemId }, select: { name: true, emoji: true } }) : null;
      return m.site_shop_kind_item({ item: item ? `${item.emoji} ${item.name}`.trim() : '?', count: offer.quantity }, o);
    }
    case 'XP':
      return m.site_shop_kind_xp({ count: offer.quantity.toLocaleString('fr-FR') }, o);
    default:
      return m.site_shop_kind_custom({}, o);
  }
}

async function balanceOf(guildId: string, userId: string): Promise<number> {
  const profile = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { balance: true } });
  return profile?.balance ?? 0;
}

/** Accueil : liste des offres et menu pour en choisir une. */
export async function buildShopHome(guild: Guild, userId: string, locale: Locale, note?: string): Promise<ShopView> {
  const o = { locale };
  const settings = await getShopSettings(guild.id);
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle(m.shop_cmd_title({ guild: guild.name }, o));
  if (!settings.enabled) return { embeds: [embed.setDescription(m.site_shop_closed({}, o))], components: [] };
  const offers = (await listShopOffers(guild.id)).slice(0, 25);
  const balance = await formatShopPrice(guild.id, await balanceOf(guild.id, userId));

  if (offers.length === 0) {
    embed.setDescription(m.site_shop_empty({}, o));
    return { embeds: [embed], components: [] };
  }
  const lines = await Promise.all(
    offers.map(async (offer) => {
      const sold = offer.stock !== null && offer.stock <= 0 ? ` · ${m.site_shop_rule_sold_out({}, o)}` : '';
      return `**${offer.name}** · ${await formatShopPrice(guild.id, offer.price)}${sold}\n${await summary(guild, offer, o)}`;
    }),
  );
  embed.setDescription([note, lines.join('\n\n')].filter(Boolean).join('\n\n').slice(0, 4000)).setFooter({ text: m.shop_cmd_balance({ balance }, o) });

  const select = new StringSelectMenuBuilder()
    .setCustomId('shop:pick')
    .setPlaceholder(m.shop_cmd_pick({}, o))
    .addOptions(offers.map((offer) => ({ label: offer.name.slice(0, 100), value: offer.id, description: offer.description ? offer.description.slice(0, 100) : undefined })));
  const components: ShopView['components'] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
  const web = await siteUrl(guild.id, '/shop');
  if (web) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(web).setLabel(m.shop_cmd_site({}, o))));
  return { embeds: [embed], components };
}

/** Fiche d'une offre : règles et actions. */
async function buildOfferView(guild: Guild, userId: string, offerId: string, locale: Locale, note?: { text: string; ok: boolean }): Promise<ShopView> {
  const o = { locale };
  const offer = await prisma.shopOffer.findFirst({ where: { id: offerId, guildId: guild.id, enabled: true } });
  if (!offer) return buildShopHome(guild, userId, locale, shopErrorMessage('offer_missing', o));

  const rules: string[] = [];
  if (offer.stock !== null) rules.push(offer.stock > 0 ? m.site_shop_rule_stock({ count: offer.stock }, o) : m.site_shop_rule_sold_out({}, o));
  if (offer.perMemberLimit !== null) rules.push(m.site_shop_rule_limit({ count: offer.perMemberLimit }, o));
  if (offer.requiredRoleIds.length) rules.push(m.site_shop_rule_roles({ roles: offer.requiredRoleIds.map((id) => `<@&${id}>`).join(', ') }, o));
  if (offer.minLevel > 0) rules.push(m.site_shop_rule_level({ level: offer.minLevel }, o));
  if (offer.requiresApproval) rules.push(m.site_shop_rule_approval({}, o));

  const price = await formatShopPrice(guild.id, offer.price);
  const embed = new EmbedBuilder()
    .setColor(note ? (note.ok ? 0x16a34a : 0xef4444) : ACCENT)
    .setTitle(offer.name.slice(0, 256))
    .setDescription(
      [
        note ? `**${note.text}**` : '',
        await summary(guild, offer, o),
        offer.description,
        `**${price}**${offer.kind === 'SUBSCRIPTION' ? ` (${m.site_shop_per_period({ days: offer.durationDays ?? 30 }, o)})` : ''}`,
        rules.map((rule) => `• ${rule}`).join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 4000),
    )
    .setFooter({ text: m.shop_cmd_balance({ balance: await formatShopPrice(guild.id, await balanceOf(guild.id, userId)) }, o) });
  if (offer.imageUrl) embed.setThumbnail(offer.imageUrl);

  const soldOut = offer.stock !== null && offer.stock <= 0;
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(offer.kind === 'CUSTOM' ? `shop:order:${offer.id}` : `shop:buy:${offer.id}`)
      .setStyle(ButtonStyle.Success)
      .setLabel(m.shop_cmd_buy({ price }, o).slice(0, 80))
      .setDisabled(soldOut),
  );
  if (offer.kind !== 'CUSTOM') buttons.addComponents(new ButtonBuilder().setCustomId(`shop:order:${offer.id}`).setStyle(ButtonStyle.Secondary).setLabel(m.shop_cmd_code({}, o)).setDisabled(soldOut));
  if (offer.giftable) buttons.addComponents(new ButtonBuilder().setCustomId(`shop:gift:${offer.id}`).setStyle(ButtonStyle.Secondary).setLabel(m.shop_cmd_gift({}, o)).setDisabled(soldOut));
  buttons.addComponents(new ButtonBuilder().setCustomId('shop:back').setStyle(ButtonStyle.Secondary).setLabel(m.shop_cmd_back({}, o)));
  return { embeds: [embed], components: [buttons] };
}

async function buy(
  client: Client,
  guild: Guild,
  userId: string,
  offerId: string,
  locale: Locale,
  options: { recipientId?: string | null; code?: string | null; note?: string | null },
): Promise<ShopView> {
  const o = { locale };
  try {
    const order = await purchaseShopOffer(client, guild.id, userId, offerId, { ...options, source: 'discord' });
    const text =
      order.status === 'PENDING'
        ? m.site_shop_pending({}, o)
        : order.recipientId !== userId
          ? m.site_shop_gifted({ name: order.offerName }, o)
          : m.site_shop_bought({ name: order.offerName }, o);
    return buildOfferView(guild, userId, offerId, locale, { text, ok: true });
  } catch (err) {
    if (err instanceof ShopError) return buildOfferView(guild, userId, offerId, locale, { text: shopErrorMessage(err.code, o), ok: false });
    logger.error('Shop', `Achat Discord en échec (${guild.id}/${offerId}) :`, err);
    return buildOfferView(guild, userId, offerId, locale, { text: m.site_error_generic({}, o), ok: false });
  }
}

const CUID = /^[a-z0-9]{20,32}$/i;

export async function handleShopButton(client: Client, customId: string, interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const locale = await localeOf(interaction);
  const o = { locale };
  const [, action, offerId] = customId.split(':');
  if (action === 'back') {
    await interaction.deferUpdate();
    await interaction.editReply(await buildShopHome(interaction.guild, interaction.user.id, locale));
    return;
  }
  if (!offerId || !CUID.test(offerId)) return;

  if (action === 'buy') {
    await interaction.deferUpdate();
    await interaction.editReply(await buy(client, interaction.guild, interaction.user.id, offerId, locale, {}));
    return;
  }
  if (action === 'gift') {
    const offer = await prisma.shopOffer.findFirst({ where: { id: offerId, guildId: interaction.guild.id }, select: { name: true } });
    const select = new UserSelectMenuBuilder().setCustomId(`shop:giftto:${offerId}`).setPlaceholder(m.shop_cmd_gift_placeholder({}, o)).setMinValues(1).setMaxValues(1);
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(ACCENT).setDescription(m.shop_cmd_gift_pick({ name: offer?.name ?? '' }, o))],
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('shop:back').setStyle(ButtonStyle.Secondary).setLabel(m.shop_cmd_back({}, o))),
      ],
    });
    return;
  }
  if (action === 'order') {
    const offer = await prisma.shopOffer.findFirst({ where: { id: offerId, guildId: interaction.guild.id }, select: { name: true, kind: true } });
    if (!offer) return;
    const modal = new ModalBuilder().setCustomId(`shop:order:${offerId}`).setTitle(m.shop_cmd_modal_title({ name: offer.name }, o).slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('code').setLabel(m.shop_cmd_modal_code({}, o)).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(32),
      ),
    );
    if (offer.kind === 'CUSTOM') {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('note').setLabel(m.site_shop_note_label({}, o).slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
        ),
      );
    }
    await interaction.showModal(modal);
  }
}

export async function handleShopSelect(client: Client, customId: string, interaction: StringSelectMenuInteraction | UserSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  const locale = await localeOf(interaction);
  const [, action, offerId] = customId.split(':');
  await interaction.deferUpdate();
  if (action === 'pick' && interaction.isStringSelectMenu()) {
    const picked = interaction.values[0];
    if (!picked || !CUID.test(picked)) return;
    await interaction.editReply(await buildOfferView(interaction.guild, interaction.user.id, picked, locale));
    return;
  }
  if (action === 'giftto' && interaction.isUserSelectMenu() && offerId && CUID.test(offerId)) {
    const recipientId = interaction.values[0];
    await interaction.editReply(await buy(client, interaction.guild, interaction.user.id, offerId, locale, { recipientId }));
  }
}

export async function handleShopModal(client: Client, customId: string, interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  const locale = await localeOf(interaction);
  const [, action, offerId] = customId.split(':');
  if (action !== 'order' || !offerId || !CUID.test(offerId)) return;
  const field = (id: string) => {
    try {
      return interaction.fields.getTextInputValue(id).trim();
    } catch {
      return '';
    }
  };
  // Accusé de réception d'abord : l'achat (rôle, base) peut dépasser les 3 s de Discord.
  if (interaction.isFromMessage()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await buy(client, interaction.guild, interaction.user.id, offerId, locale, { code: field('code') || null, note: field('note') || null }));
}

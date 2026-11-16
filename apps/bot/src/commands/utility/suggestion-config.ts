import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type ColorResolvable,
} from 'discord.js';
import { SUGGESTION_STATUS_COLORS } from '@kotbo/shared';
import { getOrCreateFeatureConfigs, updateFeatureConfig } from '../../services/core/dashboardManagementService.js';
import { setDashboardModuleStatus } from '../../services/core/moduleActivationService.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { SlashCommandDefinition } from '../../commands.js';
import { getCommandMetadata, getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_suggestcfg');
const enableMeta = getCommandMetadata('b5_suggestcfg_enable');
const disableMeta = getCommandMetadata('b5_suggestcfg_disable');
const statusMeta = getCommandMetadata('b5_suggestcfg_status');
const sendEmbedMeta = getCommandMetadata('b5_suggestcfg_sendembed');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName(enableMeta.name)
      .setNameLocalizations(enableMeta.nameLocalizations)
      .setDescription(enableMeta.description)
      .setDescriptionLocalizations(enableMeta.descriptionLocalizations)
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription(m.b5_suggestcfg_enable_opt_channel({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b5_suggestcfg_enable_opt_channel({}, { locale: 'fr' }) })
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName(disableMeta.name)
      .setNameLocalizations(disableMeta.nameLocalizations)
      .setDescription(disableMeta.description)
      .setDescriptionLocalizations(disableMeta.descriptionLocalizations)
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName(statusMeta.name)
      .setNameLocalizations(statusMeta.nameLocalizations)
      .setDescription(statusMeta.description)
      .setDescriptionLocalizations(statusMeta.descriptionLocalizations)
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName(sendEmbedMeta.name)
      .setNameLocalizations(sendEmbedMeta.nameLocalizations)
      .setDescription(sendEmbedMeta.description)
      .setDescriptionLocalizations(sendEmbedMeta.descriptionLocalizations)
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription(m.b5_suggestcfg_sendembed_opt_channel({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b5_suggestcfg_sendembed_opt_channel({}, { locale: 'fr' }) })
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText)
      )
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);
  const o = { locale };
  if (!guildId) {
    await interaction.reply({ content: m.b5_guild_only({}, o), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const fail = (text: string) => interaction.editReply({ embeds: [errorEmbed(m.b5_suggestcfg_error_title({}, o), text)] });

  if (subcommand === 'enable') {
    const channel = interaction.options.getChannel('channel', true);
    try {
      await getOrCreateFeatureConfigs(guildId);
      // `setDashboardModuleStatus` et non la ligne de configuration : lui seul
      // propage la cascade, refuse un module hors offre et purge le cache que
      // la garde de lecture consulte.
      await setDashboardModuleStatus(guildId, 'suggestions', true);
      await updateFeatureConfig(guildId, 'suggestions', { channelId: channel.id });
      await interaction.editReply({
        embeds: [successEmbed(m.b5_suggestcfg_enabled_title({}, o), m.b5_suggestcfg_enabled_desc({ channel: `<#${channel.id}>` }, o))],
      });
    } catch {
      await fail(m.b5_suggestcfg_enable_error({}, o));
    }
  } else if (subcommand === 'disable') {
    try {
      await getOrCreateFeatureConfigs(guildId);
      await setDashboardModuleStatus(guildId, 'suggestions', false);
      await updateFeatureConfig(guildId, 'suggestions', { channelId: null });
      await interaction.editReply({
        embeds: [successEmbed(m.b5_suggestcfg_disabled_title({}, o), m.b5_suggestcfg_disabled_desc({}, o))],
      });
    } catch {
      await fail(m.b5_suggestcfg_disable_error({}, o));
    }
  } else if (subcommand === 'status') {
    try {
      const config = (await getOrCreateFeatureConfigs(guildId)).find((c) => c.featureKey === 'suggestions');
      if (!config) {
        await fail(m.b5_suggestcfg_status_missing({}, o));
        return;
      }
      const statusText = config.enabled
        ? m.b5_suggestcfg_status_on({ channel: config.channelId ? `<#${config.channelId}>` : m.b5_suggestcfg_status_no_channel({}, o) }, o)
        : m.b5_suggestcfg_status_off({}, o);
      await interaction.editReply({ embeds: [successEmbed(m.b5_suggestcfg_status_title({}, o), statusText)] });
    } catch {
      await fail(m.b5_suggestcfg_status_error({}, o));
    }
  } else if (subcommand === 'send-embed') {
    const channel = interaction.options.getChannel('channel', true);
    try {
      const config = (await getOrCreateFeatureConfigs(guildId)).find((c) => c.featureKey === 'suggestions');
      if (!config || !config.enabled) {
        await interaction.editReply({
          embeds: [errorEmbed(m.b5_suggestcfg_embed_off_title({}, o), m.b5_suggestcfg_embed_off_desc({}, o))],
        });
        return;
      }

      const targetChannel = interaction.guild?.channels.cache.get(channel.id);
      if (!targetChannel || !targetChannel.isTextBased()) {
        await fail(m.b5_suggestcfg_embed_invalid_channel({}, o));
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(m.b5_suggestcfg_embed_title({}, o))
        .setDescription(m.b5_suggestcfg_embed_desc({}, o))
        .setColor(SUGGESTION_STATUS_COLORS.PENDING as ColorResolvable)
        .addFields(
          { name: m.b5_suggestcfg_embed_how_name({}, o), value: m.b5_suggestcfg_embed_how_value({}, o), inline: false },
          { name: m.b5_suggestcfg_embed_rules_name({}, o), value: m.b5_suggestcfg_embed_rules_value({}, o), inline: false },
        );

      const button = new ButtonBuilder()
        .setCustomId('suggest_form_open')
        .setLabel(m.b5_suggestcfg_embed_button({}, o))
        .setStyle(ButtonStyle.Primary);

      await targetChannel.send({
        embeds: [embed],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
        allowedMentions: { parse: [] },
      });
      await interaction.editReply({
        embeds: [successEmbed(m.b5_suggestcfg_embed_sent_title({}, o), m.b5_suggestcfg_embed_sent_desc({ channel: `<#${channel.id}>` }, o))],
      });
    } catch {
      await fail(m.b5_suggestcfg_embed_error({}, o));
    }
  }
}

export const suggestionConfigCommand = { data, execute } satisfies SlashCommandDefinition;

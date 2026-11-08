import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getRaidProtectionConfig } from '../../services/moderation/raidProtectionService.js';
import {
  SHIELD_LEVELS,
  isShieldLevel,
  postShieldPanel,
  setShieldLevel,
  type ShieldLevel,
} from '../../services/moderation/shieldService.js';

const LEVEL_CHOICES = ([5, 4, 3, 2, 1] as ShieldLevel[]).map((level) => ({
  name: `${SHIELD_LEVELS[level].emoji} ${level} - ${SHIELD_LEVELS[level].name}`,
  value: level,
}));

const data = new SlashCommandBuilder()
  .setName('shield')
  .setDescription('Danger level of the server, from 5 (all good) to 1 (disaster)')
  .setDescriptionLocalizations({ fr: 'Niveau de danger du serveur, de 5 (tout va bien) à 1 (catastrophe)' })
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setNameLocalizations({ fr: 'niveau' })
      .setDescription('Change the danger level: every level hardens the server')
      .setDescriptionLocalizations({ fr: 'Change le niveau : chaque niveau durcit le serveur' })
      .addIntegerOption((opt) =>
        opt
          .setName('level')
          .setNameLocalizations({ fr: 'niveau' })
          .setDescription('5 = all good, 1 = disaster')
          .setDescriptionLocalizations({ fr: '5 = tout va bien, 1 = catastrophe' })
          .setRequired(true)
          .addChoices(...LEVEL_CHOICES)))
  .addSubcommand((sub) =>
    sub
      .setName('panel')
      .setNameLocalizations({ fr: 'panneau' })
      .setDescription('Post the Shield panel in a staff-only channel')
      .setDescriptionLocalizations({ fr: 'Publie le panneau Shield dans un salon réservé à l\'équipe' })
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setNameLocalizations({ fr: 'salon' })
          .setDescription('Staff-only channel (a voice channel posts in its text chat)')
          .setDescriptionLocalizations({ fr: 'Salon réservé à l\'équipe (un vocal publie dans son chat)' })
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement)
          .setRequired(true)))
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setNameLocalizations({ fr: 'statut' })
      .setDescription('Current level and what it applies')
      .setDescriptionLocalizations({ fr: 'Niveau actuel et ce qu\'il applique' }));

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const level = interaction.options.getInteger('level', true);
    if (!isShieldLevel(level)) return;
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const result = await setShieldLevel(guild, level, interaction.user.id);
    const meta = SHIELD_LEVELS[level];
    const embed = successEmbed(`${meta.emoji} Shield ${level} : ${meta.name}`, meta.summary);
    if (result.warnings.length) embed.addFields({ name: 'Appliqué en partie', value: result.warnings.map((w) => `• ${w}`).join('\n').slice(0, 1024) });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === 'panel') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const channel = interaction.options.getChannel('channel', true);
    const result = await postShieldPanel(guild, channel.id);
    await interaction.editReply({
      embeds: [result.ok ? successEmbed('Panneau Shield publié', `Dans <#${channel.id}>. Toute personne qui voit ce salon peut changer le niveau.`) : errorEmbed('Panneau non publié', result.reason)],
    });
    return;
  }

  const config = await getRaidProtectionConfig(guild.id);
  const level = (isShieldLevel(config?.shieldLevel) ? config!.shieldLevel : 5) as ShieldLevel;
  const meta = SHIELD_LEVELS[level];
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} Shield ${level} : ${meta.name}`)
    .setDescription(meta.summary)
    .addFields(
      { name: 'Depuis', value: config?.shieldChangedAt ? `<t:${Math.floor(new Date(config.shieldChangedAt).getTime() / 1000)}:R>${config.shieldChangedBy ? ` par <@${config.shieldChangedBy}>` : ''}` : 'toujours', inline: true },
      { name: 'Panneau', value: config?.shieldPanelChannelId ? `<#${config.shieldPanelChannelId}>` : 'aucun (`/shield panneau`)', inline: true },
    );
  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

export const shieldCommand: SlashCommandDefinition = { data, execute };

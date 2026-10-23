import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const meta = getCommandMetadata('b4_channel');
const clearMeta = getCommandMetadata('b4_channel_clear');
const duplicateMeta = getCommandMetadata('b4_channel_duplicate');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((sub) =>
    sub
      .setName(clearMeta.name)
      .setNameLocalizations(clearMeta.nameLocalizations)
      .setDescription(clearMeta.description)
      .setDescriptionLocalizations(clearMeta.descriptionLocalizations),
  )
  .addSubcommand((sub) =>
    sub
      .setName(duplicateMeta.name)
      .setNameLocalizations(duplicateMeta.nameLocalizations)
      .setDescription(duplicateMeta.description)
      .setDescriptionLocalizations(duplicateMeta.descriptionLocalizations)
      .addChannelOption((option) =>
        option
          .setName('salon')
          .setDescription(m.b4_channel_duplicate_opt_salon({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b4_channel_duplicate_opt_salon({}, { locale: 'fr' }) })
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('nom')
          .setDescription(m.b4_channel_duplicate_opt_nom({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b4_channel_duplicate_opt_nom({}, { locale: 'fr' }) })
          .setRequired(false),
      ),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channel = interaction.channel;
  const guild = interaction.guild;

  if (!guild || !channel) {
    await interaction.reply({
      embeds: [errorEmbed('Action impossible', 'Cette commande doit être exécutée dans un serveur.')],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (subcommand === 'clear') {
    const currentGuildChannel = guild.channels.cache.get(channel.id);
    if (!currentGuildChannel || !('clone' in currentGuildChannel) || !currentGuildChannel.deletable) {
      await interaction.reply({
        embeds: [errorEmbed('Action impossible', 'Ce type de salon ne peut pas être nettoyé/recréé.')],
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    try {
      // 1. Envoyer une réponse d'attente éphémère
      await interaction.reply({
        content: '⚙️ Nettoyage du salon en cours...',
        flags: [MessageFlags.Ephemeral],
      }).catch(() => null);

      // 2. Cloner le salon avec la même position et configurations
      const position = currentGuildChannel.position;
      const cloned = await currentGuildChannel.clone({
        position,
        reason: `Salon nettoyé par ${interaction.user.tag} (commande /channel clear)`,
      });

      // 3. Supprimer l'ancien salon
      await currentGuildChannel.delete(`Salon nettoyé par ${interaction.user.tag} (commande /channel clear)`);

      // 4. Envoyer un message dans le nouveau salon pour informer
      if (cloned.isTextBased() && cloned.isSendable()) await cloned.send({
        embeds: [
          successEmbed(
            'Salon nettoyé',
            `Ce salon a été nettoyé avec succès. (Toutes les configurations d'origine ont été conservées)`
          ).setFooter({ text: `Nettoyé par ${interaction.user.tag}` }),
        ],
      });
    } catch (error) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'Erreur',
            `Une erreur est survenue lors du nettoyage du salon : ${publicErrorMessage(error)}`
          ),
        ],
        flags: [MessageFlags.Ephemeral],
      }).catch(() => null);
    }
    return;
  }

  if (subcommand === 'duplicate') {
    const targetChannelOption = interaction.options.getChannel('salon');
    const targetGuildChannel = targetChannelOption
      ? (guild.channels.cache.get(targetChannelOption.id) || await guild.channels.fetch(targetChannelOption.id).catch(() => null))
      : guild.channels.cache.get(channel.id);

    const newName = interaction.options.getString('nom');

    if (!targetGuildChannel || !('clone' in targetGuildChannel)) {
      await interaction.reply({
        embeds: [errorEmbed('Action impossible', 'Le salon ciblé ne peut pas être dupliqué.')],
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const finalName = newName || `${targetGuildChannel.name}-copy`;
      const cloned = await targetGuildChannel.clone({
        name: finalName,
        reason: `Salon dupliqué par ${interaction.user.tag} (commande /channel duplicate)`,
      });

      await interaction.editReply({
        embeds: [
          successEmbed(
            'Salon dupliqué',
            `Le salon ${targetGuildChannel} a été dupliqué avec succès en ${cloned}.`
          ),
        ],
      });
    } catch (error) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            'Erreur',
            `Une erreur est survenue lors de la duplication : ${publicErrorMessage(error)}`
          ),
        ],
      });
    }
  }
}

export const channelCommand = { data, execute } satisfies SlashCommandDefinition;

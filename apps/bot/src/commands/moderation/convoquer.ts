import type { SlashCommandDefinition } from '../../commands.js';
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getCommandMetadata } from '../../utils/i18n.js';
import { publicErrorMessage } from '../../utils/publicError.js';
import * as m from '../../lib/paraglide/messages.js';
import { EXPIRY_ACTIONS, type ExpiryAction } from '../../services/moderation/convocationRules.js';

const meta = getCommandMetadata('b1_convoc');

const localized = (key: string) => ({
  en: (m as any)[key]({}, { locale: 'en' }) as string,
  fr: (m as any)[key]({}, { locale: 'fr' }) as string,
});

const expiryChoice = (action: ExpiryAction) => {
  const label = localized(`b1_convoc_expiry_${action.toLowerCase()}`);
  return { name: label.en, name_localizations: { fr: label.fr }, value: action };
};

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('membre').setDescription(localized('b1_convoc_opt_membre').en)
    .setDescriptionLocalizations({ fr: localized('b1_convoc_opt_membre').fr }).setRequired(true))
  .addStringOption((o) => o.setName('raison').setDescription(localized('b1_convoc_opt_raison').en)
    .setDescriptionLocalizations({ fr: localized('b1_convoc_opt_raison').fr }).setRequired(true).setMaxLength(1000))
  .addIntegerOption((o) => o.setName('delai').setDescription(localized('b1_convoc_opt_delai').en)
    .setDescriptionLocalizations({ fr: localized('b1_convoc_opt_delai').fr }).setMinValue(1).setMaxValue(336))
  .addStringOption((o) => o.setName('expiration').setDescription(localized('b1_convoc_opt_expiration').en)
    .setDescriptionLocalizations({ fr: localized('b1_convoc_opt_expiration').fr })
    .addChoices(...EXPIRY_ACTIONS.map(expiryChoice)))
  .addChannelOption((o) => o.setName('salon_attente').setDescription(localized('b1_convoc_opt_salon_attente').en)
    .setDescriptionLocalizations({ fr: localized('b1_convoc_opt_salon_attente').fr })
    .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice));

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;

  const target = interaction.options.getUser('membre', true);
  if (target.bot || target.id === interaction.user.id) {
    await interaction.reply({ content: '❌ Choisis un membre du serveur, autre que toi.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  // La convocation ouvre un fil sous son message : il faut un salon qui en accepte.
  const channel = interaction.channel;
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    await interaction.reply({ content: '❌ Lance la commande dans un salon textuel : la convocation y ouvre un fil.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  try {
    // Charge a l'execution : le service depend des sanctions, qui remontent jusqu'au registre des commandes.
    const { createConvocation } = await import('../../services/moderation/convocationService.js');
    const conv = await createConvocation({
      guildId: interaction.guildId,
      channel,
      target,
      staff: interaction.user,
      reason: interaction.options.getString('raison', true).trim(),
      delayHours: interaction.options.getInteger('delai') ?? 48,
      expiryAction: (interaction.options.getString('expiration') as ExpiryAction | null) ?? 'ALERT',
      waitingChannelId: interaction.options.getChannel('salon_attente')?.id ?? null,
    });
    await interaction.editReply({ content: `✅ Convocation envoyée à <@${target.id}>. Fil : <#${conv.threadId}>` });
  } catch (err) {
    await interaction.editReply({ content: `❌ Convocation impossible : ${publicErrorMessage(err)}` });
  }
}

export const convoquerCommand = { data, execute } satisfies SlashCommandDefinition;

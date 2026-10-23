/**
 * /fil renommer : renomme un fil ouvert par l'auto-thread.
 *
 * Le bot est le créateur des fils automatiques : Discord ne laisse donc que
 * les modérateurs (Gérer les fils) les renommer. Cette commande ouvre le
 * renommage à l'auteur du message d'origine, ou à tout le monde, selon la
 * configuration qui a ouvert le fil.
 */
import type { SlashCommandDefinition } from '../../commands.js';
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getCommandMetadata, getEffectiveLocale } from '../../utils/i18n.js';
import { canRenameAutoThread } from '../../services/features/autoThreadService.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b4_thread');
const renameMeta = getCommandMetadata('b4_thread_rename');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName(renameMeta.name)
      .setNameLocalizations(renameMeta.nameLocalizations)
      .setDescription(renameMeta.description)
      .setDescriptionLocalizations(renameMeta.descriptionLocalizations)
      .addStringOption((option) =>
        option
          .setName('name')
          .setNameLocalizations({ fr: 'nom' })
          .setDescription(m.b4_thread_rename_opt_name({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b4_thread_rename_opt_name({}, { locale: 'fr' }) })
          .setMinLength(1)
          .setMaxLength(100)
          .setRequired(true),
      ),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  const title = m.thread_rename_title({}, { locale });
  const fail = (text: string) => interaction.reply({ embeds: [errorEmbed(title, text)], flags: [MessageFlags.Ephemeral] });

  const thread = interaction.channel;
  if (!interaction.inCachedGuild() || !thread?.isThread()) {
    await fail(m.thread_rename_not_thread({}, { locale }));
    return;
  }

  const name = interaction.options.getString('name', true).trim();
  if (!name || name.length > 100) {
    await fail(m.thread_rename_invalid({}, { locale }));
    return;
  }

  const isModerator = interaction.member.permissionsIn(thread).has(PermissionFlagsBits.ManageThreads);
  const refusal = await canRenameAutoThread(thread.id, interaction.user.id, isModerator);
  if (refusal === 'not_auto_thread') {
    await fail(m.thread_rename_not_auto({}, { locale }));
    return;
  }
  if (refusal === 'not_allowed') {
    await fail(m.thread_rename_not_allowed({}, { locale }));
    return;
  }

  const renamed = await thread.setName(name, `Renommé par ${interaction.user.tag} (/fil renommer)`).catch(() => null);
  if (!renamed) {
    await fail(m.thread_rename_failed({}, { locale }));
    return;
  }

  await interaction.reply({
    embeds: [successEmbed(title, m.thread_rename_done({ name }, { locale }))],
    flags: [MessageFlags.Ephemeral],
  });
}

export const threadCommand = { data, execute } satisfies SlashCommandDefinition;

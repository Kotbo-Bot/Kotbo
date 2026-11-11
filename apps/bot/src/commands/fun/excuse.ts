import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import prisma from '../../utils/db.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata, localized } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b2_excuse');

const EXCUSE_CATEGORIES = [
  'classiques', 'git_cicd', 'infra_cloud', 'frontend', 'backend',
  'dependencies', 'management', 'ai', 'hardware', 'bad_faith',
] as const;

const categoryChoice = (key: (typeof EXCUSE_CATEGORIES)[number]) => ({
  name: (m as any)[`b2_excuse_choice_${key}`]({}, { locale: 'en' }) as string,
  name_localizations: { fr: (m as any)[`b2_excuse_choice_${key}`]({}, { locale: 'fr' }) as string },
  value: key,
});

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption((option) =>
    localized(option, 'b2_excuse_opt_category')
      .setRequired(false)
      .addChoices(...EXCUSE_CATEGORIES.map(categoryChoice)),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const category = interaction.options.getString('category');
  const locale = await getEffectiveLocale(interaction);

  const whereClause: { language: string; category?: string } = { language: 'fr' };
  if (category) {
    whereClause.category = category;
  }

  const excuses = await prisma.developerExcuse.findMany({
    where: whereClause,
    select: { text: true },
  });

  if (excuses.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_excuse_none_title({}, { locale }), category ? m.b2_excuse_none_category({ category }, { locale }) : m.b2_excuse_none_desc({}, { locale }))],
    });
    return;
  }

  const randomExcuse = excuses[Math.floor(Math.random() * excuses.length)]?.text ?? m.b2_excuse_not_found({}, { locale });

  await interaction.reply({
    embeds: [
      successEmbed(m.b2_excuse_found_title({}, { locale }), `> ${randomExcuse}`),
    ],
  });
}

export const excuseCommand = { data, execute } satisfies SlashCommandDefinition;

import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { sendMainConfigPanel } from '../../panels/generalConfigPanel.js';
import prisma from '../../utils/db.js';
import { upsertRetryingRace } from '../../utils/upsertRetry.js';
import { getCommandMetadata } from '../../utils/i18n.js';

const meta = getCommandMetadata('c1_config');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;

  await upsertRetryingRace(() => prisma.guild.upsert({
    where: { id: guildId },
    update: {},
    create: { id: guildId },
  }));

  await sendMainConfigPanel(interaction, guildId);
}

export const configCommand = { data, execute } satisfies SlashCommandDefinition;

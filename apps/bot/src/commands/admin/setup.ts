import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';

import { runSetupCommand } from '../../panels/setupPanel.js';
import { getCommandMetadata } from '../../utils/i18n.js';

const meta = getCommandMetadata('c1_setup');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction: ChatInputCommandInteraction) {
  await runSetupCommand(interaction);
}

export const setupCommand = { data, execute } satisfies SlashCommandDefinition;

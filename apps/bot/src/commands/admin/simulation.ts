import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getCommandMetadata, getEffectiveLocale, localized, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import {
  SimulationError,
  abandonSession,
  listScenarios,
  startSession,
} from '../../services/staff/simulationService.js';
import { logger } from '../../utils/logger.js';

const meta = getCommandMetadata('sim');
const startMeta = getCommandMetadata('sim_start');
const stopMeta = getCommandMetadata('sim_stop');
const listMeta = getCommandMetadata('sim_list');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((sub) =>
    sub
      .setName(startMeta.name)
      .setNameLocalizations(startMeta.nameLocalizations)
      .setDescription(startMeta.description)
      .setDescriptionLocalizations(startMeta.descriptionLocalizations)
      // L'autocomplétion évite de faire copier un identifiant depuis le dashboard.
      .addStringOption((option) =>
        localized(option, 'sim_opt_scenario')
          .setRequired(true)
          .setAutocomplete(true)))
  .addSubcommand((sub) =>
    sub
      .setName(stopMeta.name)
      .setNameLocalizations(stopMeta.nameLocalizations)
      .setDescription(stopMeta.description)
      .setDescriptionLocalizations(stopMeta.descriptionLocalizations))
  .addSubcommand((sub) =>
    sub
      .setName(listMeta.name)
      .setNameLocalizations(listMeta.nameLocalizations)
      .setDescription(listMeta.description)
      .setDescriptionLocalizations(listMeta.descriptionLocalizations));

function difficultyLabel(difficulty: string, locale: BotLocale): string {
  if (difficulty === 'EASY') return m.sim_difficulty_easy({}, { locale });
  if (difficulty === 'MEDIUM') return m.sim_difficulty_medium({}, { locale });
  if (difficulty === 'HARD') return m.sim_difficulty_hard({}, { locale });
  return difficulty;
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guild, guildId } = interaction;
  if (!guild || !guildId) return;

  const subcommand = interaction.options.getSubcommand();
  const locale = await getEffectiveLocale(interaction);

  if (subcommand === listMeta.name) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const scenarios = await listScenarios(guildId);
    const enabled = scenarios.filter((s) => s.enabled);

    if (enabled.length === 0) {
      await interaction.editReply(m.sim_list_empty({}, { locale }));
      return;
    }

    const lines = enabled.map((scenario) => {
      const steps = Array.isArray(scenario.steps) ? scenario.steps.length : 0;
      return m.sim_list_line({ title: scenario.title, difficulty: difficultyLabel(scenario.difficulty, locale), steps }, { locale });
    });
    await interaction.editReply(lines.join('\n').slice(0, 1900));
    return;
  }

  if (subcommand === stopMeta.name) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const stopped = await abandonSession(interaction.client, guildId, interaction.user.id);
    await interaction.editReply(
      stopped
        ? m.sim_stopped({}, { locale })
        : m.sim_no_session({}, { locale }),
    );
    return;
  }

  // ── start ────────────────────────────────────────────────────────────────
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const scenarioId = interaction.options.getString('scenario', true);

  try {
    await startSession(
      interaction.client,
      guild,
      scenarioId,
      { id: interaction.user.id, name: interaction.user.tag },
      interaction.channelId,
    );
    await interaction.editReply(
      m.sim_started({}, { locale }),
    );
  } catch (error) {
    if (error instanceof SimulationError) {
      await interaction.editReply(`❌ ${error.message}`);
      return;
    }
    logger.error('Simulation', 'Échec du démarrage d\'une session:', error);
    await interaction.editReply(m.sim_start_failed({}, { locale }));
  }
}

async function autocomplete(interaction: import('discord.js').AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) return;

  const focused = interaction.options.getFocused().toLowerCase();
  const locale = await getEffectiveLocale(interaction);
  const scenarios = await listScenarios(interaction.guildId);

  const choices = scenarios
    .filter((s) => s.enabled && s.title.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((s) => ({ name: `${s.title} (${difficultyLabel(s.difficulty, locale)})`.slice(0, 100), value: s.id }));

  await interaction.respond(choices).catch(() => null);
}

export const simulationCommand: SlashCommandDefinition = { data, execute, autocomplete };

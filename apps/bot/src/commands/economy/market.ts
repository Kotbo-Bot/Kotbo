import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { buildMarketView } from '../../services/economy/marketplacePanel.js';
import { renderPanelView } from '../../services/features/rpgPanelService.js';
import { getEffectiveLocale, localized } from '../../utils/i18n.js';

/**
 * Hôtel des ventes : un seul panneau, comme `/rpg`. Acheter, enchérir, retirer et mettre en
 * vente passent par ses boutons ; les anciennes sous-commandes obligeaient à retrouver un
 * objet par autocomplétion puis à en retaper le prix.
 */
const data = localized(new SlashCommandBuilder(), 'market_cmd');

async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const view = await buildMarketView(interaction.guildId!, interaction.user.id, interaction.guild, locale);
  await interaction.reply(renderPanelView(view));
}

export const marketCommand = { data, execute } satisfies SlashCommandDefinition;

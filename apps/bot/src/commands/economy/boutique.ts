import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { buildShopHome } from '../../services/shop/shopPanel.js';
import { getEffectiveLocale } from '../../utils/i18n.js';

/**
 * Boutique du serveur : rôles, objets, XP, abonnements et prestations, payés
 * en monnaie du bot. La même que sur le site communautaire (page Boutique).
 */
const data = new SlashCommandBuilder()
  .setName('boutique')
  .setDescription('Boutique du serveur - rôles, objets, abonnements')
  .setDescriptionLocalizations({ 'en-US': 'Server shop - roles, items, subscriptions', 'en-GB': 'Server shop - roles, items, subscriptions' });

async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const locale = (await getEffectiveLocale(interaction)) === 'en' ? 'en' : 'fr';
  await interaction.editReply(await buildShopHome(interaction.guild, interaction.user.id, locale));
}

export const boutiqueCommand = { data, execute } satisfies SlashCommandDefinition;

/**
 * `/bump-ping` - choix individuel d'être mentionné, ou non, par le rappel de bump.
 *
 * Le rappel part toujours ; la commande ne décide que de la notification du
 * dernier bumpeur (voir `processDueBumpReminders`). Le choix est stocké sur le
 * `MemberProfile`, donc propre au serveur. Réponse éphémère : c'est un réglage
 * personnel, il n'a rien à faire dans le salon.
 */

import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getEffectiveLocale, localized } from '../../utils/i18n.js';
import { setBumpReminderPingOptOut } from '../../services/integrations/bumpDetectionService.js';
import { memberProfileIdentity } from '../../services/moderation/memberIdentityService.js';
import * as m from '../../lib/paraglide/messages.js';

const disableSub = localized(new SlashCommandSubcommandBuilder(), 'bumpping_disable');
const enableSub = localized(new SlashCommandSubcommandBuilder(), 'bumpping_enable');

const data = localized(new SlashCommandBuilder(), 'bumpping')
  .addSubcommand(disableSub)
  .addSubcommand(enableSub);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({ content: m.bumpping_guild_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  // Discord renvoie toujours le nom de base (anglais), quelle que soit la langue du client.
  const optedOut = interaction.options.getSubcommand() === disableSub.name;
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

  await setBumpReminderPingOptOut(
    guildId,
    interaction.user.id,
    optedOut,
    member ? memberProfileIdentity(member) : undefined,
  );

  await interaction.editReply({
    content: optedOut ? m.bumpping_disabled({}, { locale }) : m.bumpping_enabled({}, { locale }),
  });
}

export const bumpPingCommand = { data, execute } satisfies SlashCommandDefinition;

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { errorEmbed, infoEmbed, successEmbed } from '../../utils/embeds.js';
import { getCachedGuild } from '../../utils/cache.js';
import { resolveLogChannel } from '../../utils/logChannel.js';
import { grantBotBypass, listBotBypasses } from '../../services/moderation/autoModService.js';

const data = new SlashCommandBuilder()
  .setName('bypass')
  .setDescription('One-time exemptions from the security filters')
  .setDescriptionLocalizations({ fr: 'Exemptions ponctuelles des protections' })
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('bot')
      .setDescription('Let a bot join once within 10 minutes without being kicked (owner only)')
      .setDescriptionLocalizations({ fr: 'Laisse un bot rejoindre une fois dans les 10 minutes sans être expulsé (propriétaire)' })
      .addUserOption((opt) =>
        opt
          .setName('bot')
          .setDescription('Bot to allow (empty: list the bots currently allowed)')
          .setDescriptionLocalizations({ fr: 'Bot à autoriser (vide : liste des bots autorisés)' })));

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const guild = interaction.guild;
  // Comme l'ajout de bots en mode sécurisé, l'exemption est réservée au propriétaire.
  if (interaction.user.id !== guild.ownerId) {
    await interaction.reply({ embeds: [errorEmbed('Réservé au propriétaire', 'Seul le propriétaire du serveur peut autoriser un bot.')], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const bot = interaction.options.getUser('bot');
  if (!bot) {
    const grants = Object.entries(await listBotBypasses(guild.id));
    await interaction.reply({
      embeds: [
        infoEmbed(
          'Bots autorisés',
          grants.length === 0
            ? 'Aucun bot n\'est autorisé en ce moment.'
            : grants.map(([id, g]) => `<@${id}> · expire <t:${Math.floor(g.expiresAt / 1000)}:R>`).join('\n'),
        ),
      ],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }
  if (!bot.bot) {
    await interaction.reply({ embeds: [errorEmbed('Pas un bot', `${bot} est un compte utilisateur.`)], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const expiresAt = await grantBotBypass(guild.id, bot.id, interaction.user.id);
  const until = `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`;
  await interaction.reply({
    embeds: [successEmbed('Bot autorisé', `${bot} pourra rejoindre le serveur **une fois**, jusqu'à ${until}, sans être expulsé.`)],
    flags: [MessageFlags.Ephemeral],
  });

  const guildConfig = await getCachedGuild(guild.id);
  const log = await resolveLogChannel(guild, guildConfig?.logChannelId, 'Bypass');
  await log?.send({ content: `🤖 <@${interaction.user.id}> a autorisé le bot ${bot.tag} (\`${bot.id}\`) à rejoindre une fois, jusqu'à ${until}.`, allowedMentions: { parse: [] } }).catch(() => null);
}

export const bypassCommand: SlashCommandDefinition = { data, execute };

import type { SlashCommandDefinition } from '../../commands.js';
import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getCachedGuild } from '../../utils/cache.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import {
  CONFESSION_MAX_LENGTH,
  revealConfession,
  setConfessionChannels,
  submitConfession,
} from '../../services/features/confessionService.js';

const data = new SlashCommandBuilder()
  .setName('confession')
  .setNameLocalizations({ fr: 'confession' })
  .setDescription('Anonymous confessions')
  .setDescriptionLocalizations({ fr: 'Confessions anonymes' })
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('send')
      .setNameLocalizations({ fr: 'envoyer' })
      .setDescription('Post an anonymous confession')
      .setDescriptionLocalizations({ fr: 'Publier une confession anonyme' })
      .addStringOption((o) =>
        o
          .setName('message')
          .setDescription('Your confession')
          .setDescriptionLocalizations({ fr: 'Ta confession' })
          .setRequired(true)
          .setMaxLength(CONFESSION_MAX_LENGTH),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setNameLocalizations({ fr: 'salon' })
      .setDescription('Choose the confession channel (admin)')
      .setDescriptionLocalizations({ fr: 'Choisir le salon des confessions (admin)' })
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setNameLocalizations({ fr: 'salon' })
          .setDescription('Public channel')
          .setDescriptionLocalizations({ fr: 'Salon public' })
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addChannelOption((o) =>
        o
          .setName('log')
          .setDescription('Private staff channel for the log')
          .setDescriptionLocalizations({ fr: 'Salon privé du staff pour le journal' })
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reveal')
      .setNameLocalizations({ fr: 'reveler' })
      .setDescription('Reveal the author of a confession (admin)')
      .setDescriptionLocalizations({ fr: "Révéler l'auteur d'une confession (admin)" })
      .addIntegerOption((o) =>
        o
          .setName('number')
          .setNameLocalizations({ fr: 'numero' })
          .setDescription('Confession number')
          .setDescriptionLocalizations({ fr: 'Numéro de la confession' })
          .setMinValue(1)
          .setRequired(true),
      ),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const fr = (await getEffectiveLocale(interaction)) === 'fr';
  const t = (frText: string, enText: string) => (fr ? frText : enText);
  const reply = (embed: ReturnType<typeof errorEmbed>) =>
    interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

  const guildConfig = await getCachedGuild(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  const isAdmin = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);

  if (sub === 'setup') {
    if (!isAdmin) {
      await reply(errorEmbed(t('Accès refusé', 'Access denied'), t('Réservé aux administrateurs.', 'Administrators only.')));
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    const log = interaction.options.getChannel('log');
    await setConfessionChannels(interaction.guildId, channel.id, log?.id ?? null);
    await reply(successEmbed(t('Confessions configurées', 'Confessions configured'), `<#${channel.id}>${log ? ` · journal <#${log.id}>` : ''}`));
    return;
  }

  if (sub === 'reveal') {
    if (!isAdmin) {
      await reply(errorEmbed(t('Accès refusé', 'Access denied'), t('Réservé aux administrateurs.', 'Administrators only.')));
      return;
    }
    const found = await revealConfession(
      interaction.guild,
      guildConfig?.funConfessionLogChannelId ?? null,
      interaction.options.getInteger('number', true),
      interaction.user.id,
    );
    if (!found) {
      await reply(errorEmbed(t('Introuvable', 'Not found'), t('Aucune confession avec ce numéro.', 'No confession with that number.')));
      return;
    }
    await reply(successEmbed(t('Auteur révélé', 'Author revealed'), `<@${found.authorId}>\n> ${found.content.slice(0, 500)}`));
    return;
  }

  // sub === 'send'
  if (!guildConfig?.funEnabled || !guildConfig.funConfessionChannelId) {
    await reply(errorEmbed(t('Confessions fermées', 'Confessions closed'), t("Le staff n'a pas activé les confessions.", 'Staff has not enabled confessions.')));
    return;
  }

  const result = await submitConfession(
    interaction.guild,
    guildConfig.funConfessionChannelId,
    guildConfig.funConfessionLogChannelId,
    interaction.user.id,
    interaction.options.getString('message', true),
  );

  if (result.ok) {
    await reply(successEmbed(t('Confession envoyée', 'Confession sent'), t(`Publiée anonymement (#${result.number}).`, `Posted anonymously (#${result.number}).`)));
    return;
  }

  const reasons = {
    cooldown: t(`Attends ${result.retryInSeconds ?? 60} s avant d'en envoyer une autre.`, `Wait ${result.retryInSeconds ?? 60}s before sending another.`),
    empty: t('Le message est vide.', 'The message is empty.'),
    too_long: t(`Maximum ${CONFESSION_MAX_LENGTH} caractères.`, `Maximum ${CONFESSION_MAX_LENGTH} characters.`),
    not_configured: t('Le salon des confessions est introuvable.', 'The confession channel could not be found.'),
    send_failed: t("Impossible de publier : vérifie les permissions du bot dans le salon.", 'Could not post: check the bot permissions in the channel.'),
  } as const;
  await reply(errorEmbed(t('Confession non envoyée', 'Confession not sent'), reasons[result.reason]));
}

export const confessionCommand = { data, execute } satisfies SlashCommandDefinition;

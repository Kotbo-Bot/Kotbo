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
  deleteConfession,
  revealConfession,
  setConfessionSettings,
  submitConfession,
} from '../../services/features/confessionService.js';
import { CONFESSION_DEFAULT_COOLDOWN_SECONDS } from '../../services/features/confessionPolicy.js';

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
      )
      .addIntegerOption((o) =>
        o
          .setName('cooldown')
          .setNameLocalizations({ fr: 'delai' })
          .setDescription('Seconds between two confessions from the same member (0 = none)')
          .setDescriptionLocalizations({ fr: "Secondes entre deux confessions d'un même membre (0 = aucun)" })
          .setMinValue(0)
          .setMaxValue(86_400)
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
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setNameLocalizations({ fr: 'supprimer' })
      .setDescription('Remove a published confession (admin)')
      .setDescriptionLocalizations({ fr: 'Retirer une confession publiée (admin)' })
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

  if (sub !== 'send' && !isAdmin) {
    await reply(errorEmbed(t('Accès refusé', 'Access denied'), t('Réservé aux administrateurs.', 'Administrators only.')));
    return;
  }

  if (sub === 'setup') {
    const channel = interaction.options.getChannel('channel', true);
    const log = interaction.options.getChannel('log');
    const cooldown = interaction.options.getInteger('cooldown');
    await setConfessionSettings(interaction.guildId, {
      channelId: channel.id,
      logChannelId: log?.id ?? null,
      cooldownSeconds: cooldown ?? undefined,
    });
    const details = [
      `<#${channel.id}>`,
      log ? `${t('journal', 'log')} <#${log.id}>` : null,
      cooldown !== null ? `${t('délai', 'cooldown')} ${cooldown} s` : null,
    ].filter(Boolean).join(' · ');
    await reply(successEmbed(t('Confessions configurées', 'Confessions configured'), details));
    return;
  }

  if (sub === 'delete') {
    const number = interaction.options.getInteger('number', true);
    const outcome = await deleteConfession(
      interaction.guild,
      {
        channelId: guildConfig?.funConfessionChannelId ?? null,
        logChannelId: guildConfig?.funConfessionLogChannelId ?? null,
      },
      number,
      interaction.user.id,
    );
    const messages = {
      deleted: successEmbed(t('Confession supprimée', 'Confession removed'), t(`La confession #${number} a été retirée.`, `Confession #${number} was removed.`)),
      message_kept: errorEmbed(
        t('Message à retirer à la main', 'Remove the message manually'),
        t(
          `La confession #${number} est marquée supprimée, mais le bot n'a pas pu effacer son message : vérifie ses permissions dans le salon.`,
          `Confession #${number} is marked as removed, but the bot could not delete its message: check its permissions in the channel.`,
        ),
      ),
      not_found: errorEmbed(t('Introuvable', 'Not found'), t('Aucune confession avec ce numéro.', 'No confession with that number.')),
      already_deleted: errorEmbed(t('Déjà supprimée', 'Already removed'), t('Cette confession est déjà supprimée.', 'This confession is already removed.')),
    } as const;
    await reply(messages[outcome]);
    return;
  }

  if (sub === 'reveal') {
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
    {
      channelId: guildConfig.funConfessionChannelId,
      logChannelId: guildConfig.funConfessionLogChannelId,
      cooldownSeconds: guildConfig.funConfessionCooldownSeconds ?? CONFESSION_DEFAULT_COOLDOWN_SECONDS,
    },
    interaction.user.id,
    interaction.options.getString('message', true),
  );

  if (result.ok) {
    await reply(successEmbed(t('Confession envoyée', 'Confession sent'), t(`Publiée anonymement (#${result.number}).`, `Posted anonymously (#${result.number}).`)));
    return;
  }

  const reasons = {
    cooldown: t(`Attends ${result.retryInSeconds ?? 0} s avant d'en envoyer une autre.`, `Wait ${result.retryInSeconds ?? 0}s before sending another.`),
    empty: t('Le message est vide.', 'The message is empty.'),
    too_long: t(`Maximum ${CONFESSION_MAX_LENGTH} caractères.`, `Maximum ${CONFESSION_MAX_LENGTH} characters.`),
    blocked: t('Ton message contient un mot interdit sur ce serveur.', 'Your message contains a word banned on this server.'),
    not_configured: t('Le salon des confessions est introuvable.', 'The confession channel could not be found.'),
    send_failed: t("Impossible de publier : vérifie les permissions du bot dans le salon.", 'Could not post: check the bot permissions in the channel.'),
  } as const;
  await reply(errorEmbed(t('Confession non envoyée', 'Confession not sent'), reasons[result.reason]));
}

export const confessionCommand = { data, execute } satisfies SlashCommandDefinition;

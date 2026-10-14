import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { successEmbed, errorEmbed, infoEmbed } from '../../utils/embeds.js';
import {
  getEffectiveLocale,
  getCommandMetadata,
  getGuildLanguageState,
  normalizeLocale,
  type BotLocale,
} from '../../utils/i18n.js';
import {
  rafraichirPanneauxVocaux,
  rerenderPersistentPanels,
  type PanelRerenderOutcome,
} from '../../services/core/panelRerenderService.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('languages');
const langMeta = getCommandMetadata('languages_lang');
const autoMeta = getCommandMetadata('languages_auto');
const currentMeta = getCommandMetadata('languages_current');
const rerenderMeta = getCommandMetadata('languages_rerender');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName(langMeta.name)
      .setNameLocalizations(langMeta.nameLocalizations)
      .setDescription(langMeta.description)
      .setDescriptionLocalizations(langMeta.descriptionLocalizations)
      .addStringOption((opt) =>
        opt
          .setName('langue')
          .setDescription(m.languages_lang_opt_langue({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.languages_lang_opt_langue({}, { locale: 'fr' }) })
          .setRequired(true)
          .addChoices(
            {
              name: m.language_choice_fr({}, { locale: 'en' }),
              name_localizations: { fr: m.language_choice_fr({}, { locale: 'fr' }) },
              value: 'fr',
            },
            {
              name: m.language_choice_en({}, { locale: 'en' }),
              name_localizations: { fr: m.language_choice_en({}, { locale: 'fr' }) },
              value: 'en',
            },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName(autoMeta.name)
      .setNameLocalizations(autoMeta.nameLocalizations)
      .setDescription(autoMeta.description)
      .setDescriptionLocalizations(autoMeta.descriptionLocalizations),
  )
  .addSubcommand((sub) =>
    sub
      .setName(currentMeta.name)
      .setNameLocalizations(currentMeta.nameLocalizations)
      .setDescription(currentMeta.description)
      .setDescriptionLocalizations(currentMeta.descriptionLocalizations),
  )
  .addSubcommand((sub) =>
    sub
      .setName(rerenderMeta.name)
      .setNameLocalizations(rerenderMeta.nameLocalizations)
      .setDescription(rerenderMeta.description)
      .setDescriptionLocalizations(rerenderMeta.descriptionLocalizations),
  );

function languageLabel(target: BotLocale, locale: BotLocale): string {
  return target === 'fr'
    ? m.language_choice_fr({}, { locale })
    : m.language_choice_en({}, { locale });
}

function outcomeLine(outcome: PanelRerenderOutcome, locale: BotLocale): string {
  const label = (m as any)[`languages_rerender_panel_${outcome.panel}`]({}, { locale }) as string;
  if (outcome.status === 'updated') {
    return `**${label}** - ${m.languages_rerender_status_updated({ count: outcome.count }, { locale })}`;
  }
  if (outcome.status === 'skipped') {
    return `**${label}** - ${m.languages_rerender_status_skipped({}, { locale })}`;
  }
  return `**${label}** - ${m.languages_rerender_status_failed({ error: outcome.error ?? '?' }, { locale })}`;
}

async function handleSetLanguage(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const target = interaction.options.getString('langue', true) as BotLocale;
  const avant = (await getGuildLanguageState(guildId, interaction.guildLocale)).locale;

  await prisma.guild.upsert({
    where: { id: guildId },
    update: { language: target },
    create: { id: guildId, language: target },
  });
  await cache.invalidateGuild(guildId);
  // Les panneaux vocaux déjà postés se réécrivent dans la nouvelle langue.
  if (target !== avant) rafraichirPanneauxVocaux(interaction.client, guildId);

  await interaction.reply({
    embeds: [
      successEmbed(
        m.languages_set_title({}, { locale: target }),
        m.languages_set_desc({ lang: languageLabel(target, target) }, { locale: target }),
      ),
    ],
  });
}

async function handleAuto(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  // `language = null` = mode automatique : la cascade retombe sur la locale du
  // serveur Discord, puis sur l'anglais.
  const avant = (await getGuildLanguageState(guildId, interaction.guildLocale)).locale;
  await prisma.guild.upsert({
    where: { id: guildId },
    update: { language: null },
    create: { id: guildId, language: null },
  });
  await cache.invalidateGuild(guildId);

  const detected = normalizeLocale(interaction.guildLocale) ?? 'en';
  if (detected !== avant) rafraichirPanneauxVocaux(interaction.client, guildId);

  await interaction.reply({
    embeds: [
      successEmbed(
        m.languages_auto_title({}, { locale: detected }),
        m.languages_auto_desc({ lang: languageLabel(detected, detected) }, { locale: detected }),
      ),
    ],
  });
}

async function handleCurrent(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const state = await getGuildLanguageState(guildId, interaction.guildLocale);
  const locale = state.locale;

  const used = m.languages_step_used({}, { locale });
  const unset = m.languages_step_unset({}, { locale });
  const skipped = m.languages_step_skipped({}, { locale });

  const manual = state.mode === 'manual';
  const step1 = manual ? used : unset;
  const step2 = manual ? skipped : state.detected ? used : unset;
  const step3 = !manual && !state.detected ? used : skipped;

  await interaction.reply({
    embeds: [
      infoEmbed(
        m.languages_current_title({}, { locale }),
        m.languages_current_desc(
          {
            lang: languageLabel(locale, locale),
            mode: manual
              ? m.languages_current_mode_manual({}, { locale })
              : m.languages_current_mode_auto({}, { locale }),
            step1,
            step2,
            step3,
          },
          { locale },
        ),
      ),
    ],
    flags: [MessageFlags.Ephemeral],
  });
}

async function handleRerender(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  await interaction.deferReply();

  const report = await rerenderPersistentPanels(interaction.client, guildId);
  const details =
    report.updated === 0 && report.failed === 0
      ? m.languages_rerender_none({}, { locale })
      : report.outcomes.map((outcome) => outcomeLine(outcome, locale)).join('\n');

  await interaction.editReply({
    embeds: [
      successEmbed(
        m.languages_rerender_title({}, { locale }),
        m.languages_rerender_desc({ lang: languageLabel(locale, locale), details }, { locale }),
      ),
    ],
  });
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    const locale = await getEffectiveLocale(interaction);
    await interaction.reply({
      embeds: [
        errorEmbed(
          m.languages_guild_only_title({}, { locale }),
          m.languages_guild_only_desc({}, { locale }),
        ),
      ],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  switch (interaction.options.getSubcommand()) {
    case langMeta.name:
      await handleSetLanguage(interaction, guildId);
      return;
    case autoMeta.name:
      await handleAuto(interaction, guildId);
      return;
    case currentMeta.name:
      await handleCurrent(interaction, guildId);
      return;
    case rerenderMeta.name:
      await handleRerender(interaction, guildId);
      return;
  }
}

export const languageCommand = { data, execute } satisfies SlashCommandDefinition;

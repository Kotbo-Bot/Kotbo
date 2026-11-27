import type { SlashCommandDefinition } from '../../commands.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { getEffectiveLocale, localized, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import {
  REPORTER_REPLY_MAX,
  REPORT_PANEL_TEMPLATES,
  cleanResources,
  resourcesForLocale,
  resourcesMessage,
  type ReportPanelTemplate,
} from '../../services/staff/wellbeingReportPolicy.js';
import {
  REPORT_MAX_LENGTH,
  REPORT_MODAL_PREFIX,
  lookupWellbeingReport,
  postReporterMessage,
  reportsOpen,
  submitWellbeingReport,
  type TrackingMessage,
} from '../../services/staff/wellbeingReport.js';

/** Boutons du message permanent : écrire (nominatif ou anonyme), voir les ressources. */
export const REPORT_PANEL_PREFIX = 'wellbeing:open:';
export const RESOURCES_BUTTON_ID = 'wellbeing:resources';

const data = localized(new SlashCommandBuilder(), 'wbc')
  .addSubcommand((sub) =>
    localized(sub, 'wbc_report')
      .addBooleanOption((option) => localized(option, 'wbc_opt_anonymous').setRequired(false)))
  .addSubcommand((sub) => localized(sub, 'wbc_resources'))
  .addSubcommand((sub) =>
    localized(sub, 'wbc_track')
      .addStringOption((option) => localized(option, 'wbc_opt_code').setRequired(true).setMinLength(10).setMaxLength(14)))
  .addSubcommand((sub) =>
    localized(sub, 'wbc_reply')
      .addStringOption((option) => localized(option, 'wbc_opt_code').setRequired(true).setMinLength(10).setMaxLength(14))
      .addStringOption((option) => localized(option, 'wbc_opt_message').setRequired(true).setMaxLength(REPORTER_REPLY_MAX)));

const ephemeral = { flags: [MessageFlags.Ephemeral] as const };

/**
 * Ressources d'aide montrées à un membre : celles de sa langue (celle de son
 * client Discord) et celles pour tous.
 */
async function replyWithResources(interaction: ChatInputCommandInteraction | ButtonInteraction, guildId: string, locale: BotLocale) {
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId }, select: { enabled: true, resources: true } });
  const resources = config?.enabled ? resourcesForLocale(cleanResources(config.resources), interaction.locale) : [];
  await interaction.reply({
    ...ephemeral,
    content: resources.length > 0
      ? resourcesMessage(interaction.guild?.name ?? '', resources)
      : m.wbc_resources_none({}, { locale }),
    allowedMentions: { parse: [] },
  });
}

/** Formulaire de signalement, ouvert par la commande ou par le bouton permanent. */
async function showReportModal(interaction: ChatInputCommandInteraction | ButtonInteraction, guildId: string, anonymous: boolean, locale: BotLocale) {
  if (!(await reportsOpen(guildId))) {
    await interaction.reply({ ...ephemeral, content: m.wbc_reports_off({}, { locale }) });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`${REPORT_MODAL_PREFIX}${anonymous ? '1' : '0'}`)
    .setTitle(anonymous ? m.wbc_modal_title_anonymous({}, { locale }) : m.wbc_modal_title({}, { locale }))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('message')
        .setLabel(m.wbc_modal_label({}, { locale }))
        .setPlaceholder(m.wbc_modal_ph({}, { locale }))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(REPORT_MAX_LENGTH),
    ));
  await interaction.showModal(modal);
}

function threadText(thread: readonly TrackingMessage[], locale: BotLocale): string {
  return thread
    .map((message) => {
      // Chaque ligne reste dans la citation, sinon la suite d'un message long en sortirait.
      const quoted = message.content.replace(/\n/g, '\n> ');
      return message.fromReporter
        ? m.wbc_track_from_you({ message: quoted }, { locale })
        : m.wbc_track_from_cell({ message: quoted }, { locale });
    })
    .join('\n');
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const locale = await getEffectiveLocale(interaction);
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'resources') {
    await replyWithResources(interaction, guildId, locale);
    return;
  }

  if (subcommand === 'track') {
    const { status, thread } = await lookupWellbeingReport(guildId, interaction.user.id, interaction.options.getString('code', true));
    const replies = {
      cooldown: () => m.wbc_track_cooldown({}, { locale }),
      unknown: () => m.wbc_track_unknown({}, { locale }),
      received: () => m.wbc_track_received({}, { locale }),
      in_progress: () => m.wbc_track_in_progress({}, { locale }),
      closed: () => m.wbc_track_closed({}, { locale }),
    };
    const content = thread.length > 0 ? `${replies[status]()}\n\n${threadText(thread, locale)}` : replies[status]();
    await interaction.reply({ ...ephemeral, content: content.slice(0, 2000), allowedMentions: { parse: [] } });
    return;
  }

  if (subcommand === 'reply') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const outcome = await postReporterMessage(
      interaction.client,
      guildId,
      interaction.user.id,
      interaction.options.getString('code', true),
      interaction.options.getString('message', true),
    ).catch(() => 'error' as const);
    const replies = {
      sent: () => m.wbc_reply_sent({}, { locale }),
      cooldown: () => m.wbc_track_cooldown({}, { locale }),
      unknown: () => m.wbc_track_unknown({}, { locale }),
      closed: () => m.wbc_reply_closed({}, { locale }),
      empty: () => m.wbc_empty({}, { locale }),
      error: () => m.wbc_error({}, { locale }),
    };
    await interaction.editReply({ content: replies[outcome]() });
    return;
  }

  await showReportModal(interaction, guildId, interaction.options.getBoolean('anonymous') ?? false, locale);
}

/** Boutons du message permanent de la cellule. */
export async function handleWellbeingPanelButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const locale = await getEffectiveLocale(interaction);
  if (interaction.customId === RESOURCES_BUTTON_ID) {
    await replyWithResources(interaction, guildId, locale);
    return;
  }
  await showReportModal(interaction, guildId, interaction.customId === `${REPORT_PANEL_PREFIX}1`, locale);
}

const PANEL_TEXTS: Record<ReportPanelTemplate, (locale: BotLocale) => string> = {
  listening: (locale) => m.wbc_panel_text({}, { locale }),
  short: (locale) => m.wbc_panel_text_short({}, { locale }),
  staff: (locale) => m.wbc_panel_text_staff({}, { locale }),
  anonymous: (locale) => m.wbc_panel_text_anonymous({}, { locale }),
};

/** Texte d'un modèle du message permanent, dans la langue du serveur. */
export function wellbeingPanelText(template: ReportPanelTemplate, locale: BotLocale): string {
  return PANEL_TEXTS[template](locale);
}

/** Message permanent posté dans un salon : écrire à la cellule sans taper de commande. */
export function wellbeingPanelMessage(locale: BotLocale, template: ReportPanelTemplate = REPORT_PANEL_TEMPLATES[0], text: string | null = null) {
  return {
    content: text ?? wellbeingPanelText(template, locale),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${REPORT_PANEL_PREFIX}0`).setStyle(ButtonStyle.Primary).setLabel(m.wbc_panel_write({}, { locale })),
        new ButtonBuilder().setCustomId(`${REPORT_PANEL_PREFIX}1`).setStyle(ButtonStyle.Secondary).setLabel(m.wbc_panel_write_anonymous({}, { locale })),
        new ButtonBuilder().setCustomId(RESOURCES_BUTTON_ID).setStyle(ButtonStyle.Secondary).setLabel(m.wbc_panel_resources({}, { locale })),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

/** Envoi du formulaire `/confidentiel signaler`. */
export async function handleWellbeingReportModal(interaction: ModalSubmitInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const locale = await getEffectiveLocale(interaction);
  const anonymous = interaction.customId.endsWith(':1');
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const result = await submitWellbeingReport(
    interaction.client,
    guildId,
    { id: interaction.user.id, username: interaction.user.username },
    interaction.fields.getTextInputValue('message'),
    anonymous,
  ).catch(() => ({ outcome: 'error' as const, code: undefined }));
  const outcome = result.outcome;
  const code = result.code ?? '';

  const replies = {
    sent: () => (anonymous ? m.wbc_sent_anonymous({ code }, { locale }) : m.wbc_sent({ code }, { locale })),
    disabled: () => m.wbc_reports_off({}, { locale }),
    cooldown: () => m.wbc_cooldown({}, { locale }),
    empty: () => m.wbc_empty({}, { locale }),
    error: () => m.wbc_error({}, { locale }),
  };
  await interaction.editReply({ content: replies[outcome]() });
}

export const wellbeingCommand = { data, execute } satisfies SlashCommandDefinition;

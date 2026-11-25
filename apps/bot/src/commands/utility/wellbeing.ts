import type { SlashCommandDefinition } from '../../commands.js';
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { getEffectiveLocale, localized } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { cleanResources, resourcesMessage } from '../../services/staff/wellbeingPolicy.js';
import { REPORT_MAX_LENGTH, REPORT_MODAL_PREFIX, lookupWellbeingReport, reportsOpen, submitWellbeingReport } from '../../services/staff/wellbeingReport.js';

const data = localized(new SlashCommandBuilder(), 'wbc')
  .addSubcommand((sub) =>
    localized(sub, 'wbc_report')
      .addBooleanOption((option) => localized(option, 'wbc_opt_anonymous').setRequired(false)))
  .addSubcommand((sub) => localized(sub, 'wbc_resources'))
  .addSubcommand((sub) =>
    localized(sub, 'wbc_track')
      .addStringOption((option) => localized(option, 'wbc_opt_code').setRequired(true).setMinLength(10).setMaxLength(14)));

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const locale = await getEffectiveLocale(interaction);
  const ephemeral = { flags: [MessageFlags.Ephemeral] as const };

  if (interaction.options.getSubcommand() === 'resources') {
    const config = await prisma.wellbeingConfig.findUnique({ where: { guildId }, select: { enabled: true, resources: true } });
    const resources = config?.enabled ? cleanResources(config.resources) : [];
    await interaction.reply({
      ...ephemeral,
      content: resources.length > 0
        ? resourcesMessage(interaction.guild?.name ?? '', resources)
        : m.wbc_resources_none({}, { locale }),
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (interaction.options.getSubcommand() === 'track') {
    const status = await lookupWellbeingReport(guildId, interaction.user.id, interaction.options.getString('code', true));
    const replies = {
      cooldown: () => m.wbc_track_cooldown({}, { locale }),
      unknown: () => m.wbc_track_unknown({}, { locale }),
      received: () => m.wbc_track_received({}, { locale }),
      in_progress: () => m.wbc_track_in_progress({}, { locale }),
      closed: () => m.wbc_track_closed({}, { locale }),
    };
    await interaction.reply({ ...ephemeral, content: replies[status]() });
    return;
  }

  if (!(await reportsOpen(guildId))) {
    await interaction.reply({ ...ephemeral, content: m.wbc_reports_off({}, { locale }) });
    return;
  }
  const anonymous = interaction.options.getBoolean('anonymous') ?? false;
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

/** Envoi du formulaire `/bienetre signaler`. */
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

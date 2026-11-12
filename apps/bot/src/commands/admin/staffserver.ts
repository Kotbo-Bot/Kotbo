import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { COLORS, successEmbed, errorEmbed } from '../../utils/embeds.js';
import {
  createStaffServerLink,
  removeStaffServerLink,
  listStaffServerLinks,
  addRoleMapping,
  removeRoleMapping,
  fullSyncStaffRoles,
  autoSetupRoleMappings,
} from '../../services/staff/staffServerService.js';
import { getEffectiveLocale, localized, localizedChoice } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

function syncModeLabel(mode: string, locale: 'fr' | 'en'): string {
  switch (mode) {
    case 'MAIN_TO_STAFF':
      return m.b4_staffserver_mode_main_to_staff({}, { locale });
    case 'STAFF_TO_MAIN':
      return m.b4_staffserver_mode_staff_to_main({}, { locale });
    case 'BIDIRECTIONAL':
      return m.b4_staffserver_mode_bidirectional({}, { locale });
    default:
      return mode;
  }
}

const data = localized(new SlashCommandBuilder(), 'ssv')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    localized(sub, 'ssv_setup')
      .addStringOption((opt) => localized(opt, 'ssv_opt_staff_server').setRequired(true))
      .addStringOption((opt) =>
        localized(opt, 'ssv_opt_mode')
          .setRequired(true)
          .addChoices(
            localizedChoice('ssv_choice_main_to_staff', 'MAIN_TO_STAFF'),
            localizedChoice('ssv_choice_staff_to_main', 'STAFF_TO_MAIN'),
            localizedChoice('ssv_choice_bidirectional', 'BIDIRECTIONAL'),
          ),
      )
      .addStringOption((opt) => localized(opt, 'ssv_opt_hierarchy'))
      .addRoleOption((opt) => localized(opt, 'ssv_opt_simple_role'))
      .addChannelOption((opt) => localized(opt, 'ssv_opt_main_log').addChannelTypes(ChannelType.GuildText))
      .addStringOption((opt) => localized(opt, 'ssv_opt_staff_log')),
  )
  .addSubcommand((sub) =>
    localized(sub, 'ssv_mapping')
      .addStringOption((opt) => localized(opt, 'ssv_opt_link_id').setRequired(true))
      .addRoleOption((opt) => localized(opt, 'ssv_opt_main_role'))
      .addStringOption((opt) => localized(opt, 'ssv_opt_staff_role'))
      .addStringOption((opt) => localized(opt, 'ssv_opt_staff_role_db')),
  )
  .addSubcommand((sub) =>
    localized(sub, 'ssv_unmap')
      .addStringOption((opt) => localized(opt, 'ssv_opt_mapping_id').setRequired(true)),
  )
  .addSubcommand((sub) => localized(sub, 'ssv_list'))
  .addSubcommand((sub) =>
    localized(sub, 'ssv_sync')
      .addStringOption((opt) => localized(opt, 'ssv_opt_sync_link').setRequired(true)),
  )
  .addSubcommand((sub) =>
    localized(sub, 'ssv_remove')
      .addStringOption((opt) => localized(opt, 'ssv_opt_remove_link').setRequired(true)),
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  switch (sub) {
    case 'setup':
      return handleSetup(interaction);
    case 'mapping':
      return handleMapping(interaction);
    case 'unmap':
      return handleUnmap(interaction);
    case 'list':
      return handleList(interaction);
    case 'sync':
      return handleSync(interaction);
    case 'remove':
      return handleRemove(interaction);
  }
}

async function handleSetup(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const staffGuildId = interaction.options.getString('staff-server', true);
  const syncMode = interaction.options.getString('mode', true) as 'MAIN_TO_STAFF' | 'STAFF_TO_MAIN' | 'BIDIRECTIONAL';
  const hierarchyId = interaction.options.getString('hierarchy') ?? undefined;
  const simpleStaffRole = interaction.options.getRole('simple-staff-role');
  const logChannel = interaction.options.getChannel('main-log');
  const staffLogChannelId = interaction.options.getString('staff-log') ?? undefined;

  const staffGuild = interaction.client.guilds.cache.get(staffGuildId);
  if (!staffGuild) {
    await interaction.editReply({
      embeds: [errorEmbed(m.b4_error({}, { locale }), m.b4_staffserver_bot_not_present({}, { locale }))],
    });
    return;
  }

  const result = await createStaffServerLink({
    mainGuildId: interaction.guildId!,
    staffGuildId,
    syncMode,
    hierarchyId,
    simpleStaffRoleId: simpleStaffRole?.id,
    mainLogChannelId: logChannel?.id,
    staffLogChannelId,
    createdByUserId: interaction.user.id,
  });

  if ('error' in result) {
    await interaction.editReply({ embeds: [errorEmbed(m.b4_error({}, { locale }), result.error)] });
    return;
  }

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLORS.warning).setDescription(m.b4_staffserver_link_created_progress({}, { locale }))],
  });

  const roleSetup = await autoSetupRoleMappings(result, interaction.client);
  const syncResult = await fullSyncStaffRoles(result.id, interaction.client);

  const failedLine = roleSetup.failed > 0 ? m.b4_staffserver_setup_failed_line({ failed: roleSetup.failed }, { locale }) : '';

  const embed = successEmbed(
    m.b4_staffserver_setup_success_title({}, { locale }),
    m.b4_staffserver_setup_success_desc({
      staffName: staffGuild.name,
      syncMode: syncModeLabel(syncMode, locale),
      hierarchy: hierarchyId || m.b4_staffserver_all({}, { locale }),
      simpleRole: simpleStaffRole ? `<@&${simpleStaffRole.id}>` : m.b4_staffserver_not_configured({}, { locale }),
      linkId: result.id,
      matched: roleSetup.matched,
      created: roleSetup.created,
      staffName2: staffGuild.name,
      failedLine,
      synced: syncResult.synced,
      errors: syncResult.errors,
    }, { locale }),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleMapping(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const linkId = interaction.options.getString('link-id', true);
  const mainRole = interaction.options.getRole('main-role');
  const staffRoleId = interaction.options.getString('staff-role');
  const staffRoleDbId = interaction.options.getString('staff-role-id');

  if (!mainRole && !staffRoleId) {
    await interaction.editReply({
      embeds: [errorEmbed(m.b4_error({}, { locale }), m.b4_staffserver_mapping_need_role({}, { locale }))],
    });
    return;
  }

  const mapping = await addRoleMapping({
    staffServerLinkId: linkId,
    staffRoleId: staffRoleDbId ?? undefined,
    mainDiscordRoleId: mainRole?.id,
    staffDiscordRoleId: staffRoleId ?? undefined,
  });

  const embed = successEmbed(
    m.b4_staffserver_mapping_added_title({}, { locale }),
    m.b4_staffserver_mapping_added_desc({
      mappingId: mapping.id,
      mainRole: mainRole ? `<@&${mainRole.id}>` : m.b4_staffserver_unspecified({}, { locale }),
      staffRole: staffRoleId ? `\`${staffRoleId}\`` : m.b4_staffserver_unspecified({}, { locale }),
    }, { locale }),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleUnmap(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const mappingId = interaction.options.getString('mapping-id', true);
  await removeRoleMapping(mappingId);

  await interaction.editReply({
    embeds: [successEmbed(m.b4_staffserver_mapping_removed_title({}, { locale }), m.b4_staffserver_mapping_removed_desc({ mappingId }, { locale }))],
  });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const links = await listStaffServerLinks(interaction.guildId!);

  if (links.length === 0) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLORS.info).setDescription(m.b4_staffserver_none_linked({}, { locale }))],
    });
    return;
  }

  const lines = links.map((l) => {
    const isMain = l.mainGuildId === interaction.guildId;
    const otherGuildId = isMain ? l.staffGuildId : l.mainGuildId;
    const otherGuild = interaction.client.guilds.cache.get(otherGuildId);
    const statusIcon = l.enabled ? '🟢' : '🔴';
    const roleLabel = isMain ? m.b4_staffserver_role_main({}, { locale }) : m.b4_staffserver_role_staff({}, { locale });
    const mappingCount = l.roleMappings.length;

    return (
      `${statusIcon} \`${l.id.slice(0, 8)}\` **${otherGuild?.name || otherGuildId}** (${roleLabel})\n` +
      m.b4_staffserver_list_line_mode({ mode: syncModeLabel(l.syncMode, locale), mappingCount }, { locale })
    );
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(m.b4_staffserver_list_title({}, { locale }))
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: m.b4_staffserver_list_footer({ count: links.length }, { locale }) })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleSync(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const linkId = interaction.options.getString('link-id', true);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLORS.warning).setDescription(m.b4_staffserver_sync_progress({}, { locale }))],
  });

  const result = await fullSyncStaffRoles(linkId, interaction.client);

  const embed = successEmbed(
    m.b4_staffserver_sync_done_title({}, { locale }),
    m.b4_staffserver_sync_done_desc({ synced: result.synced, errors: result.errors }, { locale }),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const linkId = interaction.options.getString('link-id', true);
  const deleted = await removeStaffServerLink(linkId);

  if (!deleted) {
    await interaction.editReply({ embeds: [errorEmbed(m.b4_error({}, { locale }), m.b4_staffserver_link_not_found({}, { locale }))] });
    return;
  }

  await interaction.editReply({
    embeds: [successEmbed(m.b4_staffserver_link_removed_title({}, { locale }), m.b4_staffserver_link_removed_desc({ linkId }, { locale }))],
  });
}

export const staffserverCommand = { data, execute } satisfies SlashCommandDefinition;

import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import * as altAccountService from '../../services/moderation/altAccountService.js';
import prisma from '../../utils/db.js';
import { COLORS, successEmbed, infoEmbed } from '../../utils/embeds.js';
import { scanGuildMembersForYoungAccounts } from '../../services/moderation/dcDetectionService.js';
import { getEffectiveLocale, localized, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = localized(new SlashCommandBuilder(), 'dc')
  .addSubcommand((sub) =>
    localized(sub, 'dc_link')
      .addUserOption((opt) => localized(opt, 'dc_opt_account1').setRequired(true))
      .addUserOption((opt) => localized(opt, 'dc_opt_account2').setRequired(true))
      .addStringOption((opt) => localized(opt, 'dc_opt_reason').setRequired(false))
  )
  .addSubcommand((sub) =>
    localized(sub, 'dc_list')
      .addUserOption((opt) => localized(opt, 'dc_opt_target').setRequired(true))
  )
  .addSubcommand((sub) =>
    localized(sub, 'dc_report')
      .addUserOption((opt) => localized(opt, 'dc_opt_main').setRequired(true))
  )
  .addSubcommand((sub) =>
    localized(sub, 'dc_unlink')
      .addUserOption((opt) => localized(opt, 'dc_opt_account1').setRequired(true))
      .addUserOption((opt) => localized(opt, 'dc_opt_account2').setRequired(true))
  )
  .addSubcommand((sub) =>
    localized(sub, 'dc_scan')
      .addIntegerOption((opt) => localized(opt, 'dc_opt_days').setMinValue(1).setMaxValue(30).setRequired(false))
  )
  .addSubcommand((sub) =>
    localized(sub, 'dc_rescan')
      .addIntegerOption((opt) => localized(opt, 'dc_opt_days').setMinValue(1).setMaxValue(30).setRequired(false))
  );

async function canUseModerationTools(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || !interaction.guildId) return false;

  const isStaffDb = await prisma.staffMember.findUnique({ where: { guildId_userId: { guildId: guild.id, userId: interaction.user.id } } });
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || false;

  return isAdmin || !!isStaffDb || interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) || false;
}

function reviewButtons(user1Id: string, user2Id: string, locale: BotLocale) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dc_validate_link:${user1Id}:${user2Id}`)
      .setLabel(m.dc_btn_validate({}, { locale }))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`dc_reject_link:${user1Id}:${user2Id}`)
      .setLabel(m.dc_btn_reject({}, { locale }))
      .setStyle(ButtonStyle.Danger)
  );
}

async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const locale = await getEffectiveLocale(interaction);
  const ephemeral = (content: string) => interaction.reply({ content, flags: [MessageFlags.Ephemeral] });

  if (subcommand === 'scan' || subcommand === 'rescan') {
    const guild = interaction.guild;
    if (!guild || !interaction.guildId) {
      return ephemeral(m.dc_guild_only({}, { locale }));
    }

    if (!(await canUseModerationTools(interaction))) {
      return ephemeral(m.dc_scan_no_perm({}, { locale }));
    }

    const thresholdDays = interaction.options.getInteger('max_days') ?? 3;
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const result = await scanGuildMembersForYoungAccounts(guild, thresholdMs);
    const preview = result.matches
      .slice(0, 10)
      .map((match) => m.dc_scan_match({ user: `<@${match.userId}>`, age: match.accountAgeLabel }, { locale }))
      .join('\n');

    const summaryLines: string[] = [
      m.dc_scan_scanned({ count: result.scannedCount }, { locale }),
      m.dc_scan_flagged({ count: result.flaggedCount }, { locale }),
      m.dc_scan_threshold({ days: thresholdDays }, { locale }),
    ];

    if (result.flaggedCount > 0) {
      summaryLines.push('');
      summaryLines.push(m.dc_scan_first({}, { locale }));
      summaryLines.push(preview);
      if (result.matches.length > 10) {
        summaryLines.push(m.dc_scan_more({ count: result.matches.length - 10 }, { locale }));
      }
    }

    await interaction.editReply({
      embeds: [infoEmbed(m.dc_scan_title({}, { locale }), summaryLines.join('\n'))]
    });
    return;
  }

  if (subcommand === 'link') {
    const u1 = interaction.options.getUser('account1', true);
    const u2 = interaction.options.getUser('account2', true);
    const reason = interaction.options.getString('reason');

    if (u1.id === u2.id) {
      return ephemeral(m.dc_link_self({}, { locale }));
    }

    const guild = interaction.guild;
    if (!guild) return;

    const dbGuild = await prisma.guild.findUnique({ where: { id: guild.id } });
    const isStaffDb = await prisma.staffMember.findUnique({ where: { guildId_userId: { guildId: guild.id, userId: interaction.user.id } } });

    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || false;
    // We consider staff if they are in the staff_members table, or have the mod permission
    const isStaff = isAdmin || !!isStaffDb || interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) || false;

    if (!isStaff) {
      // Non-staff: Can only link their own account
      if (u1.id !== interaction.user.id && u2.id !== interaction.user.id) {
        return ephemeral(m.dc_link_own_only({}, { locale }));
      }

      await altAccountService.linkAccounts({
        guildId: interaction.guildId!,
        user1Id: u1.id,
        user2Id: u2.id,
        type: 'MANUAL',
        status: 'PENDING',
        reason: reason || m.dc_good_faith_reason({}, { locale }),
        linkedByUserId: interaction.user.id,
        metadata: { linkedBy: interaction.user.id, at: new Date().toISOString() }
      });

      // Send log to staff
      const logChannelId = dbGuild?.logChannelId;
      if (logChannelId) {
        const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
        if (logChannel && logChannel.isTextBased()) {
          const staffPing = dbGuild.baseStaffRoleId ? `<@&${dbGuild.baseStaffRoleId}>` : 'Staff';
          const embed = new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle(m.dc_pending_title({}, { locale }))
            .setDescription(m.dc_pending_desc({
              staff: staffPing,
              author: `<@${interaction.user.id}>`,
              user1: `<@${u1.id}>`,
              user2: `<@${u2.id}>`,
            }, { locale }))
            .addFields(
              { name: m.dc_field_account1({}, { locale }), value: `<@${u1.id}> (${u1.id})`, inline: true },
              { name: m.dc_field_account2({}, { locale }), value: `<@${u2.id}> (${u2.id})`, inline: true },
              { name: m.dc_field_reason({}, { locale }), value: reason || m.dc_reason_none({}, { locale }), inline: false }
            )
            .setTimestamp();

          await logChannel.send({
            content: `${staffPing} <@${u1.id}> <@${u2.id}>`,
            embeds: [embed],
            components: [reviewButtons(u1.id, u2.id, locale)],
            allowedMentions: { parse: [] },
          });
        }
      }

      return ephemeral(m.dc_link_request_sent({}, { locale }));
    }

    // Staff Logic
    if (!isAdmin && !reason) {
      return ephemeral(m.dc_staff_reason_required({}, { locale }));
    }

    await altAccountService.linkAccounts({
      guildId: interaction.guildId!,
      user1Id: u1.id,
      user2Id: u2.id,
      type: 'MANUAL',
      status: 'VALIDATED',
      reason: reason || m.dc_admin_reason({}, { locale }),
      linkedByUserId: interaction.user.id,
      metadata: { linkedBy: interaction.user.id, at: new Date().toISOString() }
    });

    const dmEmbed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle(m.dc_linked_dm_title({}, { locale }))
      .setDescription(m.dc_linked_dm_desc({ user1: `<@${u1.id}>`, user2: `<@${u2.id}>`, server: guild.name }, { locale }))
      .addFields({ name: m.dc_field_notes({}, { locale }), value: reason || m.dc_linked_by_staff({}, { locale }), inline: false })
      .setTimestamp()
      .setFooter({ text: m.dc_footer_server({ server: guild.name }, { locale }) });

    try {
      await u1.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } }).catch(() => null);
    } catch { /* ignored */ }
    try {
      await u2.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } }).catch(() => null);
    } catch { /* ignored */ }

    return interaction.reply({
      embeds: [successEmbed(
        m.dc_linked_title({}, { locale }),
        m.dc_linked_desc({ user1: `<@${u1.id}>`, user2: `<@${u2.id}>` }, { locale }),
      )]
    });
  }

  if (subcommand === 'list') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
      return ephemeral(m.dc_no_mod_perm({}, { locale }));
    }

    const target = interaction.options.getUser('target', true);
    const linkedIds = await altAccountService.getAllLinkedUserIds(interaction.guildId!, target.id);

    if (linkedIds.length <= 1) {
      return ephemeral(m.dc_list_none({ user: `<@${target.id}>` }, { locale }));
    }

    const others = linkedIds.filter(id => id !== target.id);
    const embed = infoEmbed(m.dc_linked_title({}, { locale }), m.dc_list_desc({ user: `<@${target.id}>` }, { locale }))
      .addFields({ name: m.dc_list_field({}, { locale }), value: others.map(id => `<@${id}> (${id})`).join('\n') });

    return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
  }

  if (subcommand === 'report') {
    const mainAccount = interaction.options.getUser('main', true);

    if (mainAccount.id === interaction.user.id) {
      return ephemeral(m.dc_report_self({}, { locale }));
    }

    // Send to staff for validation
    const guild = interaction.guild;
    if (!guild) return;

    const dbGuild = await prisma.guild.findUnique({ where: { id: guild.id } });
    const logChannelId = dbGuild?.logChannelId;

    if (!logChannelId) {
      return ephemeral(m.dc_no_log_config({}, { locale }));
    }

    const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) {
      return ephemeral(m.dc_log_not_found({}, { locale }));
    }

    await altAccountService.linkAccounts({
      guildId: interaction.guildId!,
      user1Id: interaction.user.id,
      user2Id: mainAccount.id,
      type: 'MANUAL',
      status: 'PENDING',
      reason: m.dc_good_faith_reason({}, { locale }),
      linkedByUserId: interaction.user.id,
      metadata: { linkedBy: interaction.user.id, at: new Date().toISOString() }
    });

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(m.dc_report_title({}, { locale }))
      .setDescription(m.dc_report_desc({ author: `<@${interaction.user.id}>`, main: `<@${mainAccount.id}>` }, { locale }))
      .addFields(
        { name: m.dc_field_alt({}, { locale }), value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: true },
        { name: m.dc_field_main({}, { locale }), value: `<@${mainAccount.id}> (${mainAccount.id})`, inline: true }
      )
      .setTimestamp();

    await logChannel.send({
      embeds: [embed],
      components: [reviewButtons(interaction.user.id, mainAccount.id, locale)],
      allowedMentions: { parse: [] },
    });

    return ephemeral(m.dc_report_sent({}, { locale }));
  }

  if (subcommand === 'unlink') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
      return ephemeral(m.dc_no_mod_perm({}, { locale }));
    }

    const u1 = interaction.options.getUser('account1', true);
    const u2 = interaction.options.getUser('account2', true);

    await altAccountService.unlinkAccounts(interaction.guildId!, u1.id, u2.id);

    const dmEmbed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle(m.dc_unlinked_dm_title({}, { locale }))
      .setDescription(m.dc_unlinked_dm_desc({
        user1: `<@${u1.id}>`,
        user2: `<@${u2.id}>`,
        server: interaction.guild?.name || m.dc_the_server({}, { locale }),
      }, { locale }))
      .setTimestamp()
      .setFooter({ text: m.dc_footer_server({ server: interaction.guild?.name || 'Kotbo' }, { locale }) });

    try {
      await u1.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } }).catch(() => null);
    } catch { /* ignored */ }
    try {
      await u2.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } }).catch(() => null);
    } catch { /* ignored */ }

    return interaction.reply({
      embeds: [successEmbed(
        m.dc_unlinked_title({}, { locale }),
        m.dc_unlinked_desc({ user1: `<@${u1.id}>`, user2: `<@${u2.id}>` }, { locale }),
      )]
    });
  }
}

export const dcCommand = { data, execute } satisfies SlashCommandDefinition;

import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { COLORS, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, localized, localizedChoice, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import {
  getRaidProtectionConfig,
  upsertRaidProtectionConfig,
  activateRaidMode,
  deactivateRaidMode,
  enableJoinLock,
  disableJoinLock,
  enableDmLock,
  disableDmLock,
} from '../../services/moderation/raidProtectionService.js';
import { rescanGuildTagRoles } from '../../services/moderation/tagRoleService.js';
import {
  isLockable,
  listLockedChannelIds,
  lockChannel,
  unlockChannel,
  type LockableChannel,
} from '../../services/moderation/lockdownService.js';
import { getReportStats } from '../../services/moderation/reportService.js';
import { provisionJail } from '../../services/moderation/jailService.js';

const LOCKDOWN_SCOPE_CHOICES = [
  localizedChoice('prot_choice_scope_channel', 'channel'),
  localizedChoice('prot_choice_scope_category', 'category'),
  localizedChoice('prot_choice_scope_server', 'server'),
];

const LOCKDOWN_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildCategory,
] as const;

const data = localized(new SlashCommandBuilder(), 'prot')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((group) =>
    localized(group, 'prot_captcha')
      .addSubcommand((sub) =>
        localized(sub, 'prot_captcha_enable')
          .addChannelOption((opt) =>
            localized(opt, 'prot_opt_captcha_channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
          .addRoleOption((opt) =>
            localized(opt, 'prot_opt_captcha_role').setRequired(true))
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_captcha_timeout').setMinValue(2).setMaxValue(60))
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_captcha_attempts').setMinValue(1).setMaxValue(10))
          .addStringOption((opt) =>
            localized(opt, 'prot_opt_captcha_penalty').addChoices(
              localizedChoice('prot_choice_kick', 'KICK'),
              localizedChoice('prot_choice_ban', 'BAN'),
            ))
          .addChannelOption((opt) =>
            localized(opt, 'prot_opt_captcha_logs').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((sub) => localized(sub, 'prot_captcha_disable')))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_antiraid')
      .addSubcommand((sub) =>
        localized(sub, 'prot_antiraid_enable')
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_threshold').setMinValue(3).setMaxValue(100))
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_window').setMinValue(10).setMaxValue(600))
          .addStringOption((opt) =>
            localized(opt, 'prot_opt_raid_action').addChoices(
              localizedChoice('prot_choice_lock', 'LOCK'),
              localizedChoice('prot_choice_captcha', 'CAPTCHA'),
              localizedChoice('prot_choice_autokick', 'KICK'),
            ))
          .addChannelOption((opt) =>
            localized(opt, 'prot_opt_raid_alerts').addChannelTypes(ChannelType.GuildText))
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_raid_duration').setMinValue(5).setMaxValue(1440)))
      .addSubcommand((sub) => localized(sub, 'prot_antiraid_disable')))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_raidmode')
      .addSubcommand((sub) => localized(sub, 'prot_raidmode_on'))
      .addSubcommand((sub) => localized(sub, 'prot_raidmode_off')))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_joinlock')
      .addSubcommand((sub) =>
        localized(sub, 'prot_joinlock_on')
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_hours').setMinValue(1).setMaxValue(720)))
      .addSubcommand((sub) => localized(sub, 'prot_joinlock_off')))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_dmlock')
      .addSubcommand((sub) =>
        localized(sub, 'prot_dmlock_on')
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_hours').setMinValue(1).setMaxValue(720)))
      .addSubcommand((sub) => localized(sub, 'prot_dmlock_off')))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_reports')
      .addSubcommand((sub) =>
        localized(sub, 'prot_reports_enable')
          .addChannelOption((opt) =>
            localized(opt, 'prot_opt_reports_channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_cooldown').setMinValue(0).setMaxValue(3600))
          .addBooleanOption((opt) =>
            localized(opt, 'prot_opt_anonymous')))
      .addSubcommand((sub) => localized(sub, 'prot_reports_disable')))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_tagrole')
      .addSubcommand((sub) =>
        localized(sub, 'prot_tagrole_enable')
          .addRoleOption((opt) => localized(opt, 'prot_opt_tag_role').setRequired(true)))
      .addSubcommand((sub) => localized(sub, 'prot_tagrole_disable'))
      .addSubcommand((sub) => localized(sub, 'prot_tagrole_rescan')))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_scam')
      .addSubcommand((sub) =>
        localized(sub, 'prot_scam_enable')
          .addStringOption((opt) =>
            localized(opt, 'prot_opt_scam_action').addChoices(
              localizedChoice('prot_choice_delete', 'DELETE'),
              localizedChoice('prot_choice_delete_warn', 'DELETE_AND_WARN'),
              localizedChoice('prot_choice_delete_timeout', 'DELETE_AND_TIMEOUT'),
              localizedChoice('prot_choice_delete_ban', 'DELETE_AND_BAN'),
            ))
          .addChannelOption((opt) =>
            localized(opt, 'prot_opt_alerts').addChannelTypes(ChannelType.GuildText))
          .addBooleanOption((opt) =>
            localized(opt, 'prot_opt_images')))
      .addSubcommand((sub) => localized(sub, 'prot_scam_disable')))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_invites')
      .addSubcommand((sub) =>
        localized(sub, 'prot_invites_enable')
          .addBooleanOption((opt) =>
            localized(opt, 'prot_opt_single_use'))
          .addBooleanOption((opt) =>
            localized(opt, 'prot_opt_validation'))
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_spam_threshold').setMinValue(2).setMaxValue(50))
          .addIntegerOption((opt) =>
            localized(opt, 'prot_opt_spam_window').setMinValue(10).setMaxValue(3600))
          .addChannelOption((opt) =>
            localized(opt, 'prot_opt_invite_alerts').addChannelTypes(ChannelType.GuildText))
          .addRoleOption((opt) =>
            localized(opt, 'prot_opt_exempt_role')))
      .addSubcommand((sub) => localized(sub, 'prot_invites_disable'))
      .addSubcommand((sub) =>
        localized(sub, 'prot_invites_emergency')
          .addBooleanOption((opt) =>
            localized(opt, 'prot_opt_active').setRequired(true))))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_lockdown')
      .addSubcommand((sub) =>
        localized(sub, 'prot_lockdown_on')
          .addStringOption((opt) =>
            localized(opt, 'prot_opt_scope_lock').addChoices(...LOCKDOWN_SCOPE_CHOICES))
          .addChannelOption((opt) =>
            localized(opt, 'prot_opt_lock_channel').addChannelTypes(...LOCKDOWN_CHANNEL_TYPES))
          .addStringOption((opt) =>
            localized(opt, 'prot_opt_reason').setMaxLength(300))
          .addBooleanOption((opt) =>
            localized(opt, 'prot_opt_silent_lock')))
      .addSubcommand((sub) =>
        localized(sub, 'prot_lockdown_off')
          .addStringOption((opt) =>
            localized(opt, 'prot_opt_scope_unlock').addChoices(...LOCKDOWN_SCOPE_CHOICES))
          .addChannelOption((opt) =>
            localized(opt, 'prot_opt_lock_channel').addChannelTypes(...LOCKDOWN_CHANNEL_TYPES))
          .addBooleanOption((opt) =>
            localized(opt, 'prot_opt_silent_unlock'))))
  .addSubcommandGroup((group) =>
    localized(group, 'prot_jail')
      .addSubcommand((sub) =>
        localized(sub, 'prot_jail_setup')
          .addBooleanOption((opt) =>
            localized(opt, 'prot_opt_jail_channel'))))
  .addSubcommand((sub) => localized(sub, 'prot_status'));

type LockdownScope = 'channel' | 'category' | 'server';

// Sur une catégorie ou tout le serveur, les salons privés sont laissés de côté : le
// staff y écrit souvent grâce au seul rôle qui lui ouvre l'accès, et le refus posé
// à @everyone l'y ferait taire au moment où il doit se coordonner.
function isPublicLockable(guild: Guild, channel: GuildBasedChannel): channel is LockableChannel {
  if (channel.isThread() || !isLockable(channel)) return false;
  return channel.permissionsFor(guild.roles.everyone).has(PermissionFlagsBits.ViewChannel);
}

/**
 * Salons visés par une portée. Un fil renvoie à son salon parent, et une catégorie
 * choisie avec la portée « salon » vaut pour toute la catégorie : on ne verrouille
 * jamais la catégorie elle-même, dont les permissions ne s'appliquent pas à ses
 * salons une fois ceux-ci modifiés un par un.
 */
function resolveLockdownTargets(
  guild: Guild,
  picked: GuildBasedChannel | null,
  scope: LockdownScope,
  locale: BotLocale,
): { channels: LockableChannel[]; label: string; categoryId: string | null } | { error: string } {
  if (scope === 'server') {
    const channels = guild.channels.cache.filter((c): c is LockableChannel => isPublicLockable(guild, c));
    return { channels: [...channels.values()], label: m.prot_target_server({}, { locale }), categoryId: null };
  }

  const base = picked?.isThread() ? picked.parent : picked;
  if (!base || base.isThread()) return { error: m.prot_target_unknown({}, { locale }) };

  const categoryId = base.type === ChannelType.GuildCategory
    ? base.id
    : scope === 'category' ? base.parentId : null;

  if (categoryId) {
    const channels = guild.channels.cache.filter(
      (c): c is LockableChannel => c.parentId === categoryId && isPublicLockable(guild, c),
    );
    return { channels: [...channels.values()], label: m.prot_target_category({ category: `<#${categoryId}>` }, { locale }), categoryId };
  }
  if (scope === 'category') return { error: m.prot_target_no_category({}, { locale }) };

  if (!isLockable(base)) return { error: m.prot_target_not_lockable({}, { locale }) };
  return { channels: [base], label: `<#${base.id}>`, categoryId: null };
}

const ts = (date: Date, style: 'f' | 'R') => `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
const yesNo = (value: boolean | undefined) => (value ? '✅' : '❌');

async function execute(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) return;

  const locale = await getEffectiveLocale(interaction);
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  // ── /protection status ──────────────────────────────────────────────────────
  if (!group && sub === 'status') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const config = await getRaidProtectionConfig(guild.id);
    const reportStats = config?.reportsEnabled ? await getReportStats(guild.id) : null;
    const lockedCount = (await listLockedChannelIds(guild.id)).length;

    const on = m.prot_on({}, { locale });
    const off = m.prot_off({}, { locale });
    const until = (date: Date | null | undefined) =>
      date ? m.prot_status_until({ date: ts(date, 'f') }, { locale }) : m.prot_status_permanent({}, { locale });
    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(m.prot_status_title({}, { locale }))
      .addFields(
        {
          name: '🔐 Captcha',
          value: config?.captchaEnabled
            ? m.prot_status_captcha({
              on,
              channel: `<#${config.captchaChannelId}>`,
              minutes: config.captchaTimeoutMinutes,
              attempts: config.captchaMaxAttempts,
              action: config.captchaFailAction,
            }, { locale })
            : off,
        },
        {
          name: '🚨 Anti-raid',
          value: config?.antiRaidEnabled
            ? m.prot_status_antiraid({
              on,
              threshold: config.antiRaidJoinThreshold,
              window: config.antiRaidJoinWindowSec,
              action: config.antiRaidAction,
            }, { locale })
            : off,
        },
        {
          name: '⚡ Raid mode',
          value: config?.raidModeActive
            ? m.prot_status_raidmode_active({
              since: ts(config.raidModeActivatedAt ?? new Date(), 'R'),
              mode: config.raidModeManual ? m.prot_status_mode_manual({}, { locale }) : m.prot_status_mode_auto({}, { locale }),
            }, { locale })
            : m.prot_status_inactive({}, { locale }),
        },
        {
          name: '🔒 Join lock',
          value: config?.joinLockEnabled ? `${on}${until(config.joinLockUntil)}` : off,
        },
        {
          name: '🔒 Lockdown',
          value: lockedCount > 0
            ? m.prot_status_locked_count({ count: lockedCount }, { locale })
            : m.prot_status_no_locked({}, { locale }),
        },
        {
          name: '✉️ DM lock',
          value: config?.dmLockEnabled ? `${on}${until(config.dmLockUntil)}` : off,
        },
        {
          name: m.prot_status_reports_field({}, { locale }),
          value: config?.reportsEnabled
            ? m.prot_status_reports({ on, channel: `<#${config.reportsChannelId}>` }, { locale })
              + (reportStats ? m.prot_status_reports_stats({ pending: reportStats.pending, resolved: reportStats.resolved }, { locale }) : '')
            : off,
        },
        {
          name: '🏷️ Tag role',
          value: config?.tagRoleEnabled ? m.prot_status_tagrole({ on, role: `<@&${config.tagRoleId}>` }, { locale }) : off,
        },
        {
          name: '🎣 Anti-scam',
          value: config?.scamFilterEnabled
            ? m.prot_status_scam({ on, action: config.scamFilterAction }, { locale })
            : off,
        },
        {
          name: '🔍 Kotbo Vision',
          value: config?.visionEnabled === false
            ? off
            : m.prot_status_vision({ on, sanction: config?.visionSanction ?? 'TIMEOUT' }, { locale }),
        },
        {
          name: m.prot_status_invites_field({}, { locale }),
          value: config?.inviteGuardEnabled
            ? on
              + (config.inviteEmergencyEnabled ? m.prot_status_invites_emergency({}, { locale }) : '')
              + m.prot_status_invites({
                single: yesNo(config.inviteRequireUnitary),
                validation: yesNo(config.inviteValidationEnabled),
                threshold: config.inviteSpamThreshold,
                window: config.inviteSpamWindowSec,
              }, { locale })
            : off,
        },
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── lockdown ────────────────────────────────────────────────────────────────
  if (group === 'lockdown') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const scope = (interaction.options.getString('scope') ?? 'channel') as LockdownScope;
    const pickedId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
    const picked = guild.channels.cache.get(pickedId) ?? null;
    const target = resolveLockdownTargets(guild, picked, scope, locale);
    if ('error' in target) {
      await interaction.editReply({ embeds: [errorEmbed(m.prot_lockdown_failed_title({}, { locale }), target.error)] });
      return;
    }

    if (sub === 'on') {
      const reason = interaction.options.getString('reason');
      const silent = interaction.options.getBoolean('silent') ?? false;
      const counts = { locked: 0, already: 0, failed: 0 };
      for (const channel of target.channels) {
        counts[await lockChannel(channel, interaction.user.id, reason)]++;
      }

      // Annonce seulement pour un salon seul, et seulement si non silencieux :
      // sur une catégorie ou un serveur, un message par salon noierait tout le monde.
      const single = !silent && target.channels.length === 1 ? target.channels[0] : null;
      if (single && counts.locked === 1 && single.isSendable()) {
        await single.send({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.warning)
            .setTitle(m.prot_locked_title({}, { locale }))
            .setDescription(reason ? m.prot_locked_reason({ reason }, { locale }) : m.prot_locked_no_reason({}, { locale }))],
        }).catch(() => null);
      }

      const lines = [
        m.prot_lock_done({ count: counts.locked, target: target.label }, { locale }),
        counts.already ? m.prot_lock_already({ count: counts.already }, { locale }) : '',
        counts.failed ? m.prot_lock_failed({ count: counts.failed }, { locale }) : '',
        m.prot_lock_admins_note({}, { locale }),
      ].filter(Boolean);
      await interaction.editReply({ embeds: [successEmbed(m.prot_lock_on_title({}, { locale }), lines.join('\n'))] });
      return;
    }

    const lockedIds = new Set(await listLockedChannelIds(guild.id));
    // Sur une catégorie, tout ce qui y est verrouillé est rouvert, salons privés
    // compris : l'un d'eux a pu être verrouillé seul, explicitement.
    const toUnlock = scope === 'server'
      ? [...lockedIds]
      : target.categoryId
        ? [...lockedIds].filter((id) => guild.channels.cache.get(id)?.parentId === target.categoryId)
        : target.channels.map((c) => c.id).filter((id) => lockedIds.has(id));
    if (toUnlock.length === 0) {
      await interaction.editReply({
        embeds: [errorEmbed(m.prot_unlock_nothing_title({}, { locale }), m.prot_unlock_nothing({ target: target.label }, { locale }))],
      });
      return;
    }

    const silent = interaction.options.getBoolean('silent') ?? false;
    const counts = { unlocked: 0, gone: 0, failed: 0 };
    for (const channelId of toUnlock) {
      counts[await unlockChannel(guild, channelId)]++;
    }

    const single = !silent && toUnlock.length === 1 ? guild.channels.cache.get(toUnlock[0]) : null;
    if (single && counts.unlocked === 1 && single.isSendable()) {
      await single.send({
        embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle(m.prot_unlocked_title({}, { locale }))],
      }).catch(() => null);
    }

    const lines = [
      m.prot_unlock_done({ count: counts.unlocked }, { locale }),
      counts.gone ? m.prot_unlock_gone({ count: counts.gone }, { locale }) : '',
      counts.failed ? m.prot_unlock_failed({ count: counts.failed }, { locale }) : '',
    ].filter(Boolean);
    await interaction.editReply({ embeds: [successEmbed(m.prot_lock_off_title({}, { locale }), lines.join('\n'))] });
    return;
  }

  // ── captcha ─────────────────────────────────────────────────────────────────
  if (group === 'captcha') {
    if (sub === 'enable') {
      const channel = interaction.options.getChannel('channel', true);
      const role = interaction.options.getRole('role', true);
      await upsertRaidProtectionConfig(guild.id, {
        captchaEnabled: true,
        captchaChannelId: channel.id,
        captchaUnverifiedRoleId: role.id,
        captchaTimeoutMinutes: interaction.options.getInteger('timeout') ?? 10,
        captchaMaxAttempts: interaction.options.getInteger('attempts') ?? 3,
        captchaFailAction: interaction.options.getString('penalty') ?? 'KICK',
        captchaLogChannelId: interaction.options.getChannel('log-channel')?.id ?? null,
      });
      await interaction.reply({
        embeds: [successEmbed(
          m.prot_captcha_on_title({}, { locale }),
          m.prot_captcha_on_desc({ role: `${role}`, channel: `${channel}` }, { locale }),
        )],
        flags: [MessageFlags.Ephemeral],
      });
    } else {
      await upsertRaidProtectionConfig(guild.id, { captchaEnabled: false });
      await interaction.reply({ embeds: [successEmbed(m.prot_captcha_off_title({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  // ── antiraid ────────────────────────────────────────────────────────────────
  if (group === 'antiraid') {
    if (sub === 'enable') {
      await upsertRaidProtectionConfig(guild.id, {
        antiRaidEnabled: true,
        antiRaidJoinThreshold: interaction.options.getInteger('threshold') ?? 10,
        antiRaidJoinWindowSec: interaction.options.getInteger('window') ?? 60,
        antiRaidAction: interaction.options.getString('action') ?? 'LOCK',
        antiRaidAlertChannelId: interaction.options.getChannel('alert-channel')?.id ?? null,
        antiRaidAutoDisableMinutes: interaction.options.getInteger('duration') ?? 30,
      });
      const config = await getRaidProtectionConfig(guild.id);
      await interaction.reply({
        embeds: [successEmbed(
          m.prot_antiraid_on_title({}, { locale }),
          m.prot_antiraid_on_desc({
            threshold: String(config?.antiRaidJoinThreshold),
            window: String(config?.antiRaidJoinWindowSec),
            action: String(config?.antiRaidAction),
          }, { locale }),
        )],
        flags: [MessageFlags.Ephemeral],
      });
    } else {
      await upsertRaidProtectionConfig(guild.id, { antiRaidEnabled: false });
      await interaction.reply({ embeds: [successEmbed(m.prot_antiraid_off_title({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  // ── raidmode ────────────────────────────────────────────────────────────────
  if (group === 'raidmode') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const config = await getRaidProtectionConfig(guild.id);
    if (sub === 'on') {
      if (config?.raidModeActive) {
        await interaction.editReply({ embeds: [errorEmbed(m.prot_raidmode_already({}, { locale }))] });
        return;
      }
      const base = config ?? (await upsertRaidProtectionConfig(guild.id, {}));
      await activateRaidMode(guild, base, true, interaction.user.id);
      await interaction.editReply({
        embeds: [successEmbed(m.prot_raidmode_on_title({}, { locale }), m.prot_raidmode_on_desc({ action: base.antiRaidAction }, { locale }))],
      });
    } else {
      if (!config?.raidModeActive) {
        await interaction.editReply({ embeds: [errorEmbed(m.prot_raidmode_not_active({}, { locale }))] });
        return;
      }
      await deactivateRaidMode(guild, config);
      await interaction.editReply({ embeds: [successEmbed(m.prot_raidmode_off_title({}, { locale }))] });
    }
    return;
  }

  // ── joinlock / dmlock ───────────────────────────────────────────────────────
  if (group === 'joinlock' || group === 'dmlock') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const hours = interaction.options.getInteger('duration');
    const until = hours ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
    const isJoin = group === 'joinlock';

    if (sub === 'on') {
      if (isJoin) await enableJoinLock(guild, until);
      else await enableDmLock(guild, until);
      const what = isJoin ? m.prot_joinlock_blocked({}, { locale }) : m.prot_dmlock_blocked({}, { locale });
      const when = until ? m.prot_lock_until({ date: ts(until, 'f') }, { locale }) : m.prot_lock_forever({}, { locale });
      await interaction.editReply({
        embeds: [successEmbed(
          isJoin ? m.prot_joinlock_on_title({}, { locale }) : m.prot_dmlock_on_title({}, { locale }),
          `${what}${when}.`,
        )],
      });
    } else {
      if (isJoin) await disableJoinLock(guild);
      else await disableDmLock(guild);
      await interaction.editReply({
        embeds: [successEmbed(isJoin ? m.prot_joinlock_off_title({}, { locale }) : m.prot_dmlock_off_title({}, { locale }))],
      });
    }
    return;
  }

  // ── reports ─────────────────────────────────────────────────────────────────
  if (group === 'reports') {
    if (sub === 'enable') {
      const channel = interaction.options.getChannel('channel', true);
      await upsertRaidProtectionConfig(guild.id, {
        reportsEnabled: true,
        reportsChannelId: channel.id,
        reportsCooldownSec: interaction.options.getInteger('cooldown') ?? 60,
        reportsAnonymous: interaction.options.getBoolean('anonymous') ?? false,
      });
      await interaction.reply({
        embeds: [successEmbed(m.prot_reports_on_title({}, { locale }), m.prot_reports_on_desc({ channel: `${channel}` }, { locale }))],
        flags: [MessageFlags.Ephemeral],
      });
    } else {
      await upsertRaidProtectionConfig(guild.id, { reportsEnabled: false });
      await interaction.reply({ embeds: [successEmbed(m.prot_reports_off_title({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  // ── tagrole ─────────────────────────────────────────────────────────────────
  if (group === 'tagrole') {
    if (sub === 'enable') {
      const role = interaction.options.getRole('role', true);
      await upsertRaidProtectionConfig(guild.id, { tagRoleEnabled: true, tagRoleId: role.id });
      await interaction.reply({
        embeds: [successEmbed(m.prot_tagrole_on_title({}, { locale }), m.prot_tagrole_on_desc({ role: `${role}` }, { locale }))],
        flags: [MessageFlags.Ephemeral],
      });
    } else if (sub === 'disable') {
      await upsertRaidProtectionConfig(guild.id, { tagRoleEnabled: false });
      await interaction.reply({ embeds: [successEmbed(m.prot_tagrole_off_title({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    } else {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const result = await rescanGuildTagRoles(interaction.client, guild.id);
      if (!result) {
        await interaction.editReply({
          embeds: [errorEmbed(m.prot_tagrole_not_configured_title({}, { locale }), m.prot_tagrole_not_configured_desc({}, { locale }))],
        });
      } else {
        await interaction.editReply({
          embeds: [successEmbed(m.prot_rescan_title({}, { locale }), m.prot_rescan_desc({ added: result.added, removed: result.removed }, { locale }))],
        });
      }
    }
    return;
  }

  // ── jail ────────────────────────────────────────────────────────────────────
  if (group === 'jail') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const me = guild.members.me;
    if (!me?.permissions.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels])) {
      await interaction.editReply({ embeds: [errorEmbed(m.prot_jail_perms_title({}, { locale }), m.prot_jail_perms_desc({}, { locale }))] });
      return;
    }
    const result = await provisionJail(guild, { createChannel: interaction.options.getBoolean('channel') ?? false });
    await interaction.editReply({
      embeds: [
        successEmbed(
          m.prot_jail_ready_title({}, { locale }),
          [
            m.prot_jail_ready_role({ role: `<@&${result.roleId}>`, count: result.channelsUpdated }, { locale }),
            result.channelId
              ? m.prot_jail_ready_channel({ channel: `<#${result.channelId}>` }, { locale })
              : m.prot_jail_ready_no_channel({}, { locale }),
            m.prot_jail_ready_hint({}, { locale }),
          ].join('\n'),
        ),
      ],
    });
    return;
  }

  // ── scam ────────────────────────────────────────────────────────────────────
  if (group === 'scam') {
    if (sub === 'enable') {
      await upsertRaidProtectionConfig(guild.id, {
        scamFilterEnabled: true,
        scamFilterAction: interaction.options.getString('action') ?? 'DELETE_AND_TIMEOUT',
        scamFilterAlertChannelId: interaction.options.getChannel('alert-channel')?.id ?? null,
        visionEnabled: interaction.options.getBoolean('images') ?? true,
      });
      await interaction.reply({
        embeds: [successEmbed(m.prot_scam_on_title({}, { locale }), m.prot_scam_on_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral],
      });
    } else {
      await upsertRaidProtectionConfig(guild.id, { scamFilterEnabled: false });
      await interaction.reply({ embeds: [successEmbed(m.prot_scam_off_title({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    }
    return;
  }

  // ── invites ─────────────────────────────────────────────────────────────────
  if (group === 'invites') {
    if (sub === 'enable') {
      const exemptRole = interaction.options.getRole('exempt-role');
      const current = await getRaidProtectionConfig(guild.id);
      const bypassRoleIds = exemptRole
        ? [...new Set([...(current?.inviteBypassRoleIds ?? []), exemptRole.id])]
        : current?.inviteBypassRoleIds ?? [];

      await upsertRaidProtectionConfig(guild.id, {
        inviteGuardEnabled: true,
        inviteRequireUnitary: interaction.options.getBoolean('single-use') ?? current?.inviteRequireUnitary ?? false,
        inviteValidationEnabled: interaction.options.getBoolean('approval') ?? current?.inviteValidationEnabled ?? false,
        inviteSpamThreshold: interaction.options.getInteger('spam-threshold') ?? current?.inviteSpamThreshold ?? 5,
        inviteSpamWindowSec: interaction.options.getInteger('spam-window') ?? current?.inviteSpamWindowSec ?? 60,
        inviteAlertChannelId: interaction.options.getChannel('alert-channel')?.id ?? current?.inviteAlertChannelId ?? null,
        inviteBypassRoleIds: bypassRoleIds,
      });
      const updated = await getRaidProtectionConfig(guild.id);
      await interaction.reply({
        embeds: [successEmbed(
          m.prot_invites_on_title({}, { locale }),
          m.prot_invites_on_desc({
            single: yesNo(updated?.inviteRequireUnitary),
            validation: yesNo(updated?.inviteValidationEnabled),
            threshold: String(updated?.inviteSpamThreshold),
            window: String(updated?.inviteSpamWindowSec),
            roles: bypassRoleIds.length > 0
              ? bypassRoleIds.map((id) => `<@&${id}>`).join(', ')
              : m.prot_invites_no_exempt({}, { locale }),
          }, { locale }),
        )],
        flags: [MessageFlags.Ephemeral],
      });
    } else if (sub === 'disable') {
      await upsertRaidProtectionConfig(guild.id, { inviteGuardEnabled: false, inviteEmergencyEnabled: false });
      await interaction.reply({ embeds: [successEmbed(m.prot_invites_off_title({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    } else if (sub === 'emergency') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const active = interaction.options.getBoolean('active', true);
      const { enableInviteEmergency, disableInviteEmergency } = await import('../../services/moderation/inviteGuardService.js');
      if (active) {
        const deleted = await enableInviteEmergency(guild);
        await interaction.editReply({
          embeds: [successEmbed(m.prot_emergency_on_title({}, { locale }), m.prot_emergency_on_desc({ count: deleted }, { locale }))],
        });
      } else {
        await disableInviteEmergency(guild);
        await interaction.editReply({
          embeds: [successEmbed(m.prot_emergency_off_title({}, { locale }), m.prot_emergency_off_desc({}, { locale }))],
        });
      }
    }
    return;
  }
}

export const protectionCommand: SlashCommandDefinition = { data, execute };
